import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

assert(process.argv[2], 'Usage: node scripts/smoke-artifact.mjs <extracted-web-directory>');
const root = path.resolve(process.argv[2]);
const required = ['index.html', 'classic.html', 'classic/index.html', 'next.html', 'DEPLOY.md', 'manifest-classic.json', 'manifest-new.json', 'js/app.js', 'js/next.js', 'css/app.css',
    'css/next.css', 'service-worker.js', 'manifest.json', 'LICENSE', 'THIRD-PARTY-LICENSES.md'];
for (const file of required) {
    const stat = statSync(path.join(root, file));
    assert(stat.isFile() && stat.size > 0, `Missing or empty packaged file: ${file}`);
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/nested/')) pathname = pathname.slice('/nested'.length);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
        const data = readFileSync(file);
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-store' }).end(data);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((resolve) => server.listen(Number(process.env.KEEWEBX_E2E_PORT || 0), '127.0.0.1', resolve));
let browser;
const checked = [];
try {
    browser = await chromium.launch({ headless: true });
    for (const [entry, demo, rows] of [
        ['', '#open-demo', '.entry-row'],
        ['index.html', '#open-demo', '.entry-row'],
        ['next.html', '#open-demo', '.entry-row'],
        ['classic.html', '#open__icon-demo', '.list__item'],
        ['classic/index.html', '#open__icon-demo', '.list__item'],
        ['index.html?ui=classic', '#open__icon-demo', '.list__item'],
        ['index.html?demo=1', null, '.entry-row']
    ]) for (const mode of ['http', 'nested', 'file']) {
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('requestfailed', (request) => errors.push(`Request failed: ${request.url()}`));
            page.on('response', (response) => {
                if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
            });
            await page.addInitScript(() => {
                window.artifactCspErrors = [];
                document.addEventListener('securitypolicyviolation', (event) => {
                    window.artifactCspErrors.push(`${event.violatedDirective}: ${event.blockedURI}`);
                });
            });
            const [documentPath, query] = (entry || 'index.html').split('?');
            const fileUrl = pathToFileURL(path.join(root, documentPath));
            fileUrl.search = query || '';
            await page.goto(mode === 'file' ? fileUrl.href
                : `http://localhost:${server.address().port}/${mode === 'nested' ? 'nested/' : ''}${entry}`);
            if (demo) await page.locator(demo).click();
            await expect(page.locator(rows).first()).toBeVisible({ timeout: 30000 });
            expect(errors, `JavaScript errors in packaged ${entry}`).toEqual([]);
            expect(await page.evaluate(() => window.artifactCspErrors)).toEqual([]);
            await expect(page.locator('body')).toHaveCSS('margin-top', '0px');
            checked.push({ entry, mode });
        } finally {
            await context.close();
        }
    }
} finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
}
console.log(JSON.stringify({ checked, requiredFiles: required.length, passed: true }, null, 2));
