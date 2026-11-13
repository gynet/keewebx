import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

async function fixture(name: string) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const password = `${name} disposable master password`;
    const key = name === 'B' ? await kdbx.Credentials.createRandomKeyFile(2) : undefined;
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key), name);
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', `${name} entry`);
    entry.fields.set('Notes', `${name} original notes`);
    entry.fields.set('Password', kdbx.ProtectedValue.fromString(`${name} protected secret`));
    entry.pushHistory();
    return { name, password, key, id: entry.uuid.id, root: db.getDefaultGroup().uuid.id, bytes: Buffer.from(await db.save()) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const editor = (page: Page) => page.locator('.entry-editor');
const decision = (page: Page) => page.getByRole('heading', { name: 'Save changes before locking?', exact: true });
const keyPayload = (source: Fixture) => ({ name: 'B.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(source.key!) });
async function unlock(page: Page, source: Fixture) {
    await page.locator('#password').fill(source.password);
    if (source.key) await page.locator('#unlock-key-file').setInputFiles(keyPayload(source));
    await page.locator('#unlock').click();
    await expect(page.locator('#password')).toHaveCount(0);
}
async function pair(page: Page, autoSave = false, idleMinutes = 0) {
    await page.addInitScript(settings => {
        if (!localStorage.getItem('appSettings')) localStorage.setItem('appSettings', JSON.stringify(settings));
    }, { autoSave, autoSaveInterval: 0, idleMinutes });
    const a = await fixture('A'), b = await fixture('B');
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'A.kdbx', mimeType: 'application/octet-stream', buffer: a.bytes });
    await unlock(page, a);
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await page.locator('#open-file-input').setInputFiles({ name: 'B.kdbx', mimeType: 'application/octet-stream', buffer: b.bytes });
    await unlock(page, b);
    return { a, b };
}
async function edit(page: Page, name: string, notes: string, fresh = false) {
    const filter = page.getByRole('combobox', { name: 'Vault filter', exact: true });
    await filter.selectOption((await filter.locator('option').filter({ hasText: `${name}.kdbx` }).getAttribute('value'))!);
    if (fresh) {
        await page.getByRole('button', { name: 'New entry', exact: true }).click();
        await editor(page).getByLabel('Title', { exact: true }).fill('New retained entry');
    } else {
        await page.locator('.entry-row').click();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
    }
    await editor(page).getByLabel('Notes', { exact: true }).fill(notes);
}
async function drafts(page: Page, fresh = false) {
    await edit(page, 'B', 'B applied but unsaved');
    await edit(page, 'A', 'A exact editor draft', fresh);
}
async function suspended(page: Page) {
    await expect(editor(page)).toHaveCount(1);
    await expect(editor(page)).toBeHidden();
    await expect(editor(page).locator('xpath=ancestor::*[@hidden and @inert]')).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveCount(0);
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await page.keyboard.press('Tab');
    expect(await editor(page).evaluate(element => element.contains(document.activeElement))).toBe(false);
}
async function lockChoice(page: Page) {
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(decision(page)).toBeVisible();
    await suspended(page);
}
async function verify(page: Page, source: Fixture) {
    const form = page.getByRole('form', { name: `Verify database: ${source.name}`, exact: true });
    await form.getByLabel('Master password', { exact: true }).fill(source.password);
    if (source.key) await form.getByLabel('Key file', { exact: true }).setInputFiles(keyPayload(source));
    await form.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(form.getByRole('status')).toHaveText('Verified');
}
async function reopenBoth(page: Page, a: Fixture, b: Fixture) {
    await expect(page.locator('.vault-row[data-vault="A"]')).toBeVisible();
    await page.locator('.vault-row[data-vault="A"]').click(); await unlock(page, a);
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await page.locator('.vault-row[data-vault="B"]').click(); await unlock(page, b);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
}
async function downloaded(page: Page, source: Fixture) {
    const pending = page.waitForEvent('download');
    await page.getByRole('form', { name: `Database settings: ${source.name}`, exact: true }).getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const download = await pending, stream = await download.createReadStream();
    expect(await download.failure()).toBeNull();
    if (!stream) throw new Error('Missing encrypted download');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    expect(bytes.includes(Buffer.from(`${source.name} protected secret`))).toBe(false);
    const db = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(source.password), source.key));
    expect(db.getDefaultGroup().uuid.id).toBe(source.root);
    const entry = [...db.getDefaultGroup().allEntries()].find(item => item.uuid.id === source.id)!;
    expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe(`${source.name} protected secret`);
    expect(entry.history.length).toBeGreaterThanOrEqual(1);
    return { db, entry };
}

test('Save and lock explicitly persists new and existing drafts across two vaults', async ({ page }) => {
    const { a, b } = await pair(page); await drafts(page, true); await lockChoice(page);
    await page.getByRole('button', { name: 'Save and lock', exact: true }).click();
    await reopenBoth(page, a, b);
    const savedA = await downloaded(page, a), savedB = await downloaded(page, b);
    const created = [...savedA.db.getDefaultGroup().allEntries()].filter(item => item.fields.get('Title') === 'New retained entry');
    expect(created).toHaveLength(1); expect(created[0].fields.get('Notes')).toBe('A exact editor draft');
    expect(savedB.entry.fields.get('Notes')).toBe('B applied but unsaved');
});

