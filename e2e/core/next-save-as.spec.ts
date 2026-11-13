import { test as base, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'database password';
const binary = Buffer.from([0, 255, 42, 10, 20, 80]);
const text = (entry: kdbx.KdbxEntry, name: string) => {
    const value = entry.fields.get(name);
    return value instanceof kdbx.ProtectedValue ? value.getText() : value;
};
async function fixture(keyOnly = false) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const key = await kdbx.Credentials.createRandomKeyFile(2);
    const credentials = () => new kdbx.Credentials(keyOnly ? null : kdbx.ProtectedValue.fromString(password), key);
    const db = kdbx.Kdbx.create(credentials(), 'Migration');
    const group = db.createGroup(db.groups[0], 'Nested');
    const entry = db.createEntry(group);
    entry.fields.set('Title', 'Migration record');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('old secret'));
    entry.pushHistory();
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('current secret'));
    entry.fields.set('Recovery', kdbx.ProtectedValue.fromString('recovery secret'));
    entry.fields.set('Notes', 'Original notes');
    entry.tags = ['preserved'];
    entry.binaries.set('proof.bin', await db.createBinary(new Uint8Array(binary).buffer));
    return { key, keyOnly, credentials, entryId: entry.uuid.id, groupId: group.uuid.id, data: Buffer.from(await db.save()) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function decrypt(data: Buffer, f: Fixture) {
    return kdbx.Kdbx.load(new Uint8Array(data).buffer, f.credentials());
}
async function davServer() {
    const files = new Map<string, { data: Buffer; etag: string; modified: string }>();
    const requests: { method: string; path: string; status: number; condition?: string }[] = [];
    let sequence = 0, failWrites = false, exposeEtag = true;
    let nextGate: Promise<void> | undefined, release: (() => void) | undefined;
    const write = (path: string, data: Buffer) => {
        sequence++;
        files.set(path, { data: Buffer.from(data), etag: `"${sequence}"`, modified: new Date(Date.UTC(2026, 10, 13) + sequence * 1000).toUTCString() });
    };
    const server = createServer(async (req, res) => {
        const path = new URL(req.url!, 'http://localhost').pathname;
        const request = { method: req.method!, path, status: 0, condition: (req.headers['if-match'] ?? req.headers['if-none-match']) as string | undefined };
        requests.push(request);
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
        res.setHeader('Access-Control-Allow-Methods', 'HEAD, GET, PUT, MOVE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, If-Match, If-None-Match, Destination, Overwrite');
        res.setHeader('Access-Control-Expose-Headers', exposeEtag ? 'ETag, Last-Modified' : 'Last-Modified');
        res.setHeader('Cache-Control', 'no-store');
        const finish = (status: number, data?: Buffer) => { request.status = status; res.writeHead(status).end(data); };
        if (req.method === 'OPTIONS') { finish(204); return; }
        if (req.headers.authorization !== `Basic ${Buffer.from('alice:dav-password').toString('base64')}`) { finish(401); return; }
        if (req.method === 'PUT') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const gate = nextGate; nextGate = undefined;
            if (gate) await gate;
            if (failWrites) { finish(503); return; }
            const existing = files.get(path);
            if ((req.headers['if-none-match'] === '*' && existing) ||
                (req.headers['if-match'] && req.headers['if-match'] !== existing?.etag)) { finish(412); return; }
            write(path, Buffer.concat(chunks));
            res.setHeader('Last-Modified', files.get(path)!.modified); finish(201); return;
        }
        const file = files.get(path);
        if (!file) { finish(404); return; }
        if (req.method === 'GET' || req.method === 'HEAD') {
            res.setHeader('ETag', file.etag); res.setHeader('Last-Modified', file.modified);
            finish(200, req.method === 'GET' ? file.data : undefined); return;
        }
        if (req.method === 'MOVE') {
            const dest = new URL(req.headers.destination as string).pathname;
            write(dest, file.data); files.delete(path); finish(204); return;
        }
        finish(405);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/saved.kdbx`, files, requests, write,
        fail: (value: boolean) => { failWrites = value; }, etag: (value: boolean) => { exposeEtag = value; },
        hold: () => { nextGate = new Promise<void>(resolve => { release = resolve; }); return () => release?.(); },
        close: async () => { release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    };
}
type Dav = Awaited<ReturnType<typeof davServer>>;
const test = base.extend<{ dav: Dav }>({ dav: async ({}, use) => {
    const dav = await davServer(); try { await use(dav); } finally { await dav.close(); }
} });
test.use({ actionTimeout: 10_000 });
const keyPayload = (f: Fixture) => ({ name: 'required.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(f.key) });
async function unlock(page: Page, f: Fixture) {
    await page.locator('#password').fill(f.keyOnly ? '' : password);
    await page.setInputFiles('#unlock-key-file', keyPayload(f));
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').filter({ hasText: 'Migration record' })).toBeVisible({ timeout: 30_000 });
}
async function open(page: Page, f: Fixture) {
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', { name: 'Migration.kdbx', mimeType: 'application/octet-stream', buffer: f.data });
    await unlock(page, f);
}
async function settings(page: Page, category = 'Database') {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: category, exact: true }).click();
    if (category === 'Database') await page.locator('.database-advanced summary').click();
}
async function dialog(page: Page, dav: Dav) {
    await page.getByRole('button', { name: 'Save to WebDAV', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Save to WebDAV' });
    await modal.getByLabel('WebDAV address', { exact: true }).fill(dav.url);
    await modal.getByLabel('WebDAV username', { exact: true }).fill('alice');
    await modal.getByLabel('WebDAV password', { exact: true }).fill('dav-password');
    return modal;
}
async function localRecord(page: Page) {
    return page.evaluate(() => JSON.parse(localStorage.getItem('fileInfo') || '[]').find((item: { name: string }) => item.name === 'Migration'));
}
async function migration(page: Page, dav: Dav, ready?: () => Promise<void>) {
    const modal = await dialog(page, dav);
    await modal.getByRole('button', { name: 'Check destination' }).click();
    await expect(modal.getByRole('button', { name: 'Save encrypted vault' })).toBeVisible();
    if (ready) await ready();
    await modal.getByRole('button', { name: 'Save encrypted vault' }).click();
    await expect(modal).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText('Saved to WebDAV. Future saves use this connection; your original disk file is unchanged.')).toBeVisible();
}

for (const width of [1280, 320]) test.describe(`save destination at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });
    test('migrates visible drafts with password/key factors, protected fields, history and binary fidelity', async ({ page, browser, dav }, testInfo) => {
        test.setTimeout(120_000);
        const f = await fixture(width === 320);
        await open(page, f); await settings(page);
        await page.getByLabel('Default user', { exact: true }).fill('visible draft user');
        await migration(page, dav, async () => {
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await page.screenshot({ path: testInfo.outputPath(`save-as-confirm-${width}.png`) });
        });
        const record = await localRecord(page);
        expect(record.storage).toBe('webdav'); expect(record.path).toBe(dav.url);
        expect(JSON.stringify(record)).not.toContain('dav-password');
        const bytes = dav.files.get('/saved.kdbx')!.data;
        const reopened = await decrypt(bytes, f);
        expect(reopened.meta.defaultUser).toBe('visible draft user');
        const entry = [...reopened.groups[0].allEntries()].find(entry => entry.uuid.id === f.entryId)!;
        expect(entry.parentGroup!.uuid.id).toBe(f.groupId);
        expect(entry.fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
        expect(text(entry, 'Password')).toBe('current secret');
        expect(text(entry, 'Recovery')).toBe('recovery secret');
        expect(text(entry.history[0], 'Password')).toBe('old secret');
        expect(entry.tags).toEqual(['preserved']);
        const ref = entry.binaries.get('proof.bin') as kdbx.KdbxBinaryWithHash;
        expect(Buffer.from(ref.value as ArrayBuffer)).toEqual(binary);
        await expect(kdbx.Kdbx.load(new Uint8Array(bytes).buffer,
            new kdbx.Credentials(f.keyOnly ? null : kdbx.ProtectedValue.fromString(password)))).rejects.toThrow();
        expect(dav.requests.some(req => req.method === 'PUT' && req.condition === '*' && req.status === 201)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`save-as-${width}.png`) });
        const fresh = await browser.newContext({ viewport: { width, height: 800 } });
        try {
            const second = await fresh.newPage();
            await second.goto(new URL('/next.html', page.url()).href);
            await second.click('#open-webdav');
            await second.fill('#webdav-url', dav.url); await second.fill('#webdav-user', 'alice'); await second.fill('#webdav-pass', 'dav-password');
            await second.click('#webdav-next'); await unlock(second, f);
        } finally { await fresh.close(); }
    });

    test('cancel and destination conflict preserve local identity and remote bytes; explicit retry replaces the inspected revision', async ({ page, dav }) => {
        test.setTimeout(120_000);
        const f = await fixture(); await open(page, f); await settings(page);
        const originalRecord = await localRecord(page);
        const first = Buffer.from('existing remote content'); dav.write('/saved.kdbx', first);
        let modal = await dialog(page, dav);
        await modal.getByRole('button', { name: 'Check destination' }).click();
        await expect(modal.getByRole('button', { name: 'Replace remote vault' })).toBeVisible();
        await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(dav.requests.filter(req => req.method === 'PUT')).toHaveLength(0);
        expect(dav.files.get('/saved.kdbx')!.data).toEqual(first);
        modal = await dialog(page, dav); await modal.getByRole('button', { name: 'Check destination' }).click();
        await expect(modal.getByRole('button', { name: 'Replace remote vault' })).toBeVisible();
        const raced = Buffer.from('changed after confirmation'); dav.write('/saved.kdbx', raced);
        await modal.getByRole('button', { name: 'Replace remote vault' }).click();
        await expect(modal.getByRole('alert')).toContainText('retained');
        expect(dav.requests.some(req => req.method === 'PUT' && req.status === 412)).toBe(true);
        expect(dav.files.get('/saved.kdbx')!.data).toEqual(raced);
        expect((await localRecord(page)).storage).toBe(originalRecord.storage);
        expect((await localRecord(page)).id).toBe(originalRecord.id);
        await modal.getByRole('button', { name: 'Check destination' }).click();
        await modal.getByRole('button', { name: 'Replace remote vault' }).click();
        await expect(modal).toHaveCount(0, { timeout: 30_000 });
        expect(text([...((await decrypt(dav.files.get('/saved.kdbx')!.data, f)).groups[0].allEntries())][0], 'Title')).toBe('Migration record');
    });

    test('authentication and failed uploads never adopt the destination; retry succeeds', async ({ page, dav }) => {
        test.setTimeout(120_000);
        const f = await fixture(); await open(page, f); await settings(page);
        const modal = await dialog(page, dav);
        await modal.getByLabel('WebDAV password', { exact: true }).fill('wrong');
        await modal.getByRole('button', { name: 'Check destination' }).click();
        await expect(modal.getByRole('alert')).toContainText('401');
        expect(dav.requests.filter(req => req.method === 'PUT')).toHaveLength(0);
        await modal.getByLabel('WebDAV password', { exact: true }).fill('dav-password');
        dav.fail(true);
        await modal.getByRole('button', { name: 'Check destination' }).click();
        await modal.getByRole('button', { name: 'Save encrypted vault' }).click();
        await expect(modal.getByRole('alert')).toContainText('503');
        expect((await localRecord(page)).storage).toBeFalsy(); expect(dav.files.size).toBe(0);
        dav.fail(false);
        await modal.getByRole('button', { name: 'Check destination' }).click();
        await modal.getByRole('button', { name: 'Save encrypted vault' }).click();
        await expect(modal).toHaveCount(0, { timeout: 30_000 });
        await decrypt(dav.files.get('/saved.kdbx')!.data, f);
    });
});

