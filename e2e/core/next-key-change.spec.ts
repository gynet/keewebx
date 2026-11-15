import { activateVaultUtility } from './vault-utilities';
import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const oldDate = new Date('2001-01-01T00:00:00Z');
const changedPassword = 'Replacement disposable master password';
const reminder = (page: Page) => page.getByRole('dialog', { name: 'Master key change reminder', exact: true });
const form = (page: Page, name: string) => page.getByRole('form', { name: `Database settings: ${name}`, exact: true });
const payload = (bytes: Uint8Array, name: string) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
async function fixture(name: string, overdue = true, withKey = false) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const password = `${name} disposable master password`;
    const key = withKey ? await kdbx.Credentials.createRandomKeyFile(2) : undefined;
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key), name);
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    db.meta.keyChanged = oldDate;
    db.meta.keyChangeForce = overdue ? 30 : -1;
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', `${name} entry`);
    entry.fields.set('Notes', `${name} original notes`);
    entry.fields.set('Password', kdbx.ProtectedValue.fromString(`${name} secret`));
    return { name, password, key, id: entry.uuid.id, root: db.getDefaultGroup().uuid.id, bytes: Buffer.from(await db.save()) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function start(page: Page, idleMinutes = 0) {
    await page.addInitScript(idleMinutes => localStorage.setItem('appSettings', JSON.stringify({ autoSave: true, autoSaveInterval: 0, idleMinutes })), idleMinutes);
    await page.goto('/next.html');
}
async function unlock(page: Page, source: Fixture, password = source.password) {
    await page.locator('#password').fill(password);
    if (source.key) await page.locator('#unlock-key-file').setInputFiles(payload(source.key, `${source.name}.keyx`));
    await page.locator('#unlock').click();
    await expect(page.locator('#password')).toHaveCount(0);
}
async function open(page: Page, source: Fixture) {
    await page.locator('#open-file-input').setInputFiles(payload(source.bytes, `${source.name}.kdbx`));
    await unlock(page, source);
}
async function settings(page: Page) {
    await activateVaultUtility(page, 'Settings');
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
}
async function exported(page: Page, name: string) {
    const pending = page.waitForEvent('download');
    await form(page, name).getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    const stream = await download.createReadStream();
    if (!stream) throw new Error('Missing encrypted download');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}
async function decrypt(bytes: Buffer, source: Fixture, password = source.password, key = source.key) {
    return kdbx.Kdbx.load(new Uint8Array(bytes).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key));
}
async function save(page: Page, name: string) {
    await form(page, name).getByRole('button', { name: 'Save database settings', exact: true }).click();
    await expect(form(page, name).getByRole('status').filter({ hasText: /Saved in browser storage|Database settings saved\./ })).toBeVisible();
}

test('an encrypted overdue key prompts on open; dismissal preserves data and reopening reminds again', async ({ page }) => {
    const source = await fixture('Overdue', true, true);
    await start(page); await open(page, source);
    await expect(reminder(page)).toContainText('Overdue');
    await page.setViewportSize({ width: 320, height: 568 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('key-reminder-320.png'), fullPage: true });
    await reminder(page).getByRole('button', { name: 'Remind me next time', exact: true }).click();
    await expect(reminder(page)).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await settings(page);
    const db = await decrypt(await exported(page, source.name), source);
    expect(db.meta.keyChanged).toEqual(oldDate);
    expect([...db.getDefaultGroup().allEntries()].find(entry => entry.uuid.id === source.id)?.fields.get('Notes')).toBe('Overdue original notes');
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    await activateVaultUtility(page, 'Lock');
    await page.locator('.vault-row[data-vault="Overdue"]').click(); await unlock(page, source);
    await expect(reminder(page)).toBeVisible();
});

test('review routes to the overdue vault, preserves another draft and rotates only the intended credentials', async ({ page }) => {
    const a = await fixture('A', false), b = await fixture('B', true, true);
    await start(page); await open(page, a);
    await expect(reminder(page)).toHaveCount(0);
    await page.locator('.entry-row').click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('.entry-editor').getByLabel('Notes', { exact: true }).fill('A retained editor draft');
    await activateVaultUtility(page, 'Open another vault'); await open(page, b);
    await reminder(page).getByRole('button', { name: 'Review master key', exact: true }).click();
    const credentials = form(page, 'B').getByRole('region', { name: 'Database credentials', exact: true });
    await expect(credentials.getByLabel('New master password', { exact: true })).toBeFocused();
    await credentials.getByLabel('New master password', { exact: true }).fill(changedPassword);
    await credentials.getByLabel('Confirm new master password', { exact: true }).fill('mismatch');
    await credentials.getByRole('button', { name: 'Apply credential changes', exact: true }).click();
    await expect(credentials.getByRole('status')).toContainText('matching confirmation');
    await credentials.getByRole('button', { name: 'Discard credential edits', exact: true }).click();
    expect((await decrypt(await exported(page, 'B'), b)).meta.keyChanged).toEqual(oldDate);
    await credentials.getByLabel('New master password', { exact: true }).fill(changedPassword);
    await credentials.getByLabel('Confirm new master password', { exact: true }).fill(changedPassword);
    await credentials.getByRole('button', { name: 'Apply credential changes', exact: true }).click();
    await expect(credentials.getByRole('status')).toContainText('Credentials applied in memory');
    await save(page, 'B');
    const bytes = await exported(page, 'B'), db = await decrypt(bytes, b, changedPassword);
    expect(db.meta.keyChanged!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(db.getDefaultGroup().uuid.id).toBe(b.root);
    const entry = [...db.getDefaultGroup().allEntries()].find(entry => entry.uuid.id === b.id)!;
    expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('B secret');
    await expect(decrypt(bytes, b)).rejects.toThrow();
    await expect(kdbx.Kdbx.load(new Uint8Array(bytes).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(changedPassword)))).rejects.toThrow();
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    await expect(page.locator('.entry-editor').getByLabel('Notes', { exact: true })).toHaveValue('A retained editor draft');
    await page.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
    await activateVaultUtility(page, 'Lock');
    await page.locator('.vault-row[data-vault="B"]').click(); await unlock(page, b, changedPassword);
    await expect(page.locator('.entry-row').filter({ hasText: 'B entry' })).toBeVisible();
    await expect(reminder(page)).toHaveCount(0);
});

