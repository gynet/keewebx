import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit, expect } from '@playwright/test';

// Use native file:// pages and a real HTTPS fixture for configured services.
const root = path.resolve(process.argv[2] || 'dist');
const engines = (process.env.KW_LOCAL_HTML_BROWSERS || 'chromium,firefox,webkit').split(',');
const officialHttp = /^https?:\/\/(?:[^/]+\.)?keewebx\.app\.*(?::\d+)?(?:\/|$)/i;
const received = [];
const certDir = mkdtempSync(path.join(tmpdir(), 'kwx-local-policy-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')], { stdio: 'ignore' });
const server = createServer({ key: readFileSync(path.join(certDir, 'key.pem')), cert: readFileSync(path.join(certDir, 'cert.pem')) }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PROPFIND, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Depth, Authorization',
        'Access-Control-Expose-Headers': 'ETag, Last-Modified',
        'Content-Type': 'text/plain',
        'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
        ETag: '"local-fixture"'
    };
    if (req.method === 'OPTIONS') {
        res.writeHead(204, headers); res.end();
    } else if (req.method === 'PROPFIND') {
        res.writeHead(207, { ...headers, 'Content-Type': 'application/xml' });
        res.end('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/webdav/vault.kdbx</d:href></d:response></d:multistatus>');
    } else if (req.method === 'PUT') {
        res.writeHead(201, headers); res.end('Saved');
    } else {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ fixture: true, settings: {} }));
    }
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
                    const officialInterceptions = [], unexpectedRequests = [];
                    // Safety routes prevent production contact even if a wrapper regresses.
                    await context.route('**/*', route => {
                        const url = route.request().url();
                        if (!/^https?:/.test(url) || new URL(url).origin === origin) return route.continue();
                        unexpectedRequests.push(url);
                        return route.abort();
                    });
                    await context.route(officialHttp, route => {
                        officialInterceptions.push(route.request().url());
                        return route.abort();
                    });
                    // HTTP routing does not intercept WebSocket handshakes.
                    await context.routeWebSocket(/.*/, socket => {
                        officialInterceptions.push(socket.url());
                        socket.close();
                    });
                    await context.addInitScript(() => {
                        // Audits remain opt-in; never select an entry in this network smoke.
                        localStorage.setItem('appSettings', JSON.stringify({ checkPasswordsOnHIBP: false, showFavicons: false }));
                        window.policyViolations = [];
                        window.serviceWorkerRegistrations = [];
                        document.addEventListener('securitypolicyviolation', event => window.policyViolations.push(event.effectiveDirective));
                        if (navigator.serviceWorker) {
                            const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
                            navigator.serviceWorker.register = (...args) => {
                                window.serviceWorkerRegistrations.push(String(args[0]));
                                return register(...args);
                            };
                        }
                    });
                    const page = await context.newPage();
                    const errors = [], requests = [];
                    page.on('pageerror', error => errors.push(error.message));
                    page.on('requestfailed', request => console.error(`${name} ${classic ? 'classic' : 'new'} request failed: ${request.url()}: ${request.failure()?.errorText}`));
                    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
                    page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
                    const url = pathToFileURL(path.join(root, classic ? 'classic.html' : 'index.html'));
                    url.searchParams.set('config', `${origin}/api/config`);
                    await page.goto(url.href);
                    await expect(page.locator('html')).toHaveAttribute('data-local-html', 'true');
                    await page.locator(classic ? '#open__icon-demo' : '#open-demo').click();
                    await expect(page.locator(classic ? '.list__item' : '.entry-row').first()).toBeVisible({ timeout: 30000 });
                    await expect(page.locator('[aria-label="App update"]')).toHaveCount(0);
                    assert.deepEqual(requests, [], 'Local startup must skip server/version checks and startup configuration');
                    assert.deepEqual(await page.evaluate(() => window.serviceWorkerRegistrations), [], 'Local startup must not register a service worker');

                    const allowed = await page.evaluate(async origin => {
                        const response = await fetch(`${origin}/api/config`);
                        const config = await response.json();
                        const propfind = await new Promise((resolve, reject) => {
                            const xhr = new XMLHttpRequest();
                            xhr.open('PROPFIND', `${origin}/webdav/`);
                            xhr.setRequestHeader('Depth', '1');
                            xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
                            xhr.onerror = () => reject(new Error('Fixture WebDAV PROPFIND failed'));
                            xhr.timeout = 10000;
                            xhr.ontimeout = () => reject(new Error('Fixture WebDAV PROPFIND timed out'));
                            xhr.send();
                        });
                        const put = await new Promise((resolve, reject) => {
                            const xhr = new XMLHttpRequest();
                            xhr.open('PUT', `${origin}/webdav/vault.kdbx`);
                            xhr.onload = () => resolve(xhr.status);
                            xhr.onerror = () => reject(new Error('Fixture WebDAV PUT failed'));
                            xhr.timeout = 10000;
                            xhr.ontimeout = () => reject(new Error('Fixture WebDAV PUT timed out'));
                            xhr.send('local-html-sync-fixture');
                        });
                        return { config, propfind, put };
                    }, origin);
                    assert.equal(allowed.config.fixture, true, 'Configured GET must remain available');
                    assert.equal(allowed.propfind.status, 207, 'WebDAV PROPFIND must remain available');
                    assert.match(allowed.propfind.body, /multistatus/);
                    assert.equal(allowed.put, 201, 'WebDAV PUT must remain available');
                    assert.deepEqual(received.filter(request => request.method !== 'OPTIONS'), [
                        { method: 'GET', url: '/api/config', body: '' },
                        { method: 'PROPFIND', url: '/webdav/', body: '' },
                        { method: 'PUT', url: '/webdav/vault.kdbx', body: 'local-html-sync-fixture' }
                    ]);

                    const blocked = await page.evaluate(async () => {
                        const outcomes = [];
                        for (const host of ['keewebx.app', 'api.checks.keewebx.app', 'KEEWEBX.APP.', 'api.keewebx.app.']) {
                            for (const scheme of ['http', 'https']) {
                                const url = `${scheme}://${host}/api/version`;
                                let fetchBlocked = false;
                                try { await fetch(url, { signal: AbortSignal.timeout(5000) }); } catch { fetchBlocked = true; }
                                let xhrBlocked = false;
                                try { const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.send(); } catch { xhrBlocked = true; }
                                let beaconBlocked = false;
                                try { beaconBlocked = navigator.sendBeacon(url, 'probe') === false; } catch { beaconBlocked = true; }
                                let eventSourceBlocked = false;
                                try { const source = new EventSource(url); source.close(); } catch { eventSourceBlocked = true; }
                                let webSocketBlocked = false;
                                try { const socket = new WebSocket(`${scheme === 'https' ? 'wss' : 'ws'}://${host}/probe`); socket.close(); } catch { webSocketBlocked = true; }
                                outcomes.push({ url, fetchBlocked, xhrBlocked, beaconBlocked, eventSourceBlocked, webSocketBlocked });
                            }
                        }
                        return outcomes;
                    });
                    for (const { url, ...outcomes } of blocked) {
                        for (const [api, value] of Object.entries(outcomes)) assert.equal(value, true, `${api}: ${url} must be blocked by the early wrapper`);
                    }
                    assert.deepEqual(officialInterceptions, [], 'Official requests must be blocked before transport; safety routes must never be needed');
                    assert.deepEqual(unexpectedRequests, [], 'All real HTTP(S) requests must be limited to the fixture');
                    assert.deepEqual(await page.evaluate(() => window.policyViolations), [], 'Allowed services and official-domain guards must not rely on CSP rejection');
                    assert.deepEqual(errors, []);
                    results.push({ browser: name, interface: classic ? 'classic' : 'new', startupRequests: 0,
                        serviceWorkerRegistrations: 0, configuredGetAllowed: true, webDavPropfindAndPutAllowed: true,
                        officialDomainsBlockedBeforeTransport: true, officialSafetyInterceptions: officialInterceptions.length });
                    console.error(`PASS ${name} ${classic ? 'classic' : 'new'}: configured services allowed; official domains blocked before transport`);
                } finally { await context.close(); }
            }
        } finally { await browser.close(); }
    }
} catch (error) {
    console.error('HTTPS fixture received:', JSON.stringify(received));
    throw error;
} finally { await new Promise(resolve => server.close(resolve)); rmSync(certDir, { recursive: true, force: true }); }
console.log(JSON.stringify({ results }, null, 2));