test('cancel during upload keeps local recovery even if the server finishes the write', async ({ page, dav }) => {
    test.setTimeout(120_000);
    const f = await fixture(); await open(page, f); await settings(page);
    const release = dav.hold(); const modal = await dialog(page, dav);
    await modal.getByRole('button', { name: 'Check destination' }).click();
    await modal.getByRole('button', { name: 'Save encrypted vault' }).click();
    await expect.poll(() => dav.requests.some(req => req.method === 'PUT' && req.status === 0)).toBe(true);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText(/Save canceled. Your local vault is retained/)).toBeVisible();
    release();
    await expect.poll(() => dav.files.size).toBe(1);
    expect((await localRecord(page)).storage).toBeFalsy();
    await page.reload(); await unlock(page, f);
    expect((await localRecord(page)).storage).toBeFalsy();
});

test('no exposed ETag and invalid credential drafts fail closed', async ({ page, dav }) => {
    const f = await fixture(); await open(page, f); await settings(page);
    dav.write('/saved.kdbx', f.data); dav.etag(false);
    let modal = await dialog(page, dav); await modal.getByRole('button', { name: 'Check destination' }).click();
    await expect(modal.getByRole('alert')).toContainText('strong ETag');
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    // A credential edit must be applied explicitly; a destination action cannot drop a factor.
    await page.getByLabel('New master password', { exact: true }).fill('not applied');
    dav.files.clear(); dav.etag(true);
    modal = await dialog(page, dav); await modal.getByRole('button', { name: 'Check destination' }).click();
    await modal.getByRole('button', { name: 'Save encrypted vault' }).click();
    await expect(modal.getByRole('alert')).toContainText('credential edits');
    expect(dav.requests.filter(req => req.method === 'PUT')).toHaveLength(0);
});

