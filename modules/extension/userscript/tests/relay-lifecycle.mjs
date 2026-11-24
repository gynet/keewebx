// Actual routing-page cleanup with native auxiliary windows and service workers.
// No script manager, vault, credentials or accelerated timers are involved.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const output = resolve(process.env.KWX_RELAY_LIFECYCLE_OUTPUT || mkdtempSync(join(tmpdir(), 'kwx-relay-lifecycle-')));
const engines = (process.env.KWX_RELAY_BROWSERS || 'chromium,webkit').split(',');
const assets = resolve(process.env.KWX_RELAY_ASSETS || join(root, 'dist/connect-port'));
const report = { nativeIOSVerified: false, assets, checks: [], passed: false };
mkdirSync(output, { recursive: true });
const pem = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', '-', '-out', '-', '-days', '1', '-subj', '/CN=localhost'], { stdio: ['ignore', 'pipe', 'ignore'] });
let origin;
const server = createServer({ key: pem, cert: pem }, (request, response) => {
    const path = new URL(request.url, 'https://localhost').pathname;
    if (path === '/website') {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        response.end('<!doctype html><button id="open">Connect</button><script>window.replies=[];addEventListener("message",event=>replies.push(event.data));document.querySelector("button").onclick=()=>window.open(window.helperURL,"_blank");</script>');
        return;
    }
    const file = path.startsWith('/connect-port/') ? path.slice('/connect-port/'.length) : '';
    if (!['relay.html', 'relay.js', 'worker.js'].includes(file)) { response.writeHead(404).end(); return; }
    const body = readFileSync(join(assets, file));
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'application/javascript' : 'text/html', 'cache-control': 'no-store' });
    response.end(body);
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const port = server.address().port;
origin = `https://localhost:${port}`;
let browser;
try {
    for (const engine of engines) {
        if (!['chromium', 'webkit'].includes(engine)) throw new Error('Unsupported relay test browser');
        browser = await ({ chromium, webkit })[engine].launch({ headless: true,
            ...(engine === 'chromium' ? { args: ['--ignore-certificate-errors'] } : {}) });
        for (const scenario of ['closed opener', 'abandoned startup']) {
            const context = await browser.newContext({ ignoreHTTPSErrors: true });
            try {
                // Observe the real trusted capability acknowledgement, not a mocked controller.
                await context.addInitScript(() => {
                    window.workerReady = false;
                    navigator.serviceWorker?.addEventListener('message', event => {
                        if (event.isTrusted && event.source === navigator.serviceWorker.controller &&
                            event.data?.kind === 'relay-capabilities' && event.data.protocol === 'handoff-owner-v1') window.workerReady = true;
                    });
                });
                const website = await context.newPage();
                await website.goto(`https://127.0.0.1:${port}/website`);
                const nonce = randomUUID(), url = new URL('/connect-port/relay.html', origin);
                url.searchParams.set('site', new URL(website.url()).origin);
                url.searchParams.set('nonce', nonce); url.searchParams.set('endpoint', origin + '/app');
                await website.evaluate(value => { window.helperURL = value; }, url.href);
                const opened = context.waitForEvent('page');
                await website.locator('#open').click();
                const helper = await opened;
                await helper.waitForFunction(() => window.workerReady, undefined, { timeout: 8000 });
                expect(helper.isClosed()).toBe(false);
                if (scenario === 'closed opener') await website.close();
                const started = Date.now();
                await expect.poll(() => helper.isClosed(), { timeout: scenario === 'closed opener' ? 2500 : 14000,
                    message: `${engine}: ${scenario} must self-close without caller close()` }).toBe(true);
                if (scenario === 'abandoned startup') {
                    const errors = await website.evaluate(() => window.replies.filter(reply => reply.kind === 'error'));
                    expect(errors).toHaveLength(1);
                    expect(errors[0]).toMatchObject({ kind: 'error', code: 'timeout', nonce, connectionId: '' });
                }
                const check = { engine, scenario, passed: true, milliseconds: Date.now() - started };
                report.checks.push(check); process.stdout.write(JSON.stringify(check) + '\n');
            } finally { await context.close(); }
        }
        await browser.close(); browser = undefined;
    }
    report.passed = true;
} catch (error) {
    report.failure = String(error?.stack || error);
    process.exitCode = 1;
} finally {
    await browser?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ report: join(output, 'report.json'), passed: report.passed, failure: report.failure }) + '\n');
}