for (const keepAfterDiscard of [false, true]) test(`${keepAfterDiscard ? 'Keep changes after choosing discard' : 'Cancel lock'} requires every vault's current factors and returns exact drafts`, async ({ page }) => {
    const { a, b } = await pair(page); await drafts(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await lockChoice(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('button', { name: keepAfterDiscard ? 'Discard changes…' : 'Cancel lock', exact: true }).click();
    if (keepAfterDiscard) await page.getByRole('button', { name: 'Keep changes', exact: true }).click();
    const back = page.getByRole('button', { name: 'Return to unsaved changes', exact: true });
    await expect(back).toBeDisabled(); await suspended(page);
    const aForm = page.getByRole('form', { name: 'Verify database: A', exact: true });
    await aForm.getByLabel('Master password', { exact: true }).fill(b.password);
    await aForm.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(aForm.getByRole('alert')).toContainText('Verification failed');
    await verify(page, a); await expect(back).toBeDisabled();
    const bForm = page.getByRole('form', { name: 'Verify database: B', exact: true });
    await bForm.getByLabel('Master password', { exact: true }).fill(b.password);
    await bForm.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(bForm.getByRole('alert')).toContainText('Verification failed');
    await verify(page, b); await back.click();
    await expect(editor(page)).toBeVisible();
    await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue('A exact editor draft');
    await page.screenshot({ path: test.info().outputPath('lock-cancel-retained-320.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    expect((await downloaded(page, b)).entry.fields.get('Notes')).toBe('B applied but unsaved');
});

test('verified discard closes both vaults without saving drafts or deleting saved copies', async ({ page }) => {
    const { a, b } = await pair(page); await drafts(page, true); await lockChoice(page);
    await page.getByRole('button', { name: 'Discard changes…', exact: true }).click();
    const discard = page.getByRole('button', { name: 'Discard changes and lock', exact: true });
    await expect(discard).toBeDisabled(); await suspended(page);
    await verify(page, a); await expect(discard).toBeDisabled();
    await verify(page, b); await expect(editor(page)).toBeHidden();
    await discard.click(); await reopenBoth(page, a, b);
    const savedA = await downloaded(page, a), savedB = await downloaded(page, b);
    expect([...savedA.db.getDefaultGroup().allEntries()].some(item => item.fields.get('Title') === 'New retained entry')).toBe(false);
    expect(savedA.entry.fields.get('Notes')).toBe('A original notes');
    expect(savedB.entry.fields.get('Notes')).toBe('B original notes');
});

for (const invalid of [false, true]) test(`${invalid ? 'Invalid draft' : 'Encryption failure'} during Save and lock keeps both vaults and the target editor recoverable`, async ({ page }) => {
    const { a, b } = await pair(page); await drafts(page, true);
    if (invalid) {
        await editor(page).getByRole('button', { name: 'Add field', exact: true }).click();
        await editor(page).getByLabel('Field value', { exact: true }).fill('Retained invalid value');
    } else await page.evaluate(() => {
        const original = crypto.subtle.encrypt.bind(crypto.subtle);
        crypto.subtle.encrypt = (...args) => (typeof args[0] === 'string' ? args[0] : args[0].name) === 'AES-CBC'
            ? Promise.reject(new Error('Synthetic lock encryption failure')) : original(...args);
        (window as any).__restoreLockEncrypt = () => { crypto.subtle.encrypt = original; };
    });
    await lockChoice(page); await page.getByRole('button', { name: 'Save and lock', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Verify to recover editing', exact: true })).toBeVisible();
    await suspended(page); await verify(page, a); await verify(page, b);
    await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
    await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue('A exact editor draft');
    if (invalid) {
        await expect(editor(page).getByLabel('Field value', { exact: true })).toHaveValue('Retained invalid value');
        await editor(page).getByLabel('Field name', { exact: true }).fill('Valid custom field');
    } else await page.evaluate(() => (window as any).__restoreLockEncrypt());
    await editor(page).getByLabel('Notes', { exact: true }).fill('A corrected draft');
    await lockChoice(page); await page.getByRole('button', { name: 'Save and lock', exact: true }).click();
    await reopenBoth(page, a, b);
    const savedA = await downloaded(page, a);
    const created = [...savedA.db.getDefaultGroup().allEntries()].filter(item => item.fields.get('Title') === 'New retained entry');
    expect(created).toHaveLength(1); expect(created[0].fields.get('Notes')).toBe('A corrected draft');
    expect((await downloaded(page, b)).entry.fields.get('Notes')).toBe('B applied but unsaved');
});

test('idle lock hides drafts immediately and keeps Cancel behind current credential verification', async ({ page }) => {
    await page.clock.install();
    const { a, b } = await pair(page, false, 1); await drafts(page);
    await page.clock.fastForward(125_000);
    await expect(decision(page)).toBeVisible(); await suspended(page);
    await page.getByRole('button', { name: 'Cancel lock', exact: true }).click();
    await verify(page, a); await verify(page, b);
    await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
    await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue('A exact editor draft');
    await lockChoice(page); await page.getByRole('button', { name: 'Save and lock', exact: true }).click();
    await reopenBoth(page, a, b);
    expect((await downloaded(page, a)).entry.fields.get('Notes')).toBe('A exact editor draft');
});

test('clean vaults lock directly when automatic saving on lock is off', async ({ page }) => {
    const { a, b } = await pair(page);
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('.vault-row[data-vault="A"]')).toBeVisible();
    await expect(decision(page)).toHaveCount(0);
    await reopenBoth(page, a, b);
    expect((await downloaded(page, a)).entry.fields.get('Notes')).toBe('A original notes');
});

test('automatic saving on lock retains direct save-and-lock behavior', async ({ page }) => {
    const { a, b } = await pair(page, true); await drafts(page);
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('.vault-row[data-vault="A"]')).toBeVisible();
    await expect(decision(page)).toHaveCount(0);
    await reopenBoth(page, a, b);
    expect((await downloaded(page, a)).entry.fields.get('Notes')).toBe('A exact editor draft');
    expect((await downloaded(page, b)).entry.fields.get('Notes')).toBe('B applied but unsaved');
});