test('save-as waits for a pending attachment read and includes the binary', async ({ page, dav }) => {
    test.setTimeout(120_000);
    const f = await fixture(); await open(page, f);
    await page.locator('.entry-row').filter({ hasText: 'Migration record' }).click();
    let reading = false;
    await page.exposeFunction('attachmentReadEntered', () => { reading = true; });
    await page.evaluate(() => {
        const read = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = async function () {
            File.prototype.arrayBuffer = read;
            await (window as unknown as { attachmentReadEntered(): Promise<void> }).attachmentReadEntered();
            await new Promise<void>(resolve => window.addEventListener('release-attachment-read', () => resolve(), { once: true }));
            return read.call(this);
        };
    });
    await page.getByLabel('Attachment file', { exact: true }).setInputFiles({ name: 'pending.bin', mimeType: 'application/octet-stream', buffer: binary });
    await expect.poll(() => reading).toBe(true);
    await settings(page);
    const modal = await dialog(page, dav); await modal.getByRole('button', { name: 'Check destination' }).click();
    await expect(modal.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(dav.requests).toHaveLength(0);
    await page.evaluate(() => window.dispatchEvent(new Event('release-attachment-read')));
    await modal.getByRole('button', { name: 'Save encrypted vault' }).click();
    await expect(modal).toHaveCount(0, { timeout: 30_000 });
    const entry = [...(await decrypt(dav.files.get('/saved.kdbx')!.data, f)).groups[0].allEntries()][0];
    const saved = entry.binaries.get('pending.bin') as kdbx.KdbxBinaryWithHash;
    expect(Buffer.from(saved.value as ArrayBuffer)).toEqual(binary);
});

test('a newly occupied destination and failed connection persistence retain the local record', async ({ page, dav }) => {
    test.setTimeout(120_000);
    const f = await fixture(); await open(page, f); await settings(page);
    const modal = await dialog(page, dav); await modal.getByRole('button', { name: 'Check destination' }).click();
    await expect(modal.getByRole('button', { name: 'Save encrypted vault' })).toBeVisible();
    const occupied = Buffer.from('another writer won'); dav.write('/saved.kdbx', occupied);
    await modal.getByRole('button', { name: 'Save encrypted vault' }).click();
    await expect(modal.getByRole('alert')).toContainText('retained');
    expect(dav.files.get('/saved.kdbx')!.data).toEqual(occupied);
    expect(dav.requests.some(req => req.method === 'PUT' && req.condition === '*' && req.status === 412)).toBe(true);
    await page.evaluate(() => {
        const storage = window.localStorage;
        Object.defineProperty(window, 'localStorage', { configurable: true, value: new Proxy(storage, {
            get(target, property) { const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value; },
            set(target, property, value) {
                if (property === 'fileInfo' && String(value).includes('"storage":"webdav"')) throw new Error('Injected connection persistence failure');
                return Reflect.set(target, property, value, target);
            }
        }) });
    });
    await modal.getByRole('button', { name: 'Check destination' }).click();
    await modal.getByRole('button', { name: 'Replace remote vault' }).click();
    await expect(modal.getByRole('alert')).toContainText('remote copy was written');
    expect((await localRecord(page)).storage).toBeFalsy();
    await decrypt(dav.files.get('/saved.kdbx')!.data, f);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.reload(); await unlock(page, f);
    expect((await localRecord(page)).storage).toBeFalsy();
});

test('Classic switch waits for an attachment and cancels navigation without dropping the operation', async ({ page, dav }) => {
    test.setTimeout(120_000);
    const f = await fixture(); await open(page, f); await settings(page); await migration(page, dav);
    await page.locator('#settings-back').click();
    await page.locator('.entry-row').filter({ hasText: 'Migration record' }).click();
    let reading = false;
    await page.exposeFunction('attachmentReadEntered', () => { reading = true; });
    await page.evaluate(() => {
        const read = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = async function () {
            File.prototype.arrayBuffer = read;
            await (window as unknown as { attachmentReadEntered(): Promise<void> }).attachmentReadEntered();
            await new Promise<void>(resolve => window.addEventListener('release-attachment-read', () => resolve(), { once: true }));
            return read.call(this);
        };
    });
    await page.getByLabel('Attachment file', { exact: true }).setInputFiles({ name: 'switch.bin', mimeType: 'application/octet-stream', buffer: binary });
    await expect.poll(() => reading).toBe(true);
    await settings(page, 'Appearance'); await page.locator('#use-classic').click();
    const modal = page.getByRole('dialog', { name: 'Switch to Classic' });
    await modal.getByRole('button', { name: 'Save and switch' }).click();
    await expect(modal.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('release-attachment-read')));
    expect(page.url()).toContain('next.html');
    await page.locator('#use-classic').click();
    await page.getByRole('dialog', { name: 'Switch to Classic' }).getByRole('button', { name: 'Save and switch' }).click();
    await expect(page).toHaveURL(/index.html\?ui=classic/, { timeout: 30_000 });
    const entry = [...(await decrypt(dav.files.get('/saved.kdbx')!.data, f)).groups[0].allEntries()][0];
    expect(Buffer.from((entry.binaries.get('switch.bin') as kdbx.KdbxBinaryWithHash).value as ArrayBuffer)).toEqual(binary);
});

