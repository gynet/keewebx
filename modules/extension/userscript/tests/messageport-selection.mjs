// Synthetic selection races in the actual installer, with deferred GM storage.
// Usage: node messageport-selection.mjs [installer-path|-]; '-' reads stdin.
// KWX_PORT_POC_BROWSER=webkit selects WebKit; both use an isolated user world.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, expect } from '@playwright/test';

const installerPath = process.argv[2];
const installer = readFileSync(installerPath === '-' ? 0 : installerPath ||
    fileURLToPath(new URL('../keewebx-messageport-poc.user.js', import.meta.url)), 'utf8');
const browserName = process.env.KWX_PORT_POC_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName), 'Unsupported lab browser');
// Generate the disposable certificate in memory; no build or fixture files needed.
const pem = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', '-', '-out', '-', '-days', '1', '-subj', '/CN=localhost'],
{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const server = createServer({
    // TLS selects the appropriate section from the ephemeral combined PEM.
    key: pem, cert: pem
}, (request, response) => {
    const worker = request.url === '/connect-port-poc/worker.js';
    response.setHeader('content-type', worker ? 'application/javascript' : 'text/html');
    response.setHeader('cache-control', 'no-store');
    // Only supply native SW provenance/port transfer. All receiver behavior is
    // executed by the unmodified installer, not reimplemented in this fixture.
    response.end(worker ? `
        self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
        self.addEventListener('message', event => {
            event.source.postMessage(event.data, [event.ports[0]]);
        });` : '<!doctype html><title>Synthetic selection fixture</title>');
});

let browser, context;
const errors = [];
try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'https://localhost:' + server.address().port;
    const appURL = origin + '/app';
    assert.ok(installer.includes("const APP_URL = 'https://keewebx.app/app';"), 'Installer endpoint substitution failed');
    const bundle = installer.replace("const APP_URL = 'https://keewebx.app/app';", `const APP_URL = '${appURL}';`);
    browser = await ({ chromium, webkit }[browserName]).launch({ headless: true,
        ...(browserName === 'chromium' ? { channel: 'chromium', args: ['--no-sandbox', '--ignore-certificate-errors'] } : {}),
        ...(process.env.KWX_BROWSER_PROXY ? { proxy: { server: process.env.KWX_BROWSER_PROXY } } : {}) });
    context = await browser.newContext({ ignoreHTTPSErrors: true });

    async function fixture() {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(appURL);
        // Same utility-world mechanism as the WebKit MessagePort acceptance test.
        const isolated = await page._connection.toImpl(page).mainFrame()._utilityContext();
        const evaluate = expression => isolated.evaluateExpression(expression, { isFunction: false });
        await evaluate(`(() => {
            const f = globalThis.selectionFixture = {
                selected: undefined, deferReads: false, deferWrites: false, reads: [], writes: []
            };
            const GM = {
                async getValue() {
                    const snapshot = structuredClone(f.selected);
                    if (!f.deferReads) return snapshot;
                    return new Promise(resolve => f.reads.push(() => resolve(snapshot)));
                },
                async setValue(key, value) {
                    const commit = () => { f.selected = structuredClone(value); };
                    if (!f.deferWrites) { commit(); return; }
                    return new Promise(resolve => f.writes.push(() => { commit(); resolve(); }));
                }
            };
            ${bundle}
        })()`);
        const host = page.locator('#keewebx-port-poc');
        await host.getByRole('button', { name: 'Port Lab', exact: true }).click();
        const enable = host.getByRole('button', { name: 'Enable test receiver', exact: true });
        const disable = host.getByRole('button', { name: 'Disable receiver', exact: true });
        const details = host.locator('[data-role="details"]');
        // Resolve the GM operation and drain its async continuations before assertions.
        const settle = expression => evaluate(`(async () => {
            ${expression}; await new Promise(resolve => setTimeout(resolve, 0));
        })()`);
        async function send(kind, appBoot) {
            return page.evaluate(async ({ kind, appBoot }) => {
                const registration = await navigator.serviceWorker.register('/connect-port-poc/worker.js');
                const worker = registration.installing || registration.waiting || registration.active;
                if (worker.state !== 'activated') await new Promise(resolve => worker.addEventListener('statechange',
                    () => { if (worker.state === 'activated') resolve(); }));
                const channel = new MessageChannel(), connectionId = crypto.randomUUID();
                const marker = 'keewebx-port-lab-v1';
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Native receiver response timed out')); }, 3000);
                    channel.port1.onmessage = event => {
                        clearTimeout(timer);
                        if (kind === 'attach-port') {
                            globalThis.selectionPeer = { port: channel.port1, connectionId, appBoot };
                        } else {
                            channel.port1.postMessage({ marker, kind: 'probe-done' });
                            channel.port1.close();
                        }
                        resolve(event.data);
                    };
                    registration.active.postMessage({ marker, kind, appBoot, connectionId,
                        siteOrigin: 'https://synthetic.example' }, [channel.port2]);
                });
            }, { kind, appBoot });
        }
        async function ping() {
            const response = await page.evaluate(() => new Promise((resolve, reject) => {
                const peer = globalThis.selectionPeer, sequence = crypto.randomUUID();
                const timer = setTimeout(() => reject(new Error('Attached port stopped answering after selection refresh')), 3000);
                peer.port.onmessage = event => {
                    if (event.data.sequence !== sequence) return;
                    clearTimeout(timer); resolve(event.data);
                };
                peer.port.postMessage({ marker: 'keewebx-port-lab-v1', kind: 'ping',
                    connectionId: peer.connectionId, sequence });
            }));
            assert.equal(response.kind, 'pong');
            assert.equal(response.appBoot, await evaluate('selectionFixture.selected.appBoot'));
        }
        return { page, evaluate, settle, enable, disable, details, send, ping };
    }

    const cases = [
        ['stale focus refresh after re-enable preserves receiver and attached port', async f => {
            await f.enable.click();
            await expect(f.details).toContainText('Receiver enabled');
            await f.evaluate(`selectionFixture.selected = {
                origin: location.origin, appBoot: '22222222-2222-4222-8222-222222222222'
            }; selectionFixture.deferWrites = true`);
            await f.enable.click();
            assert.equal(await f.evaluate('selectionFixture.writes.length'), 1);
            // Invoke the actual focus listener deterministically while the enable
            // write is pending. This read snapshots the previous receiver selection.
            await f.evaluate(`selectionFixture.deferReads = true;
                window.dispatchEvent(new Event('focus'))`);
            assert.equal(await f.evaluate('selectionFixture.reads.length'), 1);
            await f.settle('selectionFixture.writes.shift()()');
            await expect(f.details).toContainText('Receiver enabled');
            const boot = await f.evaluate('selectionFixture.selected.appBoot');
            assert.equal((await f.send('attach-port', boot)).kind, 'ready');
            await expect(f.details).toContainText('1 attached port(s)');
            await f.ping();
            await f.settle('selectionFixture.reads.shift()()');
            // Both assertions matter: retaining the label alone cannot prove that
            // the stale continuation did not close the already attached endpoint.
            await expect(f.details).toContainText('Receiver enabled');
            await expect(f.details).toContainText('1 attached port(s)');
            await f.ping();
        }],
        ['disable during pending enable prevents receiver resurrection', async f => {
            await f.evaluate('selectionFixture.deferWrites = true');
            await f.enable.click();
            assert.equal(await f.evaluate('selectionFixture.writes.length'), 1);
            await f.disable.click();
            await f.settle('selectionFixture.writes.shift()()');
            await expect(f.details).toContainText('Receiver disabled');
            const boot = await f.evaluate('selectionFixture.selected.appBoot');
            const response = await f.send('find-app', boot);
            assert.equal(response.kind, 'app-state');
            assert.equal(response.state, 'disabled');
        }]
    ];
    for (const [name, run] of cases) {
        let f;
        try {
            f = await fixture(); await run(f);
            console.log(`PASS ${browserName}: ${name}`);
        } catch (error) {
            process.exitCode = 1;
            console.error(`FAIL ${browserName}: ${name}\n${error.stack || error}`);
        } finally { await f?.page.close(); }
    }
    assert.deepEqual(errors, [], 'Browser errors');
} finally {
    await context?.close(); await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
