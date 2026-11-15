import { test, expect, type Page, type Locator } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';
import { activateVaultUtility } from './vault-utilities';
import { activateEntryAction, revealEntryAction } from '../entry-actions';
import { activateDatabaseAction } from '../database-actions';

const password = 'Disposable workflow safety';
const timeout = 30_000;
const credentials = () => new kdbx.Credentials(kdbx.ProtectedValue.fromString(password));
async function fixture(name: string) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(credentials(), name);
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.groups[0]);
    entry.fields.set('Title', `${name} account`); entry.fields.set('UserName', 'workflow-user');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('protected secret'));
    entry.fields.set('Notes', kdbx.ProtectedValue.fromString('Original protected notes'));
    entry.fields.set('KP2A_URL', 'mailto:user@example.com'); entry.fields.set('KP2A_URL_1', 'ftp://example.com/file');
    entry.fields.set('KP2A_URL_2', 'ftps://example.com/file'); entry.fields.set('KP2A_URL_3', 'javascript:alert(1)');
    entry.pushHistory(); entry.fields.set('URL', 'https://example.com');
    entry.binaries.set('proof.bin', await db.createBinary(new Uint8Array([0, 255, 128, 1]).buffer));
    const sibling = db.createEntry(db.groups[0]); sibling.fields.set('Title', `${name} sibling`);
    return { bytes: Buffer.from(await db.save()), id: entry.uuid.id, name };
}
async function unlock(page: Page, touch: boolean) {
    await page.locator('#password').fill(password); await click(page.locator('#unlock'), touch);
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout });
}
async function upload(page: Page, source: Awaited<ReturnType<typeof fixture>>, touch: boolean) {
    await page.locator('#open-file-input').setInputFiles({ name: `${source.name}.kdbx`, mimeType: 'application/octet-stream', buffer: source.bytes });
    await unlock(page, touch);
}
async function click(control: Locator, touch: boolean) { if (touch) await control.tap(); else await control.click(); }
async function closeDrawer(page: Page) {
    const close = page.getByRole('button', { name: 'Browse vault', exact: true });
    if (await close.isVisible()) await close.tap();
}
async function download(page: Page, name: string, touch: boolean) {
    await activateVaultUtility(page, 'Settings', { touch });
    await click(page.getByRole('tab', { name: 'Database', exact: true }), touch);
    const pending = page.waitForEvent('download');
    await click(page.getByRole('form', { name: `Database settings: ${name}`, exact: true }).getByRole('button', { name: 'Download KDBX', exact: true }), touch);
    const output = await pending; expect(await output.failure()).toBeNull();
    const stream = await output.createReadStream(); if (!stream) throw new Error('Missing encrypted download');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    await test.info().attach(`${name}-encrypted.kdbx`, { body: bytes, contentType: 'application/octet-stream' });
    await click(page.locator('#settings-back:visible, .settings__phone-back:visible'), touch);
    return { bytes, db: await kdbx.Kdbx.load(new Uint8Array(bytes).buffer, credentials()) };
}
function content(db: kdbx.Kdbx, id: string, notes = 'Original protected notes') {
    const entry = [...db.groups[0].allEntries()].find(entry => entry.uuid.id === id)!;
    expect(entry).toBeTruthy();
    expect(entry.fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
    expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('protected secret');
    expect(entry.fields.get('Notes')).toBeInstanceOf(kdbx.ProtectedValue);
    expect((entry.fields.get('Notes') as kdbx.ProtectedValue).getText()).toBe(notes);
    expect(entry.history).toHaveLength(1);
    const proof = entry.binaries.get('proof.bin');
    if (!kdbx.KdbxBinaries.isKdbxBinaryWithHash(proof)) throw new Error('Missing attachment');
    expect(Buffer.from(proof.value as ArrayBuffer)).toEqual(Buffer.from([0, 255, 128, 1]));
    return entry;
}
async function caches(page: Page): Promise<Record<string, number[]>> {
    return page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('FilesCache'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        try { return await new Promise<Record<string, number[]>>((resolve, reject) => {
            const tx = db.transaction('files'), store = tx.objectStore('files'), result: Record<string, number[]> = {};
            const request = store.openCursor(); request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) { result[String(cursor.key)] = Array.from(new Uint8Array(cursor.value)); cursor.continue(); }
            };
            tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error);
        }); } finally { db.close(); }
    });
}
async function readOnly(page: Page, value: boolean, render = true) {
    await page.evaluate(({ value, render }) => {
        type Node = { props?: { model?: unknown; entry?: { file: object }; onEdit?: unknown }; __k?: Node[]; __c?: { forceUpdate(): void } };
        const visit = (node?: Node): Node | undefined => {
            if (node?.props?.model && node.props.entry && node.props.onEdit && node.__c) return node;
            for (const child of node?.__k ?? []) { const found = visit(child); if (found) return found; }
        };
        const node = visit((document.querySelector('#root') as Element & { __k?: Node }).__k);
        if (!node?.props?.entry) throw new Error('Mounted entry detail not found');
        Object.defineProperty(node.props.entry.file, 'readOnly', { value, writable: true, configurable: true });
        if (render) node.__c!.forceUpdate();
    }, { value, render });
}
for (const width of [1280, 320]) test.describe(`Workflow safety at ${width}px`, () => {
    const touch = width === 320;
    test.use({ viewport: { width, height: 740 }, hasTouch: touch });
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => { if (!localStorage.getItem('appSettings')) localStorage.setItem('appSettings', JSON.stringify({ autoSave: false, autoSaveInterval: 0, idleMinutes: 0 })); });
        await page.goto('/next.html');
    });
    test('failed recent removal retains encrypted bytes and the selected vault; cancel and retry affect only its copy', async ({ page }) => {
        const source = await fixture('Remove'), keeper = await fixture('Keep');
        await upload(page, keeper, touch); await activateVaultUtility(page, 'Lock', { touch });
        await upload(page, source, touch); await activateVaultUtility(page, 'Lock', { touch });
        const original = await caches(page); expect(Object.keys(original)).toHaveLength(2);
        await page.evaluate(() => {
            const remove = IDBObjectStore.prototype.delete;
            (window as any).restoreRemoval = () => { IDBObjectStore.prototype.delete = remove; };
            IDBObjectStore.prototype.delete = function (...args) {
                const request = remove.apply(this, args);
                if (this.transaction.db.name === 'FilesCache') { const tx = this.transaction; request.addEventListener('success', () => tx.abort()); }
                return request;
            };
        });
        const remove = page.getByRole('button', { name: 'Remove Remove.kdbx from this browser', exact: true });
        if (touch) await page.locator('.vault-row[data-vault="Remove"]').press('ArrowLeft');
        else await page.locator('.vault-row-wrap').filter({ has: page.locator('[data-vault="Remove"]') }).hover();
        page.once('dialog', dialog => dialog.accept()); await click(remove, touch);
        await expect(page.locator('#open-file-error')).toContainText('could not be removed');
        await expect(page.locator('.vault-row[data-vault="Remove"]')).toHaveCount(1);
        expect(await caches(page)).toEqual(original);
        // The sole copy still opens after the failed delete, with its full encrypted content.
        await unlock(page, touch); content((await download(page, 'Remove', touch)).db, source.id);
        await activateVaultUtility(page, 'Lock', { touch });
        page.once('dialog', dialog => dialog.dismiss());
        if (touch) await page.locator('.vault-row[data-vault="Remove"]').press('ArrowLeft');
        else await page.locator('.vault-row-wrap').filter({ has: page.locator('[data-vault="Remove"]') }).hover();
        await click(remove, touch); expect(await caches(page)).toEqual(original);
        await page.evaluate(() => (window as any).restoreRemoval());
        page.once('dialog', dialog => dialog.accept()); await click(remove, touch);
        await expect(page.locator('.vault-row[data-vault="Remove"]')).toHaveCount(0);
        const remaining = Object.values(await caches(page)); expect(remaining).toHaveLength(1);
        content(await kdbx.Kdbx.load(new Uint8Array(remaining[0]).buffer, credentials()), keeper.id);
        await page.reload(); await click(page.locator('.vault-row[data-vault="Keep"]'), touch); await unlock(page, touch);
        await expect(page.locator('[data-entry="Keep account"]')).toBeVisible();
    });
    test('read-only notes cannot mutate through an already mounted draft; read and encrypted export remain available', async ({ page, browser }) => {
        const source = await fixture('Read only'), other = await fixture('Writable'); await upload(page, source, touch);
        await activateVaultUtility(page, 'Open another vault', { touch }); await upload(page, other, touch);
        await page.getByRole('combobox', { name: 'Vault filter', exact: true }).selectOption({ label: 'All open vaults' });
        await closeDrawer(page);
        await click(page.locator('[data-entry="Read only account"]'), touch);
        await click(page.getByRole('button', { name: 'Edit notes', exact: true }), touch);
        await page.locator('.notes__editor').fill('Must not reach the model');
        await readOnly(page, true, false);
        await click(page.locator('.notes__edit').getByRole('button', { name: 'Save', exact: true }), touch);
        await expect(page.locator('.notes__edit').getByRole('alert')).toContainText('read-only');
        await expect(page.locator('.notes__editor')).toHaveValue('Must not reach the model');
        await click(page.locator('.notes__edit').getByRole('button', { name: 'Cancel', exact: true }), touch);
        await expect(page.getByRole('button', { name: 'Edit notes', exact: true })).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Add attachment', exact: true })).toBeDisabled();
        for (const value of ['mailto:user@example.com', 'ftp://example.com/file', 'ftps://example.com/file']) await expect(page.locator(`.detail a[href="${value}"]`)).toHaveCount(1);
        await expect(page.locator('.detail a[href^="javascript:"]')).toHaveCount(0);
        await activateEntryAction(page, 'Recycle', touch); await expect(page.locator('#entry-title')).toHaveText('Read only account');
        await expect(page.getByRole('dialog', { name: 'Move entry to Trash', exact: true })).toHaveCount(0);
        const exported = await download(page, 'Read only', touch); content(exported.db, source.id);
        const otherExport = await download(page, 'Writable', touch); content(otherExport.db, other.id);
        const fresh = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width, height: 740 }, hasTouch: touch });
        try {
            const next = await fresh.newPage(); await next.goto('/next.html');
            await upload(next, { ...source, bytes: exported.bytes }, touch);
            await click(next.locator('[data-entry="Read only account"]'), touch);
            await expect(next.locator('.entry-notes')).toContainText('Original protected notes');
        } finally { await fresh.close(); }
        await page.screenshot({ path: test.info().outputPath('readonly-retained.png') });
    });
    test('recycling is recoverable, phone cancel is inert, and encrypted reopen retains history and attachments', async ({ page }) => {
        const source = await fixture('Trash'); await upload(page, source, touch);
        await click(page.locator('[data-entry="Trash account"]'), touch);
        await activateEntryAction(page, 'Recycle', touch);
        const dialog = page.getByRole('dialog', { name: 'Move entry to Trash', exact: true });
        if (touch) {
            await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
            await click(dialog.getByRole('button', { name: 'Cancel', exact: true }), true);
            content((await download(page, 'Trash', touch)).db, source.id);
            await activateEntryAction(page, 'Recycle', touch);
            await page.screenshot({ path: test.info().outputPath('phone-recycle-confirmation.png') });
            await click(dialog.getByRole('button', { name: 'Move to Trash', exact: true }), true);
        } else await expect(dialog).toHaveCount(0);
        const saved = await download(page, 'Trash', touch), recycled = content(saved.db, source.id);
        expect(recycled.parentGroup?.uuid.id).toBe(saved.db.meta.recycleBinUuid!.id);
        expect(saved.db.deletedObjects).toHaveLength(0);
        await activateDatabaseAction(page, /^Save Trash/, touch);
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        await activateVaultUtility(page, 'Lock', { touch }); await page.reload();
        await click(page.locator('.vault-row[data-vault="Trash"]'), touch); await unlock(page, touch);
        await expect(page.locator('[data-entry="Trash account"]')).toHaveCount(0);
        await activateVaultUtility(page, 'Trash', { touch }); await closeDrawer(page);
        await click(page.locator('[data-entry="Trash account"]'), touch);
        await expect(await revealEntryAction(page, 'Restore', touch)).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
    test('nonlocal HTTP cannot submit WebDAV credentials; loopback remains available', async ({ page }) => {
        await click(page.locator('#open-webdav'), touch);
        await page.locator('#webdav-user').fill('workflow-user'); await page.locator('#webdav-pass').fill('disposable password');
        const requests: string[] = []; page.on('request', request => { if (request.url().includes('dav.example')) requests.push(request.url()); });
        await page.locator('#webdav-url').fill('http://dav.example/vault.kdbx');
        await expect(page.locator('#webdav-next')).toBeDisabled(); await expect(page.getByRole('alert')).toContainText('Use HTTPS');
        await page.locator('#webdav-url').press('Enter'); expect(requests).toEqual([]);
        await page.locator('#webdav-url').fill('https://user:password@dav.example/vault.kdbx');
        await expect(page.locator('#webdav-next')).toBeDisabled();
        await page.locator('#webdav-url').fill('https://dav.example/vault.kdbx'); await expect(page.locator('#webdav-next')).toBeEnabled();
        await page.locator('#webdav-url').fill('http://127.0.0.1:8111/vault.kdbx'); await click(page.locator('#webdav-next'), touch);
        await expect(page.locator('#password')).toBeVisible();
    });
});

