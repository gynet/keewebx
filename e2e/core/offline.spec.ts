import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const DIST = path.join(__dirname, '../../dist');
const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.xml': 'application/xml'
};
const password = 'offline vault password';
const title = 'Offline encrypted entry';
let server: http.Server;
let origin = '';
let workerRevision = 0;
let blocked = false;
let failUpdate = false;
let vault: Buffer;

// The server publishes a new worker/cache identity and marked HTML together.
// Blocking the origin also denies service-worker fetches, which browser-level
// offline emulation alone does not consistently block across engines.
test.describe.configure({ mode: 'default' });
test.beforeAll(async () => {
    expect(fs.existsSync(path.join(DIST, 'service-worker.js'))).toBe(true);
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Offline');
    const entry = db.createEntry(db.groups[0]);
    entry.fields.set('Title', title);
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('offline entry secret'));
    vault = Buffer.from(await db.save());
    server = http.createServer((req, res) => {
        if (blocked) { req.socket.destroy(); return; }
        const pathname = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
        const relative = pathname.replace(/^\/nested\//, '/');
        if (failUpdate && relative === '/js/next.js') { res.writeHead(503).end(); return; }
        const target = relative === '/app' || relative === '/' ? '/index.html' : relative;
        const file = path.resolve(DIST, '.' + target);
        if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404).end(); return;
        }
        let body: Buffer | string = fs.readFileSync(file);
        if (relative === '/service-worker.js') {
            const source = body.toString();
            const stamp = source.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/)?.[0];
            if (!stamp) { res.writeHead(500).end('Worker build identity missing'); return; }
            body = source.replaceAll(stamp, `2030-01-01T00:00:${String(workerRevision).padStart(2, '0')}.000Z`);
        } else if (file.endsWith('.html')) {
            body = body.toString().replace('</head>', `<meta name="offline-test-revision" content="${workerRevision}"></head>`);
        }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
    });
    await new Promise<void>(resolve => server.listen(Number(process.env.KEEWEBX_OFFLINE_PORT || 0), '127.0.0.1', resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});
test.beforeEach(() => { blocked = false; failUpdate = false; workerRevision = 0; });
test.afterEach(() => { blocked = false; failUpdate = false; });
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function shell(page: Page, pathname = '/next.html') {
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => page.evaluate(async () => {
        const names = (await caches.keys()).filter(name => name.startsWith('keewebx-shell-'));
        return (await Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(r => new URL(r.url).pathname)))).flat();
    }), { timeout: 15000 }).toContain(pathname);
}

async function unlock(page: Page, classic = false) {
    await page.locator(classic ? '.open__pass-input' : '#password').fill(password);
    await page.locator(classic ? '.open__pass-enter-btn' : '#unlock').click();
    await expect(page.locator(classic ? '.list__item' : '.entry-row').filter({ hasText: title })).toBeVisible({ timeout: 20000 });
}

async function openFile(page: Page, classic = false) {
    if (classic) await page.locator('#open__icon-open').click();
    await page.locator(classic ? '.open__file-ctrl' : '#open-file-input').setInputFiles({
        name: 'offline.kdbx', mimeType: 'application/octet-stream', buffer: vault
    });
    if (classic) await page.locator('.modal button[data-result=ok]').click();
    await unlock(page, classic);
}

async function encryptedRecords(page: Page) {
    return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
        const opening = indexedDB.open('FilesCache');
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
            const db = opening.result;
            const read = db.transaction('files', 'readonly').objectStore('files').getAll();
            read.onerror = () => { db.close(); reject(read.error); };
            read.onsuccess = async () => {
                try {
                    const hashes = await Promise.all(read.result.map(async value => {
                        const bytes = new Uint8Array(value);
                        if (bytes.length < 100 || new DataView(bytes.buffer).getUint32(0, true) !== 0x9aa2d903) {
                            throw new Error('Expected encrypted KDBX cache bytes');
                        }
                        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
                    }));
                    resolve(hashes.sort());
                } catch (error) { reject(error); }
                finally { db.close(); }
            };
        };
    }));
}

async function denyOrigin() {
    blocked = true;
    await expect(fetch(origin + '/next.html')).rejects.toThrow();
}

for (const prefix of ['', '/nested']) {
    test(`New-only first visit cold boots and unlocks cached KDBX offline at ${prefix || '/'}`, async ({ browser }, testInfo) => {
        const profile = testInfo.outputPath('profile');
        const options = { ...testInfo.project.use.launchOptions, headless: true };
        let context = await browser.browserType().launchPersistentContext(profile, options);
        try {
            const page = await context.newPage();
            await page.goto(origin + prefix + '/next.html');
            await openFile(page);
            await shell(page, prefix + '/next.html');
            expect(await page.evaluate(() => navigator.serviceWorker.ready.then(r => r.scope))).toBe(origin + prefix + '/');
            const manifest = await page.locator('link[rel=manifest]').getAttribute('href');
            expect(manifest).toBe('manifest-new.json');
            const manifestData = await (await page.request.get(origin + prefix + '/' + manifest)).json();
            expect(manifestData.start_url).toBe('./next.html');
            await page.getByRole('button', { name: 'Lock', exact: true }).click();
            await expect(page.locator('#password')).toBeVisible();
            const encrypted = await encryptedRecords(page);
            expect(encrypted).toHaveLength(1);
            // Close every tab and the browser process, retaining only its profile.
            await context.close();
            await denyOrigin();
            context = await browser.browserType().launchPersistentContext(profile, { ...options, offline: true });
            const cold = await context.newPage();
            const response = await cold.goto(origin + prefix + '/next.html');
            expect(response?.fromServiceWorker()).toBe(true);
            await expect(cold.locator('.vault-row--on')).toHaveAttribute('data-vault', 'offline');
            expect(await encryptedRecords(cold)).toEqual(encrypted);
            await unlock(cold);
            await cold.locator('.entry-row').filter({ hasText: title }).click();
            await cold.locator('[data-field="password"]').getByRole('button', { name: 'Show password', exact: true }).click();
            await expect(cold.locator('[data-field="password"]')).toContainText('offline entry secret');
        } finally { await context.close(); blocked = false; }
    });
}