for (const days of ['', '0', '-1']) test(`deadline ${days || 'blank'} normalizes without a stale draft and remains disabled after encrypted reopen`, async ({ page }) => {
    const source = await fixture('Deadline');
    await start(page); await open(page, source);
    await reminder(page).getByRole('button', { name: 'Review master key', exact: true }).click();
    await form(page, source.name).getByText('Advanced', { exact: true }).click();
    const deadline = form(page, source.name).getByLabel('Ask to change key after days (-1 to disable)', { exact: true });
    await deadline.fill(days); await save(page, source.name); await expect(deadline).toHaveValue('-1');
    await form(page, source.name).getByLabel('Default user', { exact: true }).fill('second save succeeds');
    await save(page, source.name);
    const db = await decrypt(await exported(page, source.name), source);
    expect(db.meta.keyChangeForce).toBe(-1); expect(db.meta.defaultUser).toBe('second save succeeds');
    expect(db.meta.keyChanged).toEqual(oldDate);
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    await activateVaultUtility(page, 'Lock');
    await page.locator('.vault-row[data-vault="Deadline"]').click(); await unlock(page, source);
    await expect(page.locator('.entry-row')).toBeVisible(); await expect(reminder(page)).toHaveCount(0);
});

test('per-vault details distinguish local copies from a failed remote save and retain the remote draft', async ({ page }) => {
    const a = await fixture('Local', false), b = await fixture('Remote', false);
    let fail = false;
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Cache-Control, If-Match, If-None-Match');
        res.setHeader('Access-Control-Expose-Headers', 'ETag, Last-Modified');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (fail) { res.writeHead(503).end(); return; }
        res.setHeader('Last-Modified', 'Thu, 12 Nov 2026 00:00:00 GMT'); res.setHeader('ETag', '"one"');
        res.writeHead(200).end(req.method === 'GET' ? b.bytes : undefined);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/Remote.kdbx?token=disposable-hidden-token`;
    try {
        await start(page); await open(page, a);
        await activateVaultUtility(page, 'Open another vault');
        await page.locator('#open-webdav').click(); await page.locator('#webdav-url').fill(url);
        await page.locator('#webdav-user').fill('disposable-user'); await page.locator('#webdav-pass').fill('disposable-connection-password');
        await page.locator('#webdav-next').click(); await unlock(page, b);
        await settings(page);
        const local = form(page, 'Local').getByRole('region', { name: 'Database details', exact: true });
        const remoteForm = page.getByRole('form', { name: /^Database settings: Remote/ });
        const remote = remoteForm.getByRole('region', { name: 'Database details', exact: true });
        await expect(local).toContainText('Browser downloads do not overwrite the original file automatically');
        await expect(remote).toContainText(url.split('?')[0]);
        await expect(remote).not.toContainText('disposable-hidden-token');
        await expect(remote).not.toContainText('disposable-connection-password');
        fail = true;
        await remoteForm.getByText('Advanced', { exact: true }).click();
        await remoteForm.getByLabel('Default user', { exact: true }).fill('pending remote change');
        await remoteForm.getByRole('button', { name: 'Save database settings', exact: true }).click();
        await expect(remote).toContainText('503');
        await expect(remote).toContainText(/Remote save pending|Save failed/);
        await expect(local).not.toContainText('503');
        await expect(local).toContainText('No pending changes');
        await expect(remoteForm.getByLabel('Default user', { exact: true })).toHaveValue('pending remote change');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('idle lock closes the overdue reminder before returning to unlock', async ({ page }) => {
    await page.clock.install();
    const source = await fixture('Idle deadline');
    await start(page, 1); await open(page, source);
    await expect(reminder(page)).toBeVisible();
    await page.clock.fastForward(125_000);
    await expect(reminder(page)).toHaveCount(0);
    await expect(page.locator('.entry-row')).toHaveCount(0);
    await expect(page.locator('.vault-row[data-vault="Idle deadline"]')).toBeVisible();
    await page.locator('.vault-row[data-vault="Idle deadline"]').click(); await unlock(page, source);
    await expect(reminder(page)).toBeVisible();
});

test('a newly enabled overdue deadline waits for settings to close before offering credential review', async ({ page }) => {
    const source = await fixture('Deferred', false);
    await start(page); await open(page, source); await settings(page);
    await form(page, source.name).getByText('Advanced', { exact: true }).click();
    await form(page, source.name).getByLabel('Ask to change key after days (-1 to disable)', { exact: true }).fill('30');
    await save(page, source.name);
    await expect(reminder(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    await expect(reminder(page)).toBeVisible();
    await reminder(page).getByRole('button', { name: 'Review master key', exact: true }).click();
    await expect(form(page, source.name).getByLabel('New master password', { exact: true })).toBeFocused();
});
