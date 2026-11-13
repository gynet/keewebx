import { test as base, expect, type Page, type Browser } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const originalPassword = 'original remote password';
const remotePassword = 'changed by another peer';
const localNotes = 'Unsynchronized local changes — preserve me';
const originalNotes = 'Original protected notes';
const timeout = 30_000;
const all = (db: kdbx.Kdbx) => db.groups.flatMap(group => [...group.allEntries()]);
const field = (entry: kdbx.KdbxEntry, name: string) => {
    const value = entry.fields.get(name); return value instanceof kdbx.ProtectedValue ? value.getText() : value;
};
async function decrypt(bytes: Buffer, password = originalPassword, key?: Uint8Array) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    return kdbx.Kdbx.load(new Uint8Array(bytes).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key?.slice()));
}
async function peer() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(originalPassword)), 'Remote recovery');
    db.header.versionMinor = 1;
    db.meta.keyChanged = new Date(Date.now() - 60_000);
    const entry = db.createEntry(db.groups[0]);
    entry.fields.set('Title', 'Original record');
    entry.fields.set('Notes', kdbx.ProtectedValue.fromString(originalNotes));
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Historical secret')); entry.pushHistory();
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Current secret'));
    const binary = Buffer.from([0, 1, 255, 128, 10, 4]);
    entry.binaries.set('original.bin', await db.createBinary(new Uint8Array(binary).buffer));
    const source = { bytes: Buffer.from(await db.save()), id: entry.uuid.id, binary };
    const files = new Map<string, { bytes: Buffer; rev: number }>();
    let revision = Date.now();
    const put = (path: string, bytes: Buffer) => files.set(path, { bytes: Buffer.from(bytes), rev: revision += 1000 });
    put('/recovery.kdbx', source.bytes);
    const requests: { method: string; path: string }[] = [];
    let held: { entered: boolean; promise: Promise<void>; release: () => void } | undefined;
    const releases: (() => void)[] = [];
    let moveFailure: { status: number; replacement?: Buffer } | undefined;
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT, MOVE, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, Destination, Overwrite, If-Match, If-None-Match');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag'); res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        const path = new URL(req.url!, 'http://localhost').pathname;
        requests.push({ method: req.method!, path });
        if (req.method === 'GET' && held) { const gate = held; held = undefined; gate.entered = true; await gate.promise; }
        if (req.method === 'PUT') {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            put(path, Buffer.concat(chunks)); res.writeHead(201).end(); return;
        }
        const file = files.get(path);
        if (!file) { res.writeHead(404).end(); return; }
        if (req.method === 'GET' || req.method === 'HEAD') {
            res.setHeader('Last-Modified', new Date(file.rev).toUTCString()); res.setHeader('ETag', `"${file.rev}"`);
            res.writeHead(200).end(req.method === 'GET' ? file.bytes : undefined);
        } else if (req.method === 'MOVE') {
            if (moveFailure) {
                const failure = moveFailure; moveFailure = undefined;
                if (failure.replacement) put('/recovery.kdbx', failure.replacement);
                res.writeHead(failure.status).end(); return;
            }
            put(new URL(String(req.headers.destination), 'http://localhost').pathname, file.bytes); files.delete(path); res.writeHead(204).end();
        } else if (req.method === 'DELETE') { files.delete(path); res.writeHead(204).end(); }
        else res.writeHead(405).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        source, requests, bytes: () => files.get('/recovery.kdbx')!.bytes,
        writes: () => requests.filter(req => req.method === 'PUT').length,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/recovery.kdbx`,
        failNextMove(status: number, replacement?: Buffer) { moveFailure = { status, replacement }; },
        holdNextGet() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; });
            held = { entered: false, promise, release }; releases.push(release); return held; },
        async close() { releases.forEach(release => release()); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    };
}
type Dav = Awaited<ReturnType<typeof peer>>;
const test = base.extend<{ dav: Dav }>({ dav: async ({}, use) => { const dav = await peer(); try { await use(dav); } finally { await dav.close(); } } });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Resolve remote master key', exact: true });
const preferences = (page: Page) => page.getByRole('region', { name: 'Saving and content', exact: true });
async function browse(page: Page) {
    const show = page.getByRole('button', { name: 'Show menu', exact: true }); if (await show.isVisible()) await show.click();
    if (!await page.getByRole('navigation', { name: 'Vault', exact: true }).isVisible()) await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
}
async function settings(page: Page) { await browse(page); await page.locator('#open-settings').click(); }
async function back(page: Page) { await page.locator('#settings-back:visible, .settings__phone-back:visible').click(); }
async function collapse(page: Page) { const menu = page.getByRole('button', { name: 'Move menu', exact: true }); if (await menu.isVisible()) await menu.click(); }
async function connect(page: Page, dav: Dav, password = originalPassword, key?: Uint8Array) {
    await page.goto('/next.html'); await page.locator('#open-webdav').click();
    await page.locator('#webdav-url').fill(dav.url); await page.locator('#webdav-user').fill('tester'); await page.locator('#webdav-pass').fill('disposable');
    await page.locator('#webdav-next').click(); await page.locator('#password').fill(password);
    if (key) await page.locator('#unlock-key-file').setInputFiles({ name: 'remote.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(key) });
    await page.locator('#unlock').click(); await expect(page.locator('.entry-row').first()).toBeVisible({ timeout });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await settings(page); await page.locator('#setting-auto-save').selectOption('0'); await page.locator('#setting-auto-lock').selectOption('0');
    await back(page); await collapse(page);
}
async function localEdit(page: Page, apply = true) {
    await page.locator('.entry-row[data-entry="Original record"]').click();
    const notes = page.getByRole('region', { name: 'Notes', exact: true });
    await notes.getByRole('button', { name: 'Edit notes', exact: true }).click(); await notes.getByRole('textbox').fill(localNotes);
    if (apply) await notes.getByRole('button', { name: 'Save', exact: true }).click();
}
async function changeOnOtherPeer(browser: Browser, page: Page, dav: Dav, key?: Uint8Array, password = remotePassword, clockSkew = false) {
    const context = await browser.newContext({ baseURL: page.url(), viewport: { width: 1280, height: 800 } });
    try {
        const other = await context.newPage();
        if (clockSkew) await other.clock.install({ time: new Date(Date.now() - 120_000) });
        await connect(other, dav);
        await other.getByRole('button', { name: 'New entry', exact: true }).click();
        await other.locator('.entry-editor').getByLabel('Title', { exact: true }).fill('Added by remote peer');
        await other.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
        await settings(other);
        const credentials = other.getByRole('region', { name: 'Database credentials', exact: true });
        await credentials.getByLabel('New master password', { exact: true }).fill(password);
        await credentials.getByLabel('Confirm new master password', { exact: true }).fill(password);
        if (key) {
            await credentials.getByRole('combobox', { name: 'Key file action', exact: true }).selectOption('set');
            await credentials.getByLabel('Select key file', { exact: true }).setInputFiles({ name: 'remote.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(key) });
        }
        await credentials.getByRole('button', { name: 'Apply credential changes', exact: true }).click();
        await expect(credentials.getByRole('status')).toContainText('Credentials applied in memory', { timeout });
        await other.getByRole('button', { name: 'Save database settings', exact: true }).click();
        await expect(other.getByRole('form', { name: /^Database settings:/ }).getByRole('status').filter({ hasText: 'Database settings saved.' })).toBeVisible({ timeout });
        await expect(other.locator('#sync-state')).toHaveText('Up to date', { timeout });
    } finally { await context.close(); }
    const remote = await decrypt(dav.bytes(), password, key);
    expect(all(remote).some(entry => field(entry, 'Title') === 'Added by remote peer')).toBe(true);
    return Buffer.from(dav.bytes());
}
async function detect(page: Page) {
    await settings(page); await preferences(page).getByRole('button', { name: 'Save now', exact: true }).click();
    await expect(dialog(page)).toBeVisible({ timeout });
    await expect(dialog(page).getByLabel('Remote master password', { exact: true })).toBeFocused();
}
async function retry(page: Page, password: string, key?: Uint8Array) {
    await dialog(page).getByLabel('Remote master password', { exact: true }).fill(password);
    if (key) {
        await dialog(page).getByRole('combobox', { name: 'Remote key file', exact: true }).selectOption('choose');
        await dialog(page).getByLabel('Choose remote key file', { exact: true }).setInputFiles({ name: 'remote.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(key) });
    }
    await dialog(page).getByRole('button', { name: 'Retry synchronization', exact: true }).click();
}
async function download(page: Page, password = originalPassword, key?: Uint8Array) {
    const waiting = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const file = await waiting; const stream = await file.createReadStream(); if (!stream) throw new Error('No encrypted download');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks); const path = test.info().outputPath(`local-snapshot-${Date.now()}.kdbx`);
    await writeFile(path, bytes); await test.info().attach('local-encrypted-snapshot', { path, contentType: 'application/octet-stream' });
    return decrypt(bytes, password, key);
}
function fidelity(db: kdbx.Kdbx, dav: Dav) {
    const original = all(db).find(entry => entry.uuid.id === dav.source.id)!;
    expect(field(original, 'Notes')).toBe(localNotes);
    expect(original.fields.get('Notes')).toBeInstanceOf(kdbx.ProtectedValue);
    expect(field(original, 'Password')).toBe('Current secret');
    expect(original.history.some(entry => field(entry, 'Password') === 'Historical secret')).toBe(true);
    expect(Buffer.from((original.binaries.get('original.bin') as { value: ArrayBuffer }).value)).toEqual(dav.source.binary);
    expect(all(db).filter(entry => field(entry, 'Title') === 'Added by remote peer')).toHaveLength(1);
    expect(db.deletedObjects).toHaveLength(0);
}

test.describe('New remote master-key recovery', () => {
    test.setTimeout(90_000);
    for (const mobile of [false, true]) test.describe(mobile ? '320px dark password and key' : 'desktop light password', () => {
        test.use({ viewport: mobile ? { width: 320, height: 350 } : { width: 1280, height: 800 }, hasTouch: mobile, colorScheme: mobile ? 'dark' : 'light' });
        test('two peers: cancel and incorrect credentials retain local edits; correct retry merges without losing identity or content', async ({ page, browser, dav }) => {
            await connect(page, dav); await localEdit(page);
            const key = mobile ? await kdbx.Credentials.createRandomKeyFile(2) : undefined;
            const remote = await changeOnOtherPeer(browser, page, dav, key); const writes = dav.writes();
            await detect(page); await page.keyboard.press('Escape');
            await expect(dialog(page)).toHaveCount(0);
            expect(dav.bytes().equals(remote)).toBe(true); expect(dav.writes()).toBe(writes);
            const local = await download(page);
            expect(field(all(local).find(entry => entry.uuid.id === dav.source.id)!, 'Notes')).toBe(localNotes);
            await page.getByRole('button', { name: 'Resolve remote key', exact: true }).click();
            await retry(page, 'incorrect password', key);
            await expect(dialog(page).getByRole('alert')).toContainText('Could not synchronize', { timeout });
            expect(dav.bytes().equals(remote)).toBe(true); expect(dav.writes()).toBe(writes);
            if (key) {
                const wrong = await kdbx.Credentials.createRandomKeyFile(2); await retry(page, remotePassword, wrong);
                await expect(dialog(page).getByRole('alert')).toContainText('Could not synchronize', { timeout });
                expect(dav.writes()).toBe(writes);
            }
            expect(await dialog(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
            await dialog(page).screenshot({ path: test.info().outputPath('remote-key-retry.png') });
            await retry(page, remotePassword, key); await expect(dialog(page)).toHaveCount(0, { timeout });
            await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
            fidelity(await decrypt(dav.bytes(), remotePassword, key), dav);
            await expect(decrypt(dav.bytes(), originalPassword)).rejects.toThrow();
            fidelity(await download(page, remotePassword, key), dav);
            await test.info().attach('merged-remote.kdbx', { body: dav.bytes(), contentType: 'application/octet-stream' });
            const fresh = await browser.newContext({ baseURL: page.url() });
            try { const reopened = await fresh.newPage(); await connect(reopened, dav, remotePassword, key);
                await expect(reopened.locator('.entry-row[data-entry="Added by remote peer"]')).toBeVisible();
                await reopened.locator('.entry-row[data-entry="Original record"]').click();
                await expect(reopened.locator('.entry-notes .notes')).toHaveText(localNotes);
            } finally { await fresh.close(); }
        });
    });
    for (const format of ['XML', 'raw 32-byte']) test(`current password can be reused when the remote peer adds a ${format} key file`, async ({ page, browser, dav }) => {
        await connect(page, dav); await localEdit(page, false);
        const key = format === 'XML' ? await kdbx.Credentials.createRandomKeyFile(2) : new Uint8Array(32).fill(37);
        await changeOnOtherPeer(browser, page, dav, key, originalPassword);
        await detect(page); await retry(page, '', key);
        await expect(dialog(page)).toHaveCount(0, { timeout });
        fidelity(await decrypt(dav.bytes(), originalPassword, key), dav);
        fidelity(await download(page, originalPassword, key), dav);
    });
    test('a clean local vault adopts the remote password and key file metadata', async ({ page, browser, dav }) => {
        await connect(page, dav);
        const key = await kdbx.Credentials.createRandomKeyFile(2);
        await changeOnOtherPeer(browser, page, dav, key);
        await detect(page); await retry(page, remotePassword, key);
        await expect(dialog(page)).toHaveCount(0, { timeout });
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        const local = await download(page, remotePassword, key);
        expect(field(all(local).find(entry => entry.uuid.id === dav.source.id)!, 'Notes')).toBe(originalNotes);
        expect(all(local).some(entry => field(entry, 'Title') === 'Added by remote peer')).toBe(true);
        await expect(page.getByRole('region', { name: 'Database credentials', exact: true })).toContainText('remote.keyx');
    });
    test('a remote peer clock behind this device must not revert its verified new password during a dirty merge', async ({ page, browser, dav }) => {
        await connect(page, dav); await localEdit(page);
        await changeOnOtherPeer(browser, page, dav, undefined, remotePassword, true);
        await detect(page); await retry(page, remotePassword);
        await expect(dialog(page)).toHaveCount(0, { timeout });
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        await test.info().attach('remote-after-skewed-recovery.kdbx', { body: dav.bytes(), contentType: 'application/octet-stream' });
        const [newKey, oldKey] = await Promise.allSettled([decrypt(dav.bytes(), remotePassword), decrypt(dav.bytes(), originalPassword)]);
        await test.info().attach('accepted-credential-results', { body: JSON.stringify({ newPassword: newKey.status, oldPassword: oldKey.status }), contentType: 'application/json' });
        expect(newKey.status, 'Verified remote password must remain valid').toBe('fulfilled');
        expect(oldKey.status, 'Recovery must not restore the obsolete password').toBe('rejected');
        if (newKey.status === 'fulfilled') fidelity(newKey.value, dav);
    });
    for (const failure of [412, 503]) test(`authorized merge survives ${failure} and retries without reopening recovery`, async ({ page, browser, dav }) => {
        await connect(page, dav); await localEdit(page);
        const remote = await changeOnOtherPeer(browser, page, dav);
        await detect(page);
        const boundary = dav.requests.length;
        // The 412 represents a real competing revision published after our merge.
        const competitor = await decrypt(remote, remotePassword);
        competitor.createEntry(competitor.groups[0]).fields.set('Title', 'Concurrent revision');
        const replacement = failure === 412 ? Buffer.from(await competitor.save()) : undefined;
        dav.failNextMove(failure, replacement);
        await retry(page, remotePassword);
        if (failure === 503) {
            await expect(dialog(page).getByRole('alert')).toBeVisible({ timeout });
            expect(dav.bytes().equals(remote)).toBe(true);
            await retry(page, remotePassword);
        }
        await expect(dialog(page)).toHaveCount(0, { timeout });
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        const requests = dav.requests.slice(boundary);
        expect(requests.filter(request => request.method === 'MOVE')).toHaveLength(2);
        if (failure === 412) expect(requests.filter(request => request.method === 'GET')).toHaveLength(2);
        const saved = await decrypt(dav.bytes(), remotePassword);
        fidelity(saved, dav);
        if (failure === 412) expect(all(saved).filter(entry => field(entry, 'Title') === 'Concurrent revision')).toHaveLength(1);
        await expect(decrypt(dav.bytes(), originalPassword)).rejects.toThrow();
        const fresh = await browser.newContext({ baseURL: page.url() });
        try {
            const reopened = await fresh.newPage(); await connect(reopened, dav, remotePassword);
            await expect(reopened.locator('.entry-row[data-entry="Added by remote peer"]')).toBeVisible();
        } finally { await fresh.close(); }
    });
    test('cancel while a remote response is held cannot adopt credentials or write after cancellation', async ({ page, browser, dav }) => {
        await connect(page, dav); await localEdit(page); const remote = await changeOnOtherPeer(browser, page, dav);
        await detect(page); const gate = dav.holdNextGet(); const writes = dav.writes();
        await retry(page, remotePassword); await expect.poll(() => gate.entered, { timeout }).toBe(true);
        await expect(page.locator('#sync-state')).toHaveText('Saving…');
        await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click(); gate.release();
        await expect(page.locator('#sync-state')).not.toHaveText('Saving…', { timeout });
        expect(dav.writes()).toBe(writes); expect(dav.bytes().equals(remote)).toBe(true);
        const db = await download(page);
        expect(field(all(db).find(entry => entry.uuid.id === dav.source.id)!, 'Notes')).toBe(localNotes);
        expect(all(db).some(entry => field(entry, 'Title') === 'Added by remote peer')).toBe(false);
    });
    test('late remote response cannot adopt credentials or write after lock recovery and reauthentication', async ({ page, browser, dav }) => {
        await page.clock.install(); await connect(page, dav);
        await settings(page); await page.locator('#setting-auto-lock').selectOption('5'); await back(page);
        await localEdit(page); const remote = await changeOnOtherPeer(browser, page, dav);
        await detect(page); const gate = dav.holdNextGet(); const writes = dav.writes();
        await retry(page, remotePassword); await expect.poll(() => gate.entered, { timeout }).toBe(true);
        await page.clock.fastForward(6 * 60_000); await expect(dialog(page)).toHaveCount(0);
        await page.clock.fastForward(16_000);
        const form = page.getByRole('form', { name: 'Verify database: recovery', exact: true });
        await expect(form).toBeVisible({ timeout });
        await form.getByLabel('Master password', { exact: true }).fill(originalPassword);
        await form.getByLabel('Master password', { exact: true }).press('Enter');
        await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
        gate.release(); await expect(page.locator('#sync-state')).not.toHaveText('Saving…', { timeout });
        expect(dav.writes()).toBe(writes); expect(dav.bytes().equals(remote)).toBe(true);
        const db = await download(page);
        expect(field(all(db).find(entry => entry.uuid.id === dav.source.id)!, 'Notes')).toBe(localNotes);
        expect(all(db).some(entry => field(entry, 'Title') === 'Added by remote peer')).toBe(false);
        await expect(page.getByRole('status').filter({ hasText: 'synchronized with the remote credentials' })).toHaveCount(0);
    });
});