test('Classic opens and unlocks its demo with the app origin blocked', async ({ page, context }) => {
    await page.goto(origin + '/app');
    await shell(page, '/app');
    await denyOrigin();
    await context.setOffline(true);
    const response = await page.reload();
    expect(response?.fromServiceWorker()).toBe(true);
    await page.click('#open__icon-demo');
    await expect(page.locator('.list__item').first()).toBeVisible({ timeout: 20000 });
});

for (const classic of [false, true]) {
    test(`${classic ? 'Classic' : 'New'} update retains encrypted data and unlocks offline`, async ({ page, context }) => {
        const entryPoint = classic ? '/app' : '/next.html';
        await page.goto(origin + entryPoint);
        await shell(page, entryPoint);
        await page.reload();
        await openFile(page, classic);
        await expect.poll(() => encryptedRecords(page)).toHaveLength(1);
        let before = await encryptedRecords(page);
        expect(before).toHaveLength(1);
        await page.evaluate(() => { (window as unknown as { beforeUpdate: boolean }).beforeUpdate = true; });
        if (!classic) {
            await page.locator('.entry-row').filter({ hasText: title }).click();
            await page.getByRole('button', { name: 'Edit', exact: true }).click();
            await page.locator('.entry-editor').getByLabel('Notes', { exact: true }).fill('Unsaved update draft');
        }
        workerRevision++;
        await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r!.update()));
        await expect.poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r?.waiting?.state))).toBe('installed');
        expect(await page.evaluate(() => (window as unknown as { beforeUpdate?: boolean }).beforeUpdate)).toBe(true);
        if (classic) {
            await expect(page.locator('.footer__update-icon')).toBeVisible();
            await page.click('#footer__btn-settings');
            await page.click('.settings__general-restart-btn');
        } else {
            await expect(page.locator('#apply-app-update')).toBeDisabled();
            await expect(page.locator('.entry-editor').getByLabel('Notes', { exact: true })).toHaveValue('Unsaved update draft');
            await page.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
            await page.getByRole('button', { name: 'Lock', exact: true }).click();
            await expect(page.locator('#apply-app-update')).toBeEnabled();
            const saved = await encryptedRecords(page);
            expect(saved).not.toEqual(before);
            before = saved;
            await page.click('#apply-app-update');
        }
        await expect(page.locator('meta[name=offline-test-revision]')).toHaveAttribute('content', '1');
        expect(await page.evaluate(() => (window as unknown as { beforeUpdate?: boolean }).beforeUpdate)).toBeUndefined();
        expect(await encryptedRecords(page)).toEqual(before);
        await expect.poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => !!r!.waiting))).toBe(false);
        const names = await page.evaluate(() => caches.keys());
        expect(names.filter(name => name.startsWith('keewebx-shell-'))).toHaveLength(1);
        await denyOrigin();
        await context.setOffline(true);
        await page.reload();
        if (classic) await page.locator('.open__last-item').filter({ hasText: 'offline' }).click();
        await unlock(page, classic);
        if (!classic) {
            await page.locator('.entry-row').filter({ hasText: title }).click();
            await expect(page.locator('.entry-notes')).toContainText('Unsaved update draft');
        }
    });
}

test('a failed New asset update keeps the old offline shell and encrypted vault', async ({ page, context }) => {
    await page.goto(origin + '/next.html');
    await shell(page);
    await openFile(page);
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await page.reload();
    const before = await encryptedRecords(page);
    const names = await page.evaluate(() => caches.keys());
    failUpdate = true;
    workerRevision++;
    const state = await page.evaluate(() => new Promise<string>(async resolve => {
        const registration = (await navigator.serviceWorker.getRegistration())!;
        registration.addEventListener('updatefound', () => {
            const worker = registration.installing!;
            worker.addEventListener('statechange', () => {
                if (worker.state === 'redundant') resolve(worker.state);
            });
        }, { once: true });
        await registration.update();
    }));
    expect(state).toBe('redundant');
    expect(await page.evaluate(() => caches.keys())).toEqual(names);
    expect(await encryptedRecords(page)).toEqual(before);
    await denyOrigin();
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('meta[name=offline-test-revision]')).toHaveAttribute('content', '0');
    await unlock(page);
});
