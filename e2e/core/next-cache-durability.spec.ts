import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'Disposable cache password';
const name = 'Cache recovery';
const edited = 'Recoverable latest edit';
const timeout = 30_000;
const credentials = () => new kdbx.Credentials(kdbx.ProtectedValue.fromString(password));
async function fixture() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(credentials(), name);
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup()); entry.fields.set('Title', 'Before edit');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Earlier secret')); entry.pushHistory();
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Current secret'));
    entry.fields.set('Notes', kdbx.ProtectedValue.fromString('Protected recovery notes'));
    entry.binaries.set('proof.bin', await db.createBinary(new Uint8Array([0, 127, 200, 255]).buffer));
    return { bytes: Buffer.from(await db.save()), id: entry.uuid.id };
}
async function decrypt(bytes: Buffer) { return kdbx.Kdbx.load(new Uint8Array(bytes).buffer, credentials()); }
async function open(page: Page, bytes: Buffer, ready = true) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: `${name}.kdbx`, mimeType: 'application/octet-stream', buffer: bytes });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout });
    if (ready) await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}
async function edit(page: Page, title = edited) {
    await page.locator('.entry-row').first().click(); await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('.entry-editor'); await editor.getByLabel('Title', { exact: true }).fill(title);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
}
async function settings(page: Page) {
    await page.locator('#open-settings').click();
    await page.getByRole('tab', { name: 'Saving and content', exact: true }).click();
}
async function download(page: Page, vaultName = name) {
    await settings(page); await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('form', { name: `Database settings: ${vaultName}`, exact: true }).getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const file = await pending; expect(await file.failure()).toBeNull();
    const stream = await file.createReadStream(); if (!stream) throw new Error('Missing encrypted download');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    await test.info().attach('recovery.kdbx', { body: bytes, contentType: 'application/octet-stream' });
    await page.locator('#settings-back').click(); return decrypt(bytes);
}
function recoveryContent(db: kdbx.Kdbx, id: string) {
    const entry = db.getDefaultGroup().entries.find(entry => entry.uuid.id === id)!;
    expect(entry.fields.get('Title')).toBe(edited);
    expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('Current secret');
    expect((entry.fields.get('Notes') as kdbx.ProtectedValue).getText()).toBe('Protected recovery notes');
    expect(entry.history.some(old => (old.fields.get('Password') as kdbx.ProtectedValue).getText() === 'Earlier secret')).toBe(true);
    const binary = entry.binaries.get('proof.bin');
    if (!kdbx.KdbxBinaries.isKdbxBinaryWithHash(binary)) throw new Error('Missing proof attachment');
    expect([...new Uint8Array(binary.value as ArrayBuffer)]).toEqual([0, 127, 200, 255]);
}
async function fault(page: Page, mode: 'quota' | 'abort' | 'unavailable' | 'remove-abort') {
    await page.evaluate(mode => {
        const put = IDBObjectStore.prototype.put, remove = IDBObjectStore.prototype.delete, transaction = IDBDatabase.prototype.transaction;
        const state = { hits: 0, restore: () => {
            IDBObjectStore.prototype.put = put; IDBObjectStore.prototype.delete = remove; IDBDatabase.prototype.transaction = transaction;
        } };
        (window as any).cacheFault = state;
        IDBDatabase.prototype.transaction = function (...args) {
            if (mode === 'unavailable' && this.name.endsWith('FilesCache')) {
                ++state.hits; throw new DOMException('Controlled unavailable cache', 'InvalidStateError');
            }
            return transaction.apply(this, args as any);
        };
        IDBObjectStore.prototype.put = function (...args) {
            if (!this.transaction.db.name.endsWith('FilesCache')) return put.apply(this, args as any);
            if (mode === 'quota') { ++state.hits; throw new DOMException('Controlled quota failure', 'QuotaExceededError'); }
            const req = put.apply(this, args as any);
            if (mode === 'abort') {
                const tx = this.transaction;
                req.addEventListener('success', () => { ++state.hits; tx.abort(); });
            }
            return req;
        };
        IDBObjectStore.prototype.delete = function (...args) {
            const req = remove.apply(this, args as any);
            if (mode === 'remove-abort' && this.transaction.db.name.endsWith('FilesCache')) {
                const tx = this.transaction; req.addEventListener('success', () => { ++state.hits; tx.abort(); });
            }
            return req;
        };
    }, mode);
}
async function classicDisable(page: Page) {
    await page.goto('/index.html?ui=classic'); await page.locator('#open__icon-more').click();
    await page.locator('#open__icon-settings').click();
    await page.locator('label[for="settings__general-disable-offline-storage"]').click();
}
async function cacheCount(page: Page) {
    return page.evaluate(async () => {
        const dbs = (await indexedDB.databases()).filter(db => db.name?.endsWith('FilesCache'));
        if (!dbs.length) return 0;
        return new Promise<number>((resolve, reject) => {
            const open = indexedDB.open(dbs[0].name!); open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result, count = db.transaction('files').objectStore('files').count();
                count.onsuccess = () => { db.close(); resolve(count.result); }; count.onerror = () => reject(count.error);
            };
        });
    });
}
async function recover(page: Page, vaultName = name) {
    const form = page.getByRole('form', { name: `Verify database: ${vaultName}`, exact: true });
    await expect(form).toBeVisible({ timeout: 5000 });
    await form.getByLabel('Master password', { exact: true }).fill(password);
    await form.getByRole('button', { name: 'Verify', exact: true }).click();
    await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
}
async function peer(source: Buffer) {
    let rev = Date.UTC(2026, 10, 13), offline = false;
    const files = new Map<string, { bytes: Buffer; rev: number }>([['/cache.kdbx', { bytes: source, rev }]]);
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT, MOVE, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, If-Match, If-None-Match, Destination, Overwrite');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (offline) { res.writeHead(503).end(); return; }
        const path = new URL(req.url!, 'http://fixture').pathname;
        if (req.method === 'PUT') {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            files.set(path, { bytes: Buffer.concat(chunks), rev: rev += 1000 });
        }
        if (req.method === 'MOVE') {
            const file = files.get(path);
            if (!file) { res.writeHead(404).end(); return; }
            files.set(new URL(String(req.headers.destination)).pathname, file); files.delete(path);
            res.writeHead(201).end(); return;
        }
        if (req.method === 'DELETE') { files.delete(path); res.writeHead(204).end(); return; }
        const file = files.get(path);
        if (!file) { res.writeHead(404).end(); return; }
        res.setHeader('Last-Modified', new Date(file.rev).toUTCString()); res.setHeader('ETag', `"${file.rev}"`);
        res.writeHead(200).end(req.method === 'GET' ? file.bytes : undefined);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/cache.kdbx`, offline: (value: boolean) => { offline = value; }, bytes: () => files.get('/cache.kdbx')!.bytes,
        async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function connect(page: Page, url: string) {
    await page.goto('/next.html'); await page.locator('#open-webdav').click();
    await page.locator('#webdav-url').fill(url); await page.locator('#webdav-user').fill('fixture'); await page.locator('#webdav-pass').fill('disposable');
    await page.locator('#webdav-next').click(); await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout }); await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}

test.setTimeout(90_000);
for (const mode of ['quota', 'abort', 'unavailable'] as const) test(`local ${mode}: failed durable save cannot close; encrypted recovery and retry preserve edits`, async ({ page }) => {
    const source = await fixture(); await open(page, source.bytes); await fault(page, mode); await edit(page);
    await expect.poll(() => page.evaluate(() => (window as any).cacheFault.hits), { timeout }).toBeGreaterThan(0);
    await test.info().attach('state-after-cache-fault', { body: await page.locator('#sync-state').innerText(), contentType: 'text/plain' });
    await page.locator('#lock').click(); await recover(page);
    await expect(page.locator('#sync-state')).not.toHaveText('Up to date');
    recoveryContent(await download(page), source.id);
    await page.evaluate(() => (window as any).cacheFault.restore()); await settings(page);
    await page.getByRole('region', { name: 'Saving and content', exact: true }).getByRole('button', { name: 'Save now', exact: true }).click();
    await page.locator('#settings-back').click(); await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await page.locator('#lock').click(); await expect(page.locator('#password')).toBeVisible({ timeout }); await page.reload();
    await page.locator('.vault-row').filter({ has: page.getByText(`${name}.kdbx`, { exact: true }) }).click();
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout }); recoveryContent(await download(page), source.id);
});

test('disabled optional cache still persists a newly imported local vault before lock', async ({ page }) => {
    const source = await fixture(); await classicDisable(page); await open(page, source.bytes);
    await expect.poll(() => cacheCount(page), { timeout: 5000 }).toBe(1);
    await page.locator('#lock').click(); await expect(page.locator('#password')).toBeVisible({ timeout }); await page.reload();
    await page.locator('.vault-row').filter({ has: page.getByText(`${name}.kdbx`, { exact: true }) }).click();
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toContainText('Before edit', { timeout });
});

test('remote disabled cache plus network failure retains unsaved edits and encrypted recovery', async ({ page }) => {
    const source = await fixture(); const dav = await peer(source.bytes);
    try {
        await classicDisable(page); await connect(page, dav.url); expect(await cacheCount(page)).toBe(0);
        dav.offline(true); await edit(page); await expect(page.locator('#sync-state')).toHaveText('Sync failed', { timeout });
        await page.locator('#lock').click(); await recover(page, 'cache'); recoveryContent(await download(page, 'cache'), source.id);
        expect(dav.bytes().equals(source.bytes)).toBe(true); expect(await cacheCount(page)).toBe(0);
    } finally { await dav.close(); }
});

const storageRegion = (page: Page) => page.getByRole('region', { name: 'Browser storage', exact: true });
const toggle = (page: Page) => storageRegion(page).getByRole('checkbox', { name: 'Disable offline cache for remote vaults', exact: true });

test('new storage policy purges eligible remote copies, persists, and keeps local primary storage', async ({ page }) => {
    const source = await fixture(); const dav = await peer(source.bytes);
    try {
        await connect(page, dav.url); await expect.poll(() => cacheCount(page)).toBe(1);
        await settings(page); await toggle(page).check();
        await expect(storageRegion(page).getByRole('status')).toContainText('Eligible cached copies were removed.');
        expect(await cacheCount(page)).toBe(0);
        await open(page, source.bytes); await expect.poll(() => cacheCount(page)).toBe(1);
        await settings(page); await expect(toggle(page)).toBeChecked();
        await expect(storageRegion(page)).toContainText('Local-only vaults still require browser storage');
        await toggle(page).uncheck(); await expect(storageRegion(page).getByRole('status')).toContainText('Remote offline caching is enabled.');
        await page.reload(); await page.locator('.vault-row').filter({ has: page.getByText(`${name}.kdbx`, { exact: true }) }).click();
        await page.locator('#password').fill(password); await page.locator('#unlock').click();
        await expect(page.locator('.entry-row').first()).toBeVisible({ timeout });
        await settings(page); await expect(toggle(page)).not.toBeChecked();
    } finally { await dav.close(); }
});

test('aborted cache removal never claims purge success and can retry', async ({ page }) => {
    const source = await fixture(); const dav = await peer(source.bytes);
    try {
        await connect(page, dav.url); await expect.poll(() => cacheCount(page)).toBe(1);
        await fault(page, 'remove-abort'); await settings(page); await toggle(page).check();
        await expect(storageRegion(page).getByRole('status')).toContainText('Some cached copies could not be removed.');
        expect(await cacheCount(page)).toBe(1); await expect(toggle(page)).toBeChecked();
        await page.evaluate(() => (window as any).cacheFault.restore());
        await storageRegion(page).getByRole('button', { name: 'Retry cache removal', exact: true }).click();
        await expect(storageRegion(page).getByRole('status')).toContainText('Eligible cached copies were removed.');
        expect(await cacheCount(page)).toBe(0);
    } finally { await dav.close(); }
});

test('disabling remote cache keeps the only unsynchronized encrypted copy across lock and reopen', async ({ page }) => {
    const source = await fixture(); const dav = await peer(source.bytes);
    try {
        await connect(page, dav.url); dav.offline(true); await edit(page);
        await expect(page.locator('#sync-state')).toHaveText('Offline, saved on this device', { timeout });
        await settings(page); await toggle(page).check();
        await expect(storageRegion(page).getByRole('status')).toContainText('unsynchronized remote copies are kept');
        expect(await cacheCount(page)).toBe(1); await page.locator('#settings-back').click();
        await page.locator('#lock').click(); await expect(page.locator('#password')).toBeVisible({ timeout }); await page.reload();
        await page.locator('.vault-row').filter({ has: page.getByText('cache.kdbx', { exact: true }) }).click();
        await page.locator('#password').fill(password); await page.locator('#unlock').click();
        await expect(page.locator('.entry-row').first()).toContainText(edited, { timeout });
        recoveryContent(await download(page, 'cache'), source.id);
        expect(dav.bytes().equals(source.bytes)).toBe(true);
    } finally { await dav.close(); }
});

test('unavailable cache at local import retains the only live copy and blocks lock', async ({ page }) => {
    const source = await fixture(); await page.goto('/next.html'); await fault(page, 'unavailable');
    await page.locator('#open-file-input').setInputFiles({ name: `${name}.kdbx`, mimeType: 'application/octet-stream', buffer: source.bytes });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('#sync-state')).toHaveText('Sync failed', { timeout });
    await page.locator('#lock').click(); await recover(page);
    await edit(page); recoveryContent(await download(page), source.id);
});


async function reopenRemote(page: Page) {
    await page.locator('#lock').click(); await expect(page.locator('#password')).toBeVisible({ timeout });
    await page.reload();
    await page.locator('.vault-row').filter({ has: page.getByText('cache.kdbx', { exact: true }) }).click();
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toContainText(edited, { timeout });
}
for (const mode of ['quota', 'abort', 'unavailable'] as const) test(`remote ${mode}: primary save succeeds and stale cache cannot replace it on reopen`, async ({ page }) => {
    const source = await fixture(); const dav = await peer(source.bytes);
    try {
        await connect(page, dav.url); await expect.poll(() => cacheCount(page)).toBe(1);
        await fault(page, mode); await edit(page);
        await expect.poll(() => page.evaluate(() => (window as any).cacheFault.hits), { timeout }).toBeGreaterThan(0);
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        recoveryContent(await decrypt(dav.bytes()), source.id);
        await page.evaluate(() => (window as any).cacheFault.restore());
        await reopenRemote(page); recoveryContent(await download(page, 'cache'), source.id);
    } finally { await dav.close(); }
});

test('remote network and cache failure cannot claim offline durability or close the live copy', async ({ page }) => {
    const source = await fixture(); const dav = await peer(source.bytes);
    try {
        await connect(page, dav.url); await fault(page, 'abort'); dav.offline(true); await edit(page);
        await expect(page.locator('#sync-state')).toHaveText('Sync failed', { timeout });
        await page.locator('#lock').click(); await recover(page, 'cache');
        recoveryContent(await download(page, 'cache'), source.id);
        expect(dav.bytes().equals(source.bytes)).toBe(true);
    } finally { await dav.close(); }
});

test('reenabling cache after remote synchronization never revives the retained older offline copy', async ({ page }) => {
    const source = await fixture(); const dav = await peer(source.bytes);
    try {
        await connect(page, dav.url); dav.offline(true); await edit(page, 'Intermediate offline edit');
        await expect(page.locator('#sync-state')).toHaveText('Offline, saved on this device', { timeout });
        await settings(page); await toggle(page).check();
        await expect(storageRegion(page).getByRole('status')).toContainText('unsynchronized remote copies are kept');
        await page.locator('#settings-back').click();
        dav.offline(false); await edit(page);
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        recoveryContent(await decrypt(dav.bytes()), source.id);
        await settings(page); await toggle(page).uncheck();
        await expect(storageRegion(page).getByRole('status')).toContainText('Remote offline caching is enabled.');
        await page.locator('#settings-back').click();
        await reopenRemote(page); recoveryContent(await download(page, 'cache'), source.id);
    } finally { await dav.close(); }
});

test('failed preference persistence neither applies the policy nor purges cached bytes', async ({ page }) => {
    const source = await fixture(); const dav = await peer(source.bytes);
    try {
        await connect(page, dav.url); await expect.poll(() => cacheCount(page)).toBe(1);
        await settings(page);
        await page.evaluate(() => {
            const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
            (window as any).restoreSettingsStorage = () => Object.defineProperty(window, 'localStorage', descriptor);
            Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
        });
        await toggle(page).click();
        await expect(storageRegion(page).getByRole('status')).toContainText('storage preference could not be applied');
        await expect(toggle(page)).not.toBeChecked(); expect(await cacheCount(page)).toBe(1);
        await page.evaluate(() => (window as any).restoreSettingsStorage());
        await toggle(page).check();
        await expect(storageRegion(page).getByRole('status')).toContainText('Eligible cached copies were removed.');
        expect(await cacheCount(page)).toBe(0);
    } finally { await dav.close(); }
});

test('missing IndexedDB retains imported local data for credential-gated encrypted recovery', async ({ page }) => {
    const source = await fixture();
    await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }));
    await open(page, source.bytes, false);
    await expect(page.locator('#sync-state')).toHaveText('Sync failed', { timeout });
    await page.locator('#lock').click(); await recover(page);
    await edit(page); recoveryContent(await download(page), source.id);
});

test('storage policy remains usable on a narrow screen and retains local primary bytes', async ({ page }) => {
    const source = await fixture(); await open(page, source.bytes); await settings(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await toggle(page).check();
    await expect(storageRegion(page).getByRole('status')).toContainText('Local-only vaults and unsynchronized remote copies are kept.');
    expect(await cacheCount(page)).toBe(1);
    await page.screenshot({ path: test.info().outputPath('storage-mobile.png'), fullPage: true });
    await toggle(page).uncheck();
    await expect(storageRegion(page).getByRole('status')).toContainText('Remote offline caching is enabled.');
});
