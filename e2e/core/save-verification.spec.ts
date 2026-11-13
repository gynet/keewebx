import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'Disposable verification fixture';
const original = 'Before verified save';
const edited = 'Recoverable verified change';
const timeout = 30_000;
const warning = (page: Page) => page.getByRole('alert', { name: 'Save verification failed', exact: true });

async function fixture() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'verification');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', original);
    entry.fields.set('Notes', 'Preserve these notes');
    return { name: 'verification.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) };
}
async function open(page: Page, classic = false) {
    await page.goto(classic ? '/index.html?ui=classic' : '/next.html');
    if (classic) {
        const chooser = page.waitForEvent('filechooser');
        await page.locator('#open__icon-open').click();
        await (await chooser).setFiles(await fixture());
        await page.locator('.modal__buttons button[data-result="ok"]').click();
    } else {
        await page.locator('#open-file-input').setInputFiles(await fixture());
    }
    await page.locator(classic ? '.open__pass-input' : '#password').fill(password);
    await page.locator(classic ? '.open__pass-enter-btn' : '#unlock').click();
    await expect(page.locator(classic ? '.list__item' : '.entry-row').first()).toBeVisible({ timeout });
    if (!classic) await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}

// Delay the real browser AES decrypt and inject its failure. No app/model hooks:
// initial unlock has already completed, so the next decrypt is save verification.
async function holdVerification(page: Page) {
    await page.evaluate(() => {
        const decrypt = SubtleCrypto.prototype.decrypt, put = IDBObjectStore.prototype.put;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const state = { entered: false, writes: 0, enabled: true, release,
            restore: () => { state.enabled = false; release(); SubtleCrypto.prototype.decrypt = decrypt; } };
        (window as any).__verificationFault = state;
        SubtleCrypto.prototype.decrypt = async function (...args) {
            const result = await decrypt.apply(this, args);
            const algorithm = typeof args[0] === 'string' ? args[0] : args[0].name;
            if (state.enabled && algorithm === 'AES-CBC') {
                state.entered = true; await gate;
                if (state.enabled) throw new DOMException('Controlled verification failure', 'OperationError');
            }
            return result;
        };
        IDBObjectStore.prototype.put = function (...args) {
            if (args[0] instanceof ArrayBuffer || ArrayBuffer.isView(args[0])) ++state.writes;
            return put.apply(this, args as [any, IDBValidKey]);
        };
    });
}
const held = (page: Page) => expect.poll(() => page.evaluate(() => (window as any).__verificationFault.entered), { timeout }).toBe(true);
const writes = (page: Page) => page.evaluate(() => (window as any).__verificationFault.writes as number);
async function editNew(page: Page) {
    await page.locator('.entry-row').first().click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('.entry-editor');
    await editor.getByLabel('Title', { exact: true }).fill(edited);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
}
async function verifyDownload(page: Page) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('form', { name: /^Database settings:/ }).getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const download = await pending; expect(await download.failure()).toBeNull();
    const stream = await download.createReadStream(); if (!stream) throw new Error('No encrypted download');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const db = await kdbx.Kdbx.load(new Uint8Array(Buffer.concat(chunks)).buffer,
        new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
    const entry = db.getDefaultGroup().entries[0];
    expect(entry.fields.get('Title')).toBe(edited); expect(entry.fields.get('Notes')).toBe('Preserve these notes');
}

test.setTimeout(90_000);
test('New: delayed verification blocks cache/success, warning retries and encrypted copy preserves edits', async ({ page }) => {
    await open(page); await holdVerification(page); await editNew(page); await held(page);
    await expect(page.locator('#sync-state')).not.toHaveText('Up to date');
    expect(await writes(page)).toBe(0);
    await page.evaluate(() => (window as any).__verificationFault.release());
    await expect(warning(page)).toBeVisible({ timeout });
    await expect(warning(page)).toContainText('Keep this tab open.');
    await expect(page.locator('#sync-state')).toHaveText('Sync failed');
    expect(await writes(page)).toBe(0);
    await expect(page.locator('#entry-title')).toHaveText(edited);
    await page.screenshot({ path: test.info().outputPath('new-verification-warning.png'), fullPage: true });
    await page.evaluate(() => (window as any).__verificationFault.restore());
    await warning(page).getByRole('button', { name: 'Retry saving', exact: true }).click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await expect(warning(page)).toHaveCount(0); expect(await writes(page)).toBeGreaterThan(0);
    await verifyDownload(page);
});

