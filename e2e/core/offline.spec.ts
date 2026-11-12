import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';

/**
 * Offline support. Runs against the production build in dist
 * (the dev server never registers the service worker), served by a small
 * static server that can publish a "new version" of the worker on demand.
 */

const DIST = path.join(__dirname, '../../dist');
const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.xml': 'application/xml'
};

let server: http.Server;
let origin = '';
let workerRevision = 0;

test.skip(!fs.existsSync(path.join(DIST, 'service-worker.js')), 'run `bun run build` first');

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const pathname = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
        let file = path.join(DIST, pathname);
        if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            file = path.join(DIST, 'index.html'); // SPA fallback, like /app and /demo
        }
        let body: Buffer | string = fs.readFileSync(file);
        if (pathname === '/service-worker.js') {
            body = body.toString() + `\n// revision ${workerRevision}\n`;
        }
        res.writeHead(200, {
            'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
            'cache-control': 'no-cache'
        });
        res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
});

async function waitForShellCache(page: Page): Promise<void> {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect
        .poll(
            () =>
                page.evaluate(async () => {
                    const names = await caches.keys();
                    const cache = await caches.open(names.find((n) => n.startsWith('keewebx-shell-'))!);
                    return (await cache.keys()).map((r) => new URL(r.url).pathname);
                }),
            { timeout: 15000 }
        )
        .toContain('/app');
}

async function openDemo(page: Page): Promise<void> {
    await page.click('#open__icon-demo');
    await expect(page.locator('.list__item').first()).toBeVisible({ timeout: 20000 });
}

test('opens and unlocks the demo vault with no network', async ({ page, context }) => {
    await page.goto(`${origin}/app`);
    await waitForShellCache(page);

    await context.setOffline(true);
    await page.reload();
    await openDemo(page);
    await context.setOffline(false);
});

test('holds an update while a vault is open and applies it from Settings', async ({ page }) => {
    await page.goto(`${origin}/app`);
    await waitForShellCache(page);
    await page.reload(); // now controlled by the worker

    // A vault is open: the update waits behind the footer indicator.
    await openDemo(page);
    workerRevision++;
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r!.update()));
    await expect(page.locator('.footer__update-icon')).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);

    // Reload from Settings applies it.
    await page.click('#footer__btn-settings');
    await Promise.all([
        page.waitForEvent('framenavigated'),
        page.click('.settings__general-restart-btn')
    ]);
    await page.waitForLoadState('load');
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBeUndefined();
    const waiting = await page.evaluate(() =>
        navigator.serviceWorker.getRegistration().then((r) => Boolean(r!.waiting))
    );
    expect(waiting).toBe(false);
});
