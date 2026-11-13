import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';
const password = 'backup-factor-password';
let encrypted: Buffer, key: Buffer, sibling: Buffer;
const panel = (page: Page) => page.getByRole('region', { name: /^Encrypted backups:/ }).first();
async function uploads(request: APIRequestContext) { return (await (await request.get('/backup-control')).json()).uploads as { data: string; options: string; failed: boolean }[]; }
async function stats(page: Page) { return page.evaluate(() => (window as any).backupFixture.stats()); }
async function open(page: Page) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'Backups.kdbx', mimeType: 'application/octet-stream', buffer: encrypted });
    await page.locator('#unlock-key-file').setInputFiles({ name: 'backup.keyx', mimeType: 'application/octet-stream', buffer: key });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row')).toHaveCount(1, { timeout: 30000 });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30000 });
}
async function settings(page: Page) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Database', exact: true }).click();
    await expect(panel(page)).toBeVisible();
}
async function configure(page: Page, schedule = '') {
    await panel(page).getByLabel('Enable backups', { exact: true }).check();
    await panel(page).getByLabel('Backup path', { exact: true }).fill('/copies/Backup.{date}.kdbx');
    await panel(page).getByLabel('Backup schedule', { exact: true }).selectOption(schedule);
    await panel(page).getByRole('button', { name: 'Save backup settings', exact: true }).click();
    await expect(panel(page).getByRole('status')).toHaveText('Backup settings saved on this device.');
}
async function manual(page: Page, accept = true) {
    page.once('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
    await panel(page).getByRole('button', { name: 'Back up now', exact: true }).click();
}
async function saveChange(page: Page, value: string) {
    await page.getByLabel('Vault name', { exact: true }).fill(value);
    await page.getByRole('button', { name: 'Save database settings', exact: true }).click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30000 });
}
async function decrypt(data: string) {
    const bytes = Uint8Array.from(Buffer.from(data, 'base64')).buffer;
    const db = await kdbx.Kdbx.load(bytes, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key));
    const entry = db.groups[0].entries[0];
    expect(entry.fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
    expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('encrypted backup secret');
    expect(entry.history).toHaveLength(1); expect(entry.binaries.has('attachment.txt')).toBe(true);
    return db;
}
test.beforeAll(async () => {
    kdbx.CryptoEngine.setArgon2Impl(argon2); key = Buffer.from(await kdbx.Credentials.createRandomKeyFile(2));
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key), 'Backups');
    const entry = db.createEntry(db.groups[0]); entry.fields.set('Title', 'Backup entry');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('encrypted backup secret'));
    entry.binaries.set('attachment.txt', await db.createBinary(new TextEncoder().encode('backup attachment').buffer));
    entry.pushHistory(); entry.fields.set('Notes', 'latest'); encrypted = Buffer.from(await db.save());
    const other = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key), 'Sibling');
    sibling = Buffer.from(await other.save());
});
test.beforeEach(async ({ request }) => { await request.post('/backup-control', { data: { reset: true } }); });
test.afterEach(async ({ request }) => { await request.post('/backup-control', { data: { release: true } }); });
for (const width of [1280, 320]) test.describe(`${width}px backup`, () => {
    test.use({ viewport: { width, height: 850 } });
    test('manual backup cancels safely, excludes primary credentials, independently decrypts and reopens encrypted bytes', async ({ page, request, browser }) => {
        await open(page); await page.evaluate(() => (window as any).backupFixture.primaryOptions()); await settings(page); await configure(page);
        await manual(page, false); expect(await uploads(request)).toHaveLength(0);
        await page.getByLabel('Vault name', { exact: true }).fill('Unapplied metadata');
        await panel(page).getByRole('button', { name: 'Back up now', exact: true }).click();
        await expect(panel(page).getByRole('status')).toContainText('Apply or discard'); expect(await uploads(request)).toHaveLength(0);
        await saveChange(page, 'Saved backup metadata'); expect(await uploads(request)).toHaveLength(0); // manual first-save regression
        await manual(page); await expect(panel(page).getByRole('status')).toContainText('Encrypted backup completed');
        const sent = await uploads(request); expect(sent).toHaveLength(1); expect(sent[0].options).toBe('null');
        expect((await decrypt(sent[0].data)).meta.name).toBe('Saved backup metadata');
        const state = await stats(page); expect(state.storage).toBeNull(); expect(state.dirty).toBe(false); expect(state.backup.lastTime).toBeGreaterThan(0);
        await page.screenshot({ path: test.info().outputPath('backup-settings.png'), fullPage: true });
        const context = await browser.newContext({ viewport: { width, height: 850 } });
        try {
            const fresh = await context.newPage(); await fresh.goto('/next.html');
            await fresh.locator('#open-file-input').setInputFiles({ name: 'Independent.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(sent[0].data, 'base64') });
            await fresh.locator('#password').fill(password); await fresh.locator('#unlock').click();
            await expect(fresh.locator('#unlock-error')).toContainText('Wrong password', { timeout: 30000 });
            await fresh.locator('#unlock-key-file').setInputFiles({ name: 'backup.keyx', mimeType: 'application/octet-stream', buffer: key });
            await fresh.locator('#unlock').click(); await expect(fresh.locator('.entry-row')).toHaveCount(1, { timeout: 30000 });
        } finally { await context.close(); }
    });
    test('scheduled bytes preserve primary save success; failure, retry, daily suppression and reload are truthful', async ({ page, request }) => {
        await open(page); await settings(page); await configure(page, '0');
        await request.post('/backup-control', { data: { fail: true } });
        await saveChange(page, 'Primary saved despite backup failure');
        await expect(panel(page).getByRole('alert')).toContainText('Backup failed');
        let state = await stats(page); expect(state.dirty).toBe(false); expect(state.modified).toBe(false); expect(state.backup.lastTime).toBeUndefined();
        await request.post('/backup-control', { data: { fail: false } });
        await saveChange(page, 'Scheduled encrypted copy');
        await expect.poll(async () => (await stats(page)).backup.lastTime).toBeGreaterThan(0);
        const sent = await uploads(request); expect(sent).toHaveLength(2); expect((await decrypt(sent[1].data)).meta.name).toBe('Scheduled encrypted copy');
        await panel(page).getByLabel('Backup schedule', { exact: true }).selectOption('1d');
        await panel(page).getByRole('button', { name: 'Save backup settings', exact: true }).click();
        await saveChange(page, 'Daily not due'); expect(await uploads(request)).toHaveLength(2);
        await page.getByRole('button', { name: 'Back to vault', exact: true }).click(); await page.keyboard.press('Control+l'); await expect(page.locator('#password')).toBeVisible(); await page.reload();
        await page.locator('#unlock-key-file').setInputFiles({ name: 'backup.keyx', mimeType: 'application/octet-stream', buffer: key });
        await page.locator('#password').fill(password); await page.locator('#unlock').click();
        await expect(page.locator('.entry-row')).toHaveCount(1, { timeout: 30000 }); await settings(page);
        await expect(panel(page).getByLabel('Backup schedule', { exact: true })).toHaveValue('1d');
        expect(await uploads(request)).toHaveLength(2); expect((await stats(page)).backup.pending).toBe(true);
    });
});
test('unsupported configured backup stays visible and cannot claim a provider is available', async ({ page, request }) => {
    await open(page); await page.evaluate(() => (window as any).backupFixture.unsupported()); await settings(page);
    await expect(panel(page)).toContainText('Configured backup provider unavailable: webdav');
    await expect(panel(page).getByLabel('Backup path', { exact: true })).toHaveValue('/preserved-backup.kdbx');
    await expect(panel(page).getByRole('button', { name: 'Back up now', exact: true })).toBeDisabled();
    expect((await stats(page)).backup.lastTime).toBe(42); expect(await uploads(request)).toHaveLength(0);
});
test('canceled pending HTTP write cannot publish a completion or change the primary save', async ({ page, request }) => {
    await open(page); await settings(page); await configure(page);
    await request.post('/backup-control', { data: { hold: true } }); await manual(page);
    await expect.poll(async () => (await uploads(request)).length).toBe(1);
    await panel(page).getByRole('button', { name: 'Cancel backup', exact: true }).click();
    await expect(panel(page).getByRole('status')).toContainText('A remote copy may exist');
    await request.post('/backup-control', { data: { release: true } });
    expect((await stats(page)).backup.lastTime).toBeUndefined(); expect((await stats(page)).dirty).toBe(false);
    await manual(page); await expect(panel(page).getByRole('status')).toContainText('Encrypted backup completed');
});
test('failed preference persistence leaves previous backup configuration intact', async ({ page }) => {
    await open(page); await settings(page);
    await page.evaluate(() => { const original = localStorage; Object.defineProperty(window, 'localStorage', { configurable: true,
        value: new Proxy(original, { set(target, property, value) { if (property === 'fileInfo') throw new Error('Quota'); return Reflect.set(target, property, value); },
            get(target, property) { const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } }) }); });
    await panel(page).getByLabel('Enable backups', { exact: true }).check();
    await panel(page).getByRole('button', { name: 'Save backup settings', exact: true }).click();
    await expect(panel(page).getByRole('status')).toContainText('Quota');
    expect((await stats(page)).backup).toBeNull();
});

test('backup refuses credential drafts in its vault but preserves an unrelated vault draft', async ({ page, request }) => {
    await open(page);
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Open another vault', exact: true });
    await picker.locator('#open-file-input').setInputFiles({ name: 'Sibling.kdbx', mimeType: 'application/octet-stream', buffer: sibling });
    await picker.locator('#unlock-key-file').setInputFiles({ name: 'backup.keyx', mimeType: 'application/octet-stream', buffer: key });
    await picker.locator('#password').fill(password); await picker.locator('#unlock').click(); await expect(picker).toHaveCount(0);
    await settings(page); await configure(page);
    const target = page.getByRole('form', { name: 'Database settings: Backups', exact: true });
    await target.getByLabel('New master password', { exact: true }).fill('unapplied credential');
    await panel(page).getByRole('button', { name: 'Back up now', exact: true }).click();
    await expect(panel(page).getByRole('status')).toContainText('Apply or discard'); expect(await uploads(request)).toHaveLength(0);
    await target.getByRole('button', { name: 'Discard credential edits', exact: true }).click();
    const other = page.getByRole('form', { name: 'Database settings: Sibling', exact: true });
    await other.getByLabel('Vault name', { exact: true }).fill('Sibling unsaved draft');
    await manual(page); await expect(panel(page).getByRole('status')).toContainText('Encrypted backup completed');
    await expect(other.getByLabel('Vault name', { exact: true })).toHaveValue('Sibling unsaved draft');
    expect(await uploads(request)).toHaveLength(1); await decrypt((await uploads(request))[0].data);
});