test('New: lock waits for delayed verification, failure retains data behind credential recovery', async ({ page }) => {
    await open(page); await holdVerification(page); await editNew(page); await held(page);
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Securing your vaults', exact: true })).toBeVisible();
    expect(await writes(page)).toBe(0);
    await page.evaluate(() => (window as any).__verificationFault.release());
    await expect(page.getByRole('heading', { name: 'Verify to recover editing', exact: true })).toBeVisible({ timeout });
    await expect(warning(page)).toBeVisible();
    await expect(warning(page).getByRole('button', { name: 'Retry saving', exact: true })).toBeDisabled();
    const recovery = page.getByRole('form', { name: 'Verify database: verification', exact: true });
    await recovery.getByLabel('Master password', { exact: true }).fill(password);
    await recovery.getByRole('button', { name: 'Verify', exact: true }).click();
    await page.evaluate(() => (window as any).__verificationFault.restore());
    await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
    await expect(page.locator('#entry-title')).toHaveText(edited);
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await verifyDownload(page);
});

test('New: lock timeout rejects late verified bytes and preserves edits for recovery', async ({ page }) => {
    await open(page); await holdVerification(page); await editNew(page); await held(page);
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Securing your vaults', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Verify to recover editing', exact: true })).toBeVisible({ timeout });
    // Let the original verification succeed only after its session has expired.
    await page.evaluate(() => (window as any).__verificationFault.restore());
    await expect(page.locator('#sync-state')).toHaveText('Sync failed', { timeout });
    expect(await writes(page)).toBe(0);
    const recovery = page.getByRole('form', { name: 'Verify database: verification', exact: true });
    await recovery.getByLabel('Master password', { exact: true }).fill(password);
    await recovery.getByRole('button', { name: 'Verify', exact: true }).click();
    await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
    await expect(page.locator('#entry-title')).toHaveText(edited);
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await verifyDownload(page);
});

for (const failure of ['rejection', 'timeout'] as const) test(`Classic: verification ${failure} retains dirty data and prevents lock closure until successful retry`, async ({ page }) => {
    await open(page, true); await holdVerification(page);
    await page.locator('.list__item').first().click();
    await page.locator('.details__header-title').click();
    await page.locator('.details__header-title-input').fill(edited);
    await page.locator('.details__header-title-input').press('Enter');
    await held(page); expect(await writes(page)).toBe(0);
    await page.locator('#footer__btn-lock').click();
    if (failure === 'rejection') await page.evaluate(() => (window as any).__verificationFault.release());
    await expect(page.locator('.modal')).toContainText('Save verification failed', { timeout: 40_000 });
    await expect(page.locator('.list__item').first()).toBeVisible();
    expect(await writes(page)).toBe(0);
    await page.screenshot({ path: test.info().outputPath('classic-verification-warning.png'), fullPage: true });
    await page.evaluate(() => (window as any).__verificationFault.restore());
    // A timed-out verifier may now finish, but must never publish its old result.
    await expect(page.locator('.footer__db-sign')).toBeVisible();
    expect(await writes(page)).toBe(0);
    await page.locator('.modal__buttons button').first().click();
    await page.locator('#footer__btn-lock').click();
    await expect(page.locator('.open__pass-input')).toBeVisible({ timeout });
    await page.locator('.open__pass-input').fill(password); await page.locator('.open__pass-enter-btn').click();
    await expect(page.locator('.list__item').filter({ hasText: edited })).toBeVisible({ timeout });
});