for (const width of [1280, 320]) test.describe(`WebDAV diagnosis at ${width}px`, () => {
    const touch = width === 320;
    test.use({ viewport: { width, height: 740 }, hasTouch: touch });
    test('auth, permission, missing file, service and opaque network failures permit editing and a successful encrypted retry', async ({ page }) => {
        const source = await fixture('Remote retry');
        let response: number | 'network' = 401;
        await page.route('https://dav.example/**', route => response === 'network' ? route.abort('failed')
            : route.fulfill({ status: response, headers: { 'Last-Modified': new Date().toUTCString(), 'Access-Control-Allow-Origin': '*' },
                body: response === 200 ? source.bytes : Buffer.from('controlled error') }));
        await page.goto('/next.html'); await click(page.locator('#open-webdav'), touch);
        for (const [status, message] of [[401, 'sign-in failed'], [403, 'denied access'], [404, 'not found'], [503, 'server is unavailable'], ['network', 'CORS settings']] as const) {
            response = status;
            await page.locator('#webdav-url').fill('https://dav.example/vault.kdbx');
            await page.locator('#webdav-user').fill('synthetic user'); await page.locator('#webdav-pass').fill('synthetic password');
            await click(page.locator('#webdav-next'), touch); await page.locator('#password').fill(password); await click(page.locator('#unlock'), touch);
            await expect(page.locator('#unlock-error')).toContainText(message);
            await expect(page.locator('.entry-row')).toHaveCount(0);
            await click(page.getByRole('button', { name: 'Edit connection', exact: true }), touch);
            await expect(page.locator('#webdav-url')).toHaveValue('https://dav.example/vault.kdbx');
        }
        response = 200; await click(page.locator('#webdav-next'), touch); await unlock(page, touch);
        await click(page.locator('[data-entry="Remote retry account"]'), touch);
        await expect(page.locator('.entry-notes')).toContainText('Original protected notes');
        content((await download(page, 'vault', touch)).db, source.id);
    });
});
