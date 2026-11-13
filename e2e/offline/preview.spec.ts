import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';
const root = path.resolve(__dirname, '../..');
const normal = path.join(root, 'dist');
const preview = path.resolve(root, process.env.KEEWEBX_PREVIEW_DIST || '.cache/offline/preview');
let server: http.Server;
let blocked = false;
let origin = '';
const password = 'offline preview isolation';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
test.beforeAll(() => {
    expect(fs.existsSync(path.join(preview, 'service-worker.js'))).toBe(false);
    expect(fs.existsSync(path.join(preview, 'manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(preview, 'manifest-new.json'))).toBe(false);
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    server = http.createServer((request, response) => {
        if (blocked) { request.socket.destroy(); return; }
        const url = new URL(request.url!, origin);
        const isPreview = url.pathname.startsWith('/preview/');
        const file = path.join(isPreview ? preview : normal, isPreview ? url.pathname.slice(8) : url.pathname);
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        response.end(fs.readFileSync(file));
    });
    return new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
        origin = `http://localhost:${(server.address() as import('node:net').AddressInfo).port}`;
        resolve();
    }));
});
test.afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
test('namespaced New/Classic omit manifests and workers, isolate vaults, and stay outside the normal offline cache', async ({ page, context }) => {
    blocked = false;
    async function open(label: string) {
        const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), label);
        db.createEntry(db.groups[0]).fields.set('Title', label + ' secret');
        await page.locator('#open-file-input').setInputFiles({ name: label + '.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) });
        await page.locator('#password').fill(password); await page.locator('#unlock').click();
        await expect(page.locator('.entry-row')).toContainText(label + ' secret');
        await page.getByRole('button', { name: 'Lock', exact: true }).click();
        await expect(page.locator('#password')).toBeVisible();
    }
    await page.goto(origin + '/preview/next.html');
    await expect(page.locator('#open-demo')).toBeVisible();
    await expect(page.locator('link[rel=manifest]')).toHaveCount(0);
    await open('preview-only');
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(r => r.length))).toBe(0);
    expect(await page.evaluate(() => caches.keys())).toEqual([]);
    await page.goto(origin + '/preview/index.html?ui=classic');
    await expect(page.locator('.open__pass-input')).toBeVisible();
    await expect(page.locator('link[rel=manifest]')).toHaveCount(0);
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(r => r.length))).toBe(0);
    await page.goto(origin + '/next.html');
    await expect(page.locator('#open-demo')).toBeVisible();
    await expect(page.locator('.vault-row')).toHaveCount(0);
    await open('normal-only');
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.goto(origin + '/preview/next.html');
    await expect(page.locator('.vault-row')).toHaveCount(1);
    await expect(page.locator('.vault-row')).toHaveAttribute('data-vault', 'preview-only');
    await expect(page.locator('link[rel=manifest]')).toHaveCount(0);
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(r => r.map(x => x.scope)))).toEqual([origin + '/']);
    const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async n => (await (await caches.open(n)).keys()).map(r => r.url)))).flat());
    expect(cached.some(url => url.includes('/preview/'))).toBe(false);
    blocked = true;
    await expect(fetch(origin + '/preview/next.html')).rejects.toThrow();
    await context.setOffline(true);
    await expect(page.goto(origin + '/preview/next.html')).rejects.toThrow();
    // The failed preview navigation may still be committing an error page.
    // A fresh tab proves normal offline boot without racing that navigation.
    page = await context.newPage();
    await page.goto(origin + '/next.html');
    await expect(page.locator('.vault-row')).toHaveCount(1);
    await expect(page.locator('.vault-row')).toHaveAttribute('data-vault', 'normal-only');
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row')).toContainText('normal-only secret');
    blocked = false;
});