test('Classic switch commits a local draft to independently readable encrypted browser storage', async ({ page }) => {
    const f = await fixture(); await open(page, f); await settings(page);
    await page.getByLabel('Default user', { exact: true }).fill('local Classic draft');
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await page.locator('#use-classic').click();
    await page.getByRole('dialog', { name: 'Switch to Classic' }).getByRole('button', { name: 'Save and switch' }).click();
    await expect(page).toHaveURL(/index.html\?ui=classic/, { timeout: 30_000 });
    const bytes = await page.evaluate(async () => {
        const info = JSON.parse(localStorage.getItem('fileInfo') || '[]').find((item: { name: string }) => item.name === 'Migration');
        return new Promise<number[]>((resolve, reject) => {
            const request = indexedDB.open('FilesCache');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const read = db.transaction('files', 'readonly').objectStore('files').get(info.id);
                read.onerror = () => { db.close(); reject(read.error); };
                read.onsuccess = () => { db.close(); resolve(Array.from(new Uint8Array(read.result))); };
            };
        });
    });
    expect((await decrypt(Buffer.from(bytes), f)).meta.defaultUser).toBe('local Classic draft');
});

for (const width of [1280, 320]) test.describe(`Classic switch at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });
    test('cancel preserves drafts; save-and-switch persists them before navigation', async ({ page, dav }) => {
        test.setTimeout(120_000);
        const f = await fixture(); await open(page, f); await settings(page); await migration(page, dav);
        await page.getByLabel('Default user', { exact: true }).fill('before Classic');
        await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
        await page.locator('#use-classic').click();
        let modal = page.getByRole('dialog', { name: 'Switch to Classic' });
        await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.getByRole('tab', { name: 'Database', exact: true }).click();
        await expect(page.getByLabel('Default user', { exact: true })).toHaveValue('before Classic');
        await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
        await page.locator('#use-classic').click(); modal = page.getByRole('dialog', { name: 'Switch to Classic' });
        const release = dav.hold(); await modal.getByRole('button', { name: 'Save and switch' }).click();
        await expect.poll(() => dav.requests.some(req => req.method === 'PUT' && req.status === 0)).toBe(true);
        expect(page.url()).toContain('next.html');
        release();
        await expect(page).toHaveURL(/index.html\?ui=classic/, { timeout: 30_000 });
        expect((await decrypt(dav.files.get('/saved.kdbx')!.data, f)).meta.defaultUser).toBe('before Classic');
        await expect(page.locator('.open')).toBeVisible();
        await page.locator('.open__last-item').filter({ hasText: 'Migration' }).click();
        // Classic can display a remembered filename without holding the key bytes.
        if (await page.locator('.open--key-file').count()) await page.locator('.open__settings-key-file').click();
        const chooser = page.waitForEvent('filechooser');
        await page.locator('.open__settings-key-file').click();
        await (await chooser).setFiles(keyPayload(f));
        await expect(page.locator('.open__settings-key-file-name')).toHaveText('required.keyx');
        await page.locator('.open__pass-input').fill(password);
        await page.locator('.open__pass-enter-btn').click();
        await expect(page.locator('.list__item-title').filter({ hasText: /^Migration record$/ })).toBeVisible({ timeout: 30_000 });
    });
    test('failed remote save blocks Classic navigation and preserves retry', async ({ page, dav }) => {
        test.setTimeout(120_000);
        const f = await fixture(); await open(page, f); await settings(page); await migration(page, dav);
        await page.getByLabel('Default user', { exact: true }).fill('retry Classic');
        await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
        dav.fail(true); await page.locator('#use-classic').click();
        const modal = page.getByRole('dialog', { name: 'Switch to Classic' });
        await modal.getByRole('button', { name: 'Save and switch' }).click();
        await expect(modal.getByRole('alert')).toContainText('Not switched');
        expect(page.url()).toContain('next.html');
        dav.fail(false); await modal.getByRole('button', { name: 'Save and switch' }).click();
        await expect(page).toHaveURL(/index.html\?ui=classic/, { timeout: 30_000 });
        expect((await decrypt(dav.files.get('/saved.kdbx')!.data, f)).meta.defaultUser).toBe('retry Classic');
    });
});
