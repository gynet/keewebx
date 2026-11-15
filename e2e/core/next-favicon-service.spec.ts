import { test as base, expect, type Page } from '@playwright/test';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { open, download, find, png, back, password } from './presentation-lifecycle-fixture';
interface IconService {
    url: string; requests: { url: string; headers: IncomingHttpHeaders }[];
    mode: 'image' | 'missing' | 'mime' | 'large' | 'hold'; release(): void;
}
const test = base.extend<{ service: IconService }>({
    service: async ({ page }, use) => {
        const image = await png(page, 'green', 300, 96), pending = new Set<ServerResponse>();
        const service: IconService = { url: '', requests: [], mode: 'image', release() { for (const response of pending) respond(response); pending.clear(); } };
        const respond = (response: ServerResponse) => {
            if (response.destroyed) return;
            response.writeHead(service.mode === 'missing' ? 404 : 200, {
                'Content-Type': service.mode === 'mime' ? 'text/html' : 'image/png', 'Access-Control-Allow-Origin': '*'
            });
            response.end(service.mode === 'large' ? Buffer.alloc(1024 * 1024 + 1) : service.mode === 'mime' ? '<html>not an icon</html>' : image);
        };
        const server = createServer((request, response) => {
            service.requests.push({ url: request.url!, headers: request.headers });
            if (service.mode === 'hold') pending.add(response); else respond(response);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        service.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/icons/`;
        await page.addInitScript(url => localStorage.setItem('appSettings', JSON.stringify({ faviconServiceUrl: url, faviconSize: 64, showFavicons: false })), service.url);
        try { await use(service); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }
});
async function dialog(page: Page) {
    await page.getByRole('button', { name: 'Change icon and color', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Entry appearance', exact: true });
    await modal.getByRole('button', { name: 'Download website icon…', exact: true }).click();
    return modal;
}
for (const width of [390, 1280]) test(`configured icon service strips private URL data, retries and stages a bounded PNG at ${width}px`, async ({ page, service }) => {
    await page.setViewportSize({ width, height: 844 });
    const source = await open(page, true, 'https://login.example.test:8443/private/account?token=secret#private');
    await page.locator('[data-entry="Existing account"]').click();
    let modal = await dialog(page);
    await expect(modal).toContainText('only the website domain to the configured icon service');
    await expect(modal.getByText(service.url + 'login.example.test?min=64', { exact: true })).toBeVisible();
    expect(service.requests).toEqual([]);
    for (const mode of ['missing', 'mime', 'large'] as const) {
        service.mode = mode;
        await modal.getByRole('button', { name: 'Download icon', exact: true }).click();
        await expect(modal.getByRole('alert')).toBeVisible();
        await expect(modal.getByRole('img', { name: 'Website icon preview', exact: true })).toHaveCount(0);
    }
    service.mode = 'image';
    await modal.getByRole('button', { name: 'Download icon', exact: true }).click();
    await expect(modal.getByRole('img', { name: 'Website icon preview', exact: true })).toBeVisible();
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    let db = await download(page);
    expect(find(db, source.entry).customIcon?.id).toBe(source.icon); expect(db.meta.customIcons.size).toBe(1);
    expect(find(db, source.entry).history).toHaveLength(1);
    await back(page); modal = await dialog(page);
    await modal.getByRole('button', { name: 'Download icon', exact: true }).click();
    await expect(modal.getByRole('img', { name: 'Website icon preview', exact: true })).toBeVisible();
    await modal.getByRole('button', { name: 'Apply appearance', exact: true }).click();
    db = await download(page);
    const stored = Buffer.from(db.meta.customIcons.get(find(db, source.entry).customIcon!.id)!.data!);
    expect(stored.readUInt32BE(16)).toBe(64); expect(stored.readUInt32BE(20)).toBe(20);
    expect(service.requests).toHaveLength(5);
    for (const request of service.requests) {
        expect(request.url).toBe('/icons/login.example.test?min=64');
        expect(request.headers.referer).toBeUndefined(); expect(request.headers.cookie).toBeUndefined();
    }
});
for (const action of ['cancel', 'lock'] as const) test(`configured icon service late response after ${action} cannot change the vault`, async ({ page, service }) => {
    const source = await open(page, true, 'https://login.example.test/private?token=secret');
    await page.locator('[data-entry="Existing account"]').click(); service.mode = 'hold';
    const modal = await dialog(page);
    await modal.getByRole('button', { name: 'Download icon', exact: true }).click();
    await expect.poll(() => service.requests.length).toBe(1);
    await expect(modal.getByRole('button', { name: 'Apply appearance', exact: true })).toBeDisabled();
    if (action === 'cancel') await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    else { await page.locator('#lock').evaluate(button => (button as HTMLButtonElement).click()); await expect(page.locator('#password')).toBeVisible(); }
    service.mode = 'image'; service.release(); await expect(modal).toHaveCount(0);
    if (action === 'lock') { await page.locator('#password').fill(password); await page.locator('#unlock').click(); }
    const db = await download(page);
    expect(find(db, source.entry).customIcon?.id).toBe(source.icon); expect(db.meta.customIcons.size).toBe(1);
    expect(find(db, source.entry).history).toHaveLength(1);
});
