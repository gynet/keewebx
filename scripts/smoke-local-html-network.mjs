import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit, expect } from '@playwright/test';

// Test real local files. A listening server proves blocked requests never arrive.
const root = path.resolve(process.argv[2] || 'dist');
const engines = (process.env.KW_LOCAL_HTML_BROWSERS || 'chromium,firefox,webkit').split(',');
const received = [];
const certDir = mkdtempSync(path.join(tmpdir(), 'kwx-local-policy-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')], { stdio: 'ignore' });
const server = createServer({ key: readFileSync(path.join(certDir, 'key.pem')), cert: readFileSync(path.join(certDir, 'cert.pem')) }, (req, res) => {
    received.push(req.url);
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'image/png' });
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64'));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `https://127.0.0.1:${server.address().port}`;
const results = [];
try {
    for (const name of engines) {
        const browser = await ({ chromium, firefox, webkit })[name].launch();
        try {
            for (const classic of [false, true]) {
                received.length = 0;
                const context = await browser.newContext({ ignoreHTTPSErrors: true });
                try {
                    // Retained online preferences must not bypass the local policy.
                    await context.addInitScript(() => {
                        localStorage.setItem('appSettings', JSON.stringify({ checkPasswordsOnHIBP: true, showFavicons: false }));
                        window.policyViolations = [];
                        document.addEventListener('securitypolicyviolation', event => window.policyViolations.push(event.effectiveDirective));
                    });
                    const page = await context.newPage();
                    const errors = [], requests = [];
                    page.on('pageerror', error => errors.push(error.message));
                    page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
                    const url = pathToFileURL(path.join(root, classic ? 'classic.html' : 'index.html'));
                    url.searchParams.set('config', `${origin}/api/config`);
                    await page.goto(url.href);
                    await expect(page.locator('html')).toHaveAttribute('data-network', 'offline');
                    await page.locator(classic ? '#open__icon-demo' : '#open-demo').click();
                    const rows = page.locator(classic ? '.list__item' : '.entry-row');
                    await expect(rows.first()).toBeVisible({ timeout: 30000 });
                    await rows.first().click();
                    await expect(page.locator('[aria-label="App update"]')).toHaveCount(0);
                    assert.deepEqual(requests, [], 'Local startup, configured URL and password audit must make no server requests');
                    assert.deepEqual(errors, []);
                    assert.deepEqual(await page.evaluate(() => window.policyViolations), [], 'Normal local use must not attempt blocked networking');
                    // Probe fetch, XHR and beacon independently of application guards.
                    await page.evaluate(async origin => {
                        await fetch(`${origin}/api/version`).catch(() => {});
                        await new Promise(resolve => {
                            const xhr = new XMLHttpRequest(); xhr.open('GET', `${origin}/api/config`);
                            xhr.onloadend = resolve;
                            try { xhr.send(); } catch { resolve(); }
                        });
                        try { navigator.sendBeacon(`${origin}/api/telemetry`, 'probe'); } catch { /* CSP rejection is expected. */ }
                    }, origin);
                    assert.deepEqual(received, [], 'Blocked calls must not reach a server');
                    // Website icons are the only allowed HTTP(S) exception.
                    const icon = await page.evaluate(async origin => {
                        const response = await fetch(`${origin}/favicon.ico`, { credentials: 'omit', redirect: 'error' });
                        return response.ok;
                    }, origin);
                    assert.equal(icon, true);
                    assert.deepEqual(received, ['/favicon.ico']);
                    results.push({ browser: name, interface: classic ? 'classic' : 'new', startupRequests: 0,
                        updateConfigurationAndTelemetryBlocked: true, websiteIconAllowed: true });
                } finally { await context.close(); }
            }
        } finally { await browser.close(); }
    }
} finally { await new Promise(resolve => server.close(resolve)); rmSync(certDir, { recursive: true, force: true }); }
console.log(JSON.stringify({ results }, null, 2));
