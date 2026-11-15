import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

assert(process.argv[2], 'Usage: node scripts/smoke-standalone-artifact.mjs <extracted-web-directory>');
const root = path.resolve(process.argv[2]);
const metadata = JSON.parse(readFileSync(path.join(root, 'WEB-PACKAGE.json'), 'utf8'));
const ui = metadata.interface;
assert(ui === 'new' || ui === 'classic', 'Expected a standalone package');
const classic = ui === 'classic';
const required = ['index.html', 'DEPLOY.md', 'service-worker.js', 'manifest.json', 'LICENSE', 'THIRD-PARTY-LICENSES.md',
    ...(classic ? ['classic.html', 'classic/index.html', 'manifest-classic.json', 'js/app.js', 'css/app.css']
        : ['next.html', 'manifest-new.json', 'js/next.js', 'css/next.css'])];
for (const file of required) {
    const stat = statSync(path.join(root, file));
    assert(stat.isFile() && stat.size > 0, `Missing or empty packaged file: ${file}`);
}
for (const file of classic ? ['next.html', 'js/next.js', 'css/next.css', 'manifest-new.json']
    : ['classic.html', 'classic', 'js/app.js', 'css/app.css', 'manifest-classic.json']) {
    assert(!existsSync(path.join(root, file)), `Other interface leaked into ${ui}: ${file}`);
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.xml': 'application/xml' };
let blocked = false;
const server = createServer((req, res) => {
    // Deny the origin itself, including fetches made by service workers.
    if (blocked) return req.socket.destroy();
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/nested/')) pathname = pathname.slice('/nested'.length);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-store' }).end(readFileSync(file));
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise(resolve => server.listen(Number(process.env.KEEWEBX_E2E_PORT || 0), '127.0.0.1', resolve));
const origin = `http://localhost:${server.address().port}`;
const entries = classic ? ['', 'index.html', 'classic.html', 'classic/index.html', 'classic/', 'index.html?ui=new']
    : ['', 'index.html', 'next.html', 'index.html?ui=classic', 'next.html?ui=classic', 'index.html?demo=1'];
const demo = classic ? '#open__icon-demo' : '#open-demo';
const rows = classic ? '.list__item' : '.entry-row';
const checked = [];
let browser;
try {
    browser = await chromium.launch({ headless: true });
    for (const entry of entries) for (const mode of ['http', 'nested', 'file']) {
        if (entry === 'classic/' && mode === 'file') continue;
        const context = await browser.newContext();
        try {
            // Exercise profiles migrated from the other UI, including Classic's
            // homepage with the default New preference already persisted.
            await context.addInitScript(preference => {
                localStorage.setItem('appSettings', JSON.stringify({ ui: preference }));
                window.artifactCspErrors = [];
                document.addEventListener('securitypolicyviolation', event => {
                    window.artifactCspErrors.push(`${event.violatedDirective}: ${event.blockedURI}`);
                });
            }, classic ? 'new' : 'classic');
            let page = await context.newPage();
            const errors = [];
            const observe = page => {
                page.on('pageerror', error => errors.push(error.message));
                page.on('requestfailed', request => errors.push(`Request failed: ${request.url()}`));
                page.on('response', response => {
                    if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
                });
            };
            observe(page);
            const [documentPath, query] = (entry || 'index.html').split('?');
            const fileUrl = pathToFileURL(path.join(root, documentPath));
            fileUrl.search = query || '';
            const url = mode === 'file' ? fileUrl.href : `${origin}/${mode === 'nested' ? 'nested/' : ''}${entry}`;
            await page.goto(url);
            const autoDemo = entry.endsWith('?demo=1');
            await expect(page.locator(autoDemo ? rows : demo).first()).toBeVisible({ timeout: 30000 });
            if (!classic) await expect(page.locator('a[href="classic.html"]')).toHaveCount(0);
            let offline = false;
            if (mode !== 'file') {
                // Ready must resolve and the actual page must have been cached.
                // Poll with a timeout so a failed SW install is a clear failure.
                await expect.poll(() => page.evaluate(async () => {
                    const registration = await navigator.serviceWorker.getRegistration();
                    if (registration?.active?.state !== 'activated') return false;
                    const target = new URL(location.href); target.search = ''; target.hash = '';
                    return !!await caches.match(target.href);
                }), { timeout: 20000, message: `Installed offline shell: ${ui} ${entry} ${mode}` }).toBe(true);
                const scope = await page.evaluate(() => navigator.serviceWorker.ready.then(r => r.scope));
                expect(scope).toBe(`${origin}/${mode === 'nested' ? 'nested/' : ''}`);
                await page.close();
                blocked = true;
                await context.setOffline(true);
                page = await context.newPage();
                observe(page);
                const response = await page.goto(url);
                expect(response?.fromServiceWorker()).toBe(true);
                await expect(page.locator(autoDemo ? rows : demo).first()).toBeVisible({ timeout: 30000 });
                offline = true;
            }
            if (!autoDemo) await page.locator(demo).click();
            await expect(page.locator(rows).first()).toBeVisible({ timeout: 30000 });
            // Open the real settings surface: there must be no action pointing
            // at the absent interface after a vault has been opened either.
            if (classic) {
                await page.locator('.footer__btn-settings').click();
                await expect(page.locator('#appearance')).toBeVisible();
                await expect(page.locator('#settings__general-ui')).toHaveCount(0);
            } else {
                const settings = page.getByRole('button', { name: 'Settings', exact: true }).filter({ visible: true });
                if (!await settings.isVisible()) await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
                await settings.click();
                await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
                await expect(page.getByRole('radiogroup', { name: 'Interface', exact: true })).toHaveCount(0);
                await expect(page.getByRole('button', { name: 'Classic', exact: true })).toHaveCount(0);
                await expect(page.locator('a[href="classic.html"]')).toHaveCount(0);
            }
            expect(errors, `${ui} ${entry} ${mode}`).toEqual([]);
            expect(await page.evaluate(() => window.artifactCspErrors)).toEqual([]);
            await expect(page.locator('body')).toHaveCSS('margin-top', '0px');
            checked.push({ entry, mode, offline, oppositePreference: true, switchSafe: true });
        } finally {
            blocked = false;
            await context.close();
        }
    }
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ interface: ui, checked, requiredFiles: required.length, passed: true }, null, 2));
