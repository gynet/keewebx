import { activateVaultUtility } from './vault-utilities';
import { test as base, expect, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { deflateSync } from 'node:zlib';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';
const password = 'Icon quality fixture password';
function crc(bytes: Buffer) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) { const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(type, 4); data.copy(result, 8); result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4); return result; }
function png() {
    const header = Buffer.alloc(13); header.writeUInt32BE(256); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 6;
    const rows = Buffer.alloc(128 * (1 + 256 * 4));
    for (let y = 0; y < 128; y++) for (let x = 0; x < 256; x++) { const i = y * 1025 + 1 + x * 4; rows[i] = x; rows[i + 1] = y; rows[i + 2] = 180; rows[i + 3] = 255; }
    return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
interface IconServer { origin: string; calls: string[]; refs: (string | undefined)[]; mode: 'image' | 'missing' | 'hold'; release(): void }
const test = base.extend<{ icons: IconServer }>({
    icons: async ({}, use) => {
        const pending: ServerResponse[] = [];
        const image = (response: ServerResponse) => { response.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' }); response.end(png()); };
        const state: IconServer = { origin: '', calls: [], refs: [], mode: 'image', release() { pending.splice(0).forEach(image); } };
        // Playwright treats every URL ending /favicon.ico as a browser favicon and
        // aborts it before page.route. A real local server exercises the actual URL.
        const server = createServer((request, response) => {
            state.calls.push(request.url!); state.refs.push(request.headers.referer);
            if (state.mode === 'hold') pending.push(response);
            else if (state.mode === 'missing') { response.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); response.end('missing'); }
            else image(response);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        state.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        try { await use(state); } finally { state.release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }
});
async function open(page: Page, icons: IconServer) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Icons');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup()); entry.fields.set('Title', 'Icon entry'); entry.fields.set('URL', icons.origin + '/private/path?token=not-for-request');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('IconProtectedSecret'));
    await page.goto('/next.html'); await page.locator('#open-file-input').setInputFiles({ name: 'icons.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await page.locator('.entry-row[data-entry="Icon entry"]').click();
}
async function settings(page: Page) { await activateVaultUtility(page, 'Settings'); }
async function back(page: Page) { await page.getByRole('button', { name: 'Back to vault', exact: true }).filter({ visible: true }).click(); }
async function exportDb(page: Page) {
    await settings(page); await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const stream = await (await pending).createReadStream(); if (!stream) throw new Error('Missing encrypted output');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const data = Buffer.concat(chunks); expect(data.includes(Buffer.from('IconProtectedSecret'))).toBe(false);
    const db = await kdbx.Kdbx.load(new Uint8Array(data).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
    await back(page); return { db, data };
}
async function dialog(page: Page) {
    await page.getByRole('button', { name: 'Change icon and color', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Entry appearance', exact: true });
    await appearance.getByRole('button', { name: 'Download website icon…', exact: true }).click();
    return appearance;
}
for (const cap of [32, 64, 128]) test(`favicon ${cap}px is explicit, bounded and survives encrypted offline reopen`, async ({ page, icons }) => {
    await page.setViewportSize({ width: cap === 32 ? 320 : 1280, height: 900 });
    await open(page, icons); expect(icons.calls).toHaveLength(0);
    await settings(page); await page.getByRole('combobox', { name: 'Downloaded website icon size', exact: true }).selectOption(String(cap)); await back(page);
    const prompt = await dialog(page); expect(icons.calls).toHaveLength(0);
    await expect(prompt).toContainText(`up to ${cap} pixels`);
    await prompt.getByRole('button', { name: 'Download icon', exact: true }).click();
    await expect(prompt.getByRole('img', { name: 'Website icon preview', exact: true })).toBeVisible();
    await prompt.screenshot({ path: test.info().outputPath(`favicon-${cap}.png`) });
    await prompt.getByRole('button', { name: 'Apply appearance', exact: true }).click();
    const { db, data } = await exportDb(page);
    const entry = [...db.getDefaultGroup().allEntries()][0];
    expect(entry.fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
    expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('IconProtectedSecret');
    expect(entry.customIcon).toBeDefined();
    const icon = Buffer.from(db.meta.customIcons.get(entry.customIcon!.id)!.data!);
    expect(icon.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    expect(icon.readUInt32BE(16)).toBe(cap); expect(icon.readUInt32BE(20)).toBe(cap / 2);
    expect(icons.calls).toEqual(['/favicon.ico']); expect(icons.refs).toEqual([undefined]);
    await page.reload(); await page.context().setOffline(true);
    await page.locator('#open-file-input').setInputFiles({ name: 'offline-icons.kdbx', mimeType: 'application/octet-stream', buffer: data });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row img[src^="data:image/"]').first()).toBeVisible();
    await page.locator('.entry-row[data-entry="Icon entry"]').click();
    await settings(page); await expect(page.getByRole('combobox', { name: 'Downloaded website icon size', exact: true })).toHaveValue(String(cap));
    expect(icons.calls).toEqual(['/favicon.ico']); expect(icons.refs).toEqual([undefined]); await page.context().setOffline(false);
});

test('favicon errors and canceled delayed requests preserve the previous icon', async ({ page, icons }) => {
    await open(page, icons); icons.mode = 'missing';
    let prompt = await dialog(page); await prompt.getByRole('button', { name: 'Download icon', exact: true }).click();
    await expect(prompt.getByRole('alert')).toBeVisible(); await expect(prompt.getByRole('img', { name: 'Website icon preview', exact: true })).toHaveCount(0);
    await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
    icons.mode = 'hold';
    prompt = await dialog(page); await prompt.getByRole('button', { name: 'Download icon', exact: true }).click(); await expect.poll(() => icons.calls.length).toBe(2);
    await prompt.getByRole('button', { name: 'Cancel', exact: true }).click(); icons.release();
    const { db } = await exportDb(page); expect([...db.getDefaultGroup().allEntries()][0].customIcon).toBeUndefined(); expect(db.meta.customIcons.size).toBe(0);
});

test('locking invalidates a pending favicon and prevents a late mutation', async ({ page, icons }) => {
    await open(page, icons); icons.mode = 'hold';
    const prompt = await dialog(page); await prompt.getByRole('button', { name: 'Download icon', exact: true }).click(); await expect.poll(() => icons.calls.length).toBe(1);
    // Invoke the mounted lock control while the modal is open, as an external
    // lock request can arrive during the download. Do not mock session internals.
    await page.locator('#lock').evaluate(button => (button as HTMLButtonElement).click());
    await expect(page.locator('#password')).toBeVisible();
    icons.release(); await page.locator('#password').fill(password); await page.locator('#unlock').click(); await expect(page.locator('.entry-row')).toHaveCount(1);
    const { db } = await exportDb(page); expect(db.meta.customIcons.size).toBe(0);
});
