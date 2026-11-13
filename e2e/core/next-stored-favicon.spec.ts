import { test as base, expect, type Page } from '@playwright/test';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { open, download, find, png, back, browse, password, timeout } from './presentation-lifecycle-fixture';
interface IconServer { url: string; requests: IncomingHttpHeaders[]; mode: 'png' | '404' | 'mime' | 'size' | 'ico'; bytes: Buffer; cors: boolean; hold: boolean; release(): void; }
const test = base.extend<{ icons: IconServer }>({ icons: async ({ page }, use) => {
    const pending = new Set<ServerResponse>();
    const state: IconServer = { url: '', requests: [], mode: 'png', bytes: await png(page, 'green', 300, 96), cors: true, hold: false, release: () => {} };
    const respond = (response: ServerResponse) => {
        if (response.destroyed) return;
        response.writeHead(state.mode === '404' ? 404 : 200, {
            'content-type': state.mode === 'mime' ? 'text/html' : state.mode === 'ico' ? 'image/x-icon' : 'image/png',
            ...(state.cors ? { 'access-control-allow-origin': '*' } : {})
        });
        response.end(state.mode === 'size' ? Buffer.alloc(1024 * 1024 + 1) : state.mode === 'mime' ? Buffer.from('<script>bad</script>') : state.bytes);
    };
    state.release = () => { state.hold = false; for (const response of pending) respond(response); pending.clear(); };
    const server = createServer((request, response) => { state.requests.push(request.headers); if (state.hold) pending.add(response); else respond(response); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/favicon.ico`;
    try { await use(state); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
} });
async function select(page: Page) { await page.locator('[data-entry="Existing account"]').click(); }
async function dialog(page: Page) {
    await page.getByRole('button', { name: 'Download website icon…', exact: true }).click();
    return page.getByRole('dialog', { name: 'Download website icon', exact: true });
}
function ico(png: Buffer) {
    const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
    header[6] = 64; header[7] = 64; header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
    return Buffer.concat([header, png]);
}
for (const width of [1280, 320]) {
    test(`explicit favicon fetch previews, cancels and stores bounded offline PNG at ${width}px`, async ({ page, icons }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(() => localStorage.setItem('appSettings', JSON.stringify({ showFavicons: false, faviconSize: 64 })));
        const source = await open(page, true, icons.url.replace('/favicon.ico', '/path?private=omitted')); await select(page);
        let modal = await dialog(page); expect(icons.requests).toHaveLength(0);
        await expect(modal.getByText(icons.url, { exact: true })).toBeVisible();
        await modal.getByRole('button', { name: 'Download icon', exact: true }).click();
        await expect(modal.getByRole('img', { name: 'Website icon preview', exact: true })).toBeVisible();
        expect(icons.requests.at(-1)!.referer).toBeUndefined(); expect(icons.requests.at(-1)!.cookie).toBeUndefined();
        await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
        let db = await download(page); expect(find(db, source.entry).customIcon?.id).toBe(source.icon); expect(db.meta.customIcons.size).toBe(1); expect(find(db, source.entry).history).toHaveLength(1);
        await back(page); modal = await dialog(page); await modal.getByRole('button', { name: 'Download icon', exact: true }).click();
        await expect(modal.getByRole('img', { name: 'Website icon preview', exact: true })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`stored-favicon-${width}.png`), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await modal.getByRole('button', { name: 'Use website icon', exact: true }).click();
        db = await download(page); const icon = find(db, source.entry).customIcon!.id;
        expect(icon).not.toBe(source.icon); const saved = Buffer.from(db.meta.customIcons.get(icon)!.data!); expect(saved.readUInt32BE(16)).toBe(64); expect(saved.readUInt32BE(20)).toBe(20);
        expect(db.getGroup(source.work)?.customIcon?.id).toBe(source.icon); expect(Buffer.from(db.meta.customIcons.get(source.icon)!.data!)).toEqual(source.png);
        expect(icons.requests).toHaveLength(2); await page.reload(); await page.locator('#password').fill(password); await page.locator('#unlock').click(); await browse(page);
        await page.getByRole('navigation', { name: 'Vault', exact: true }).getByRole('button', { name: 'All items', exact: true }).click(); await select(page);
        await page.context().setOffline(true); await expect(page.locator('.detail .tile img')).toBeVisible(); expect(icons.requests).toHaveLength(2);
        await page.context().setOffline(false);
    });
}
test('ICO image decodes and stores as PNG; 404, bad MIME and oversized data never replace the existing icon', async ({ page, icons }) => {
    const source = await open(page, true, icons.url); await select(page); icons.bytes = ico(await png(page, 'blue', 64, 64));
    const modal = await dialog(page);
    for (const value of ['404', 'mime', 'size'] as const) {
        icons.mode = value; await modal.getByRole('button', { name: 'Download icon', exact: true }).click();
        await expect(modal.getByRole('alert')).toBeVisible(); await expect(modal.getByRole('button', { name: 'Use website icon', exact: true })).toBeDisabled();
    }
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    let db = await download(page); expect(find(db, source.entry).customIcon?.id).toBe(source.icon); expect(db.meta.customIcons.size).toBe(1);
    await back(page); icons.mode = 'ico'; const retry = await dialog(page); await retry.getByRole('button', { name: 'Download icon', exact: true }).click();
    await expect(retry.getByRole('img', { name: 'Website icon preview', exact: true })).toBeVisible();
    await retry.getByRole('button', { name: 'Use website icon', exact: true }).click(); db = await download(page);
    expect(Buffer.from(db.meta.customIcons.get(find(db, source.entry).customIcon!.id)!.data!).subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
});
test('a real cross-origin response without CORS leaves the stored icon unchanged', async ({ page, icons }) => {
    icons.cors = false; const source = await open(page, true, icons.url); await select(page);
    const modal = await dialog(page); await modal.getByRole('button', { name: 'Download icon', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('cross-origin'); expect(icons.requests).toHaveLength(1);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click(); const db = await download(page);
    expect(find(db, source.entry).customIcon?.id).toBe(source.icon); expect(db.meta.customIcons.size).toBe(1);
});
for (const action of ['cancel', 'lock'] as const) test(`held favicon response after ${action} cannot store an icon`, async ({ page, icons }) => {
    await page.clock.install(); const source = await open(page, true, icons.url); await select(page); icons.hold = true;
    const modal = await dialog(page); await modal.getByRole('button', { name: 'Download icon', exact: true }).click();
    await expect.poll(() => icons.requests.length).toBe(1);
    if (action === 'cancel') await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    else { await page.clock.fastForward(16 * 60_000); await expect(page.locator('#password')).toBeVisible({ timeout }); }
    icons.release(); await expect(modal).toHaveCount(0);
    if (action === 'lock') { await page.locator('#password').fill(password); await page.locator('#unlock').click(); }
    const db = await download(page); expect(find(db, source.entry).customIcon?.id).toBe(source.icon); expect(db.meta.customIcons.size).toBe(1);
});

test('invalid website cannot start an import even through a dispatched disabled-button click', async ({ page, icons }) => {
    await open(page); await select(page); await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('.entry-editor').getByLabel('Website', { exact: true }).fill('javascript:alert(1)');
    await page.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
    const button = page.getByRole('button', { name: 'Download website icon…', exact: true });
    await expect(button).toBeDisabled(); await button.evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await expect(page.getByRole('dialog', { name: 'Download website icon', exact: true })).toHaveCount(0);
});
