import { test, expect, type Page, type Locator, type Download } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'disposable recovery password';
const originalTitle = 'Recovery original entry';
const draftTitle = 'Retained recovery title';
const draftNotes = 'Retained private notes\nAfter interrupted save';
const timeout = 30_000;
type Mode = 'password' | 'password and key file' | 'key file only';

async function fixture(mode: Mode = 'password') {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const key = mode === 'password' ? undefined : await kdbx.Credentials.createRandomKeyFile(2);
    const secret = mode === 'key file only' ? null : password;
    const db = kdbx.Kdbx.create(new kdbx.Credentials(secret === null ? null : kdbx.ProtectedValue.fromString(secret), key), 'Recovery');
    const entry = db.createEntry(db.groups[0]);
    entry.fields.set('Title', originalTitle);
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Preserve entry secret'));
    entry.fields.set('Notes', 'Original notes');
    return { secret, key, data: Buffer.from(await db.save()) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const keyPayload = (key: Uint8Array) => ({ name: 'recovery.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(key) });

async function unlock(page: Page, source: Fixture) {
    await page.locator('#password').fill(source.secret ?? '');
    if (source.key) {
        await page.locator('#unlock-key-file').setInputFiles(keyPayload(source.key));
        await expect(page.getByRole('button', { name: 'Key file: recovery.keyx', exact: true })).toBeVisible();
    }
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout });
}
async function open(page: Page, source: Fixture, name = 'recovery.kdbx') {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: source.data });
    await unlock(page, source);
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}
async function edit(page: Page) {
    await page.locator('.entry-row').filter({ hasText: originalTitle }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    return page.locator('.entry-editor');
}
async function invalidEntry(page: Page) {
    const editor = await edit(page);
    await editor.getByLabel('Title', { exact: true }).fill(draftTitle);
    await editor.getByRole('button', { name: 'Add field', exact: true }).click();
    await editor.getByLabel('Field name', { exact: true }).fill('Title');
    await editor.getByLabel('Field value', { exact: true }).fill('Retained invalid custom value');
    return editor;
}
async function hiddenOriginal(page: Page, original: Locator) {
    await expect(original).toHaveCount(1);
    await expect(original).toBeHidden();
    await expect(original.locator('xpath=ancestor::*[@inert and @hidden]')).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveCount(0);
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await page.keyboard.press('Tab');
    await page.keyboard.type('Must not reach retained draft');
    expect(await original.evaluate(el => el.contains(document.activeElement))).toBe(false);
}
async function recovery(page: Page) {
    await expect(page.getByRole('heading', { name: 'Verify to recover editing', exact: true })).toBeVisible({ timeout });
    const form = page.getByRole('form', { name: 'Verify database: recovery', exact: true });
    await expect(form).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return to unsaved changes', exact: true })).toBeDisabled();
    return form;
}
async function verify(page: Page, source: Fixture) {
    const form = page.getByRole('form', { name: 'Verify database: recovery', exact: true });
    await form.getByLabel('Master password', { exact: true }).fill(source.secret ?? '');
    if (source.key) await form.getByLabel('Key file', { exact: true }).setInputFiles(keyPayload(source.key));
    await form.getByLabel('Master password', { exact: true }).press('Enter');
    await expect(form.getByRole('status')).toHaveText('Verified');
    const resume = page.getByRole('button', { name: 'Return to unsaved changes', exact: true });
    await expect(resume).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Verify to recover editing', exact: true })).toHaveCount(0);
}

// Delay one browser crypto operation, without replacing application state or APIs.
async function pauseEncryption(page: Page) {
    let entered = false;
    let completed = false;
    await page.exposeFunction('sdetRecoveryEncryptEntered', () => { entered = true; });
    await page.exposeFunction('sdetRecoveryEncryptCompleted', () => { completed = true; });
    await page.evaluate(() => {
        const encrypt = SubtleCrypto.prototype.encrypt;
        SubtleCrypto.prototype.encrypt = async function (...args: Parameters<SubtleCrypto['encrypt']>) {
            SubtleCrypto.prototype.encrypt = encrypt;
            const release = new Promise<void>(resolve => window.addEventListener('sdet-recovery-release', () => resolve(), { once: true }));
            await (window as unknown as { sdetRecoveryEncryptEntered(): Promise<void> }).sdetRecoveryEncryptEntered();
            await release;
            const bytes = await encrypt.apply(this, args);
            await (window as unknown as { sdetRecoveryEncryptCompleted(): Promise<void> }).sdetRecoveryEncryptCompleted();
            return bytes;
        };
    });
    return {
        entered: () => expect.poll(() => entered, { timeout }).toBe(true),
        async release() { await page.evaluate(() => window.dispatchEvent(new Event('sdet-recovery-release'))); },
        completed: () => expect.poll(() => completed, { timeout }).toBe(true)
    };
}

test.describe('New suspended-session recovery', () => {
    test.setTimeout(90_000);

    for (const mode of ['password', 'password and key file', 'key file only'] as const) {
        test(`hides invalid entry drafts and requires current ${mode} before returning`, async ({ page }) => {
            const source = await fixture(mode);
            await open(page, source);
            const editor = await invalidEntry(page);
            await page.locator('#lock').click();
            await hiddenOriginal(page, editor);
            await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(draftTitle);
            const form = await recovery(page);
            const reject = async () => {
                await form.getByLabel('Master password', { exact: true }).press('Enter');
                await expect(form.getByRole('alert')).toContainText('Verification failed');
                await expect(form.getByLabel('Master password', { exact: true })).toBeFocused();
                await expect(page.getByRole('button', { name: 'Return to unsaved changes', exact: true })).toBeDisabled();
                await expect(editor).toBeHidden();
            };
            await form.getByLabel('Master password', { exact: true }).fill('wrong password');
            await reject();
            await form.getByLabel('Master password', { exact: true }).fill(source.secret ?? '');
            if (source.key) {
                await reject(); // A correct password never substitutes for the required key.
                await form.getByLabel('Key file', { exact: true }).setInputFiles(keyPayload(await kdbx.Credentials.createRandomKeyFile(2)));
                await reject();
                await form.getByLabel('Key file', { exact: true }).setInputFiles(keyPayload(source.key));
                await form.getByLabel('Master password', { exact: true }).fill('wrong nonempty password');
                await reject();
            }
            await verify(page, source);
            await expect(editor).toBeVisible();
            await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(draftTitle);
            await expect(editor.getByLabel('Field name', { exact: true })).toHaveValue('Title');
            await expect(editor.getByLabel('Field value', { exact: true })).toHaveValue('Retained invalid custom value');
            await editor.getByLabel('Field name', { exact: true }).fill('Recovered field');
            await editor.getByRole('button', { name: 'Save', exact: true }).click();
            await page.locator('#lock').click();
            await expect(page.locator('#password')).toBeVisible({ timeout });
            await page.reload();
            await unlock(page, source);
            await expect(page.locator('.entry-row').filter({ hasText: draftTitle })).toBeVisible();
        });
    }

    test('idle lock hides an invalid database draft; recovery preserves every rejected value', async ({ page }) => {
        await page.clock.install();
        const source = await fixture();
        await open(page, source);
        await page.locator('#open-settings').click();
        await page.locator('#setting-auto-lock').selectOption('5');
        const form = page.getByRole('form', { name: 'Database settings: recovery', exact: true });
        await form.getByLabel('Vault name', { exact: true }).fill('Retained database name');
        await form.getByText('Advanced', { exact: true }).click();
        await form.getByLabel('Memory, KiB', { exact: true }).fill('8');
        await form.getByLabel('Parallelism', { exact: true }).fill('4');
        await page.clock.fastForward(6 * 60_000);
        const retainedForm = page.getByRole('form', { name: 'Database settings: recovery', exact: true, includeHidden: true });
        await hiddenOriginal(page, retainedForm);
        await expect(form).toHaveCount(0);
        await expect(page.getByRole('textbox', { name: 'Vault name', exact: true })).toHaveCount(0);
        await recovery(page);
        await verify(page, source);
        await expect(form).toBeVisible();
        await expect(form.getByLabel('Vault name', { exact: true })).toHaveValue('Retained database name');
        await expect(form.getByLabel('Memory, KiB', { exact: true })).toHaveValue('8');
        await expect(form.getByLabel('Parallelism', { exact: true })).toHaveValue('4');
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.locator('#open-settings').click();
        await expect(page.getByLabel('Vault name', { exact: true })).toHaveValue('recovery');
    });

    test('long database name remains inside Settings at desktop and 320px short height', async ({ page }, testInfo) => {
        const source = await fixture();
        const name = 'W'.repeat(128);
        await open(page, source, `${name}.kdbx`);
        await page.locator('#open-settings').click();
        const form = page.getByRole('form', { name: `Database settings: ${name}`, exact: true });
        const heading = form.getByRole('heading', { level: 3 });
        await expect(heading).toHaveText(name);
        for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 350 }]) {
            await page.setViewportSize(viewport);
            await heading.scrollIntoViewIfNeeded();
            for (const element of [form, heading, page.locator('.settings')]) {
                expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            }
            const outer = (await form.boundingBox())!;
            const title = (await heading.boundingBox())!;
            expect(title.x).toBeGreaterThanOrEqual(outer.x);
            expect(title.x + title.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
            await page.screenshot({ path: testInfo.outputPath(`long-name-${viewport.width}.png`), fullPage: true });
        }
    });

    for (const alreadySaving of [true, false]) {
        test(`${alreadySaving ? 'existing save' : 'lock-initiated save'} timeout retains notes and late completion cannot close the recovered session`, async ({ page }) => {
            await page.clock.install();
            const source = await fixture();
            await open(page, source);
            const gate = await pauseEncryption(page);
            try {
                if (alreadySaving) {
                    const editor = await edit(page);
                    await editor.getByLabel('Username', { exact: true }).fill('Save before notes draft');
                    await editor.getByRole('button', { name: 'Save', exact: true }).click();
                    await gate.entered();
                } else await page.locator('.entry-row').filter({ hasText: originalTitle }).click();
                const notes = page.getByRole('region', { name: 'Notes', exact: true });
                await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
                await notes.getByRole('textbox', { name: 'Notes', exact: true }).fill(draftNotes);
                await page.locator('#lock').click();
                await expect(page.getByRole('heading', { name: 'Securing your vaults', exact: true })).toBeVisible();
                await hiddenOriginal(page, page.locator('main.detail'));
                await gate.entered();
                await page.clock.fastForward(16_000);
                await recovery(page);
                await verify(page, source);
                const restored = page.getByRole('region', { name: 'Notes', exact: true });
                if (alreadySaving) await expect(restored.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(draftNotes);
                else await expect(restored).toContainText(draftNotes);
                await gate.release();
                await gate.completed();
                await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
                await page.clock.runFor(1000);
                await expect(page.locator('#password')).toHaveCount(0);
                await expect(restored).toBeVisible();
                if (alreadySaving) {
                    await expect(restored.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(draftNotes);
                    await restored.getByRole('button', { name: 'Save', exact: true }).click();
                }
                await page.locator('#lock').click();
                await expect(page.locator('#password')).toBeVisible({ timeout });
                await page.reload();
                await unlock(page, source);
                await page.locator('.entry-row').filter({ hasText: originalTitle }).click();
                await expect(page.getByRole('region', { name: 'Notes', exact: true })).toContainText(draftNotes);
            } finally { await gate.release(); }
        });
    }

    test('an export completing after idle lock cannot deliver a download', async ({ page }) => {
        await page.clock.install();
        const source = await fixture();
        await open(page, source);
        await page.locator('#open-settings').click();
        await page.locator('#setting-auto-lock').selectOption('5');
        const gate = await pauseEncryption(page);
        const downloads: Download[] = [];
        page.on('download', download => downloads.push(download));
        try {
            await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
            await gate.entered();
            await page.clock.fastForward(6 * 60_000);
            await expect(page.locator('#password')).toBeVisible({ timeout });
            await gate.release();
            await gate.completed();
            await page.clock.runFor(1000);
            expect(downloads).toHaveLength(0);
            await expect(page.locator('#password')).toBeVisible();
            await unlock(page, source);
            await expect(page.locator('.entry-row').filter({ hasText: originalTitle })).toBeVisible();
            expect(downloads).toHaveLength(0);
        } finally { await gate.release(); }
    });

    test('attachment hashing completing after timeout and recovery cannot publish abandoned bytes', async ({ page }) => {
        await page.clock.install();
        const source = await fixture();
        await open(page, source);
        await page.locator('.entry-row').filter({ hasText: originalTitle }).click();
        const payload = Buffer.from('Disposable late binary hash must not publish after recovery');
        let entered = false;
        let completed = false;
        await page.exposeFunction('sdetBinaryHashEntered', () => { entered = true; });
        await page.exposeFunction('sdetBinaryHashCompleted', () => { completed = true; });
        await page.evaluate(expected => {
            const digest = SubtleCrypto.prototype.digest;
            SubtleCrypto.prototype.digest = async function (...args: Parameters<SubtleCrypto['digest']>) {
                const data = args[1];
                const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
                if (bytes.length !== expected.length || bytes.some((byte, i) => byte !== expected[i])) return digest.apply(this, args);
                SubtleCrypto.prototype.digest = digest;
                const release = new Promise<void>(resolve => window.addEventListener('sdet-binary-release', () => resolve(), { once: true }));
                await (window as unknown as { sdetBinaryHashEntered(): Promise<void> }).sdetBinaryHashEntered();
                await release;
                const result = await digest.apply(this, args);
                await (window as unknown as { sdetBinaryHashCompleted(): Promise<void> }).sdetBinaryHashCompleted();
                return result;
            };
        }, [...payload]);
        const release = () => page.evaluate(() => window.dispatchEvent(new Event('sdet-binary-release')));
        try {
            await page.getByLabel('Attachment file', { exact: true }).setInputFiles({ name: 'abandoned.bin', mimeType: 'application/octet-stream', buffer: payload });
            await expect.poll(() => entered, { timeout }).toBe(true);
            await page.locator('#lock').click();
            await expect(page.getByRole('heading', { name: 'Securing your vaults', exact: true })).toBeVisible();
            await hiddenOriginal(page, page.locator('main.detail'));
            await page.clock.fastForward(16_000);
            await recovery(page);
            await verify(page, source);
            await release();
            await expect.poll(() => completed, { timeout }).toBe(true);
            await expect(page.getByRole('button', { name: 'Add attachment', exact: true })).toBeEnabled();
            await expect(page.locator('[data-attachment="abandoned.bin"]')).toHaveCount(0);
            await expect(page.locator('#password')).toHaveCount(0);
            await page.locator('#open-settings').click();
            const pending = page.waitForEvent('download');
            await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
            const download = await pending;
            expect(await download.failure()).toBeNull();
            const chunks: Buffer[] = [];
            const stream = await download.createReadStream();
            if (!stream) throw new Error('No encrypted download stream');
            for await (const chunk of stream) chunks.push(Buffer.from(chunk));
            const db = await kdbx.Kdbx.load(new Uint8Array(Buffer.concat(chunks)).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
            expect(db.groups.flatMap(group => [...group.allEntries()]).every(entry => entry.binaries.size === 0)).toBe(true);
            expect(db.binaries.getAll()).toHaveLength(0);
        } finally { await release(); }
    });
});
