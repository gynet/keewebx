// Real Chromium/WebKit SW + MessagePort routing acceptance, using source assets.
// The App and website are synthetic metadata/ping fixtures: no credentials, vault,
// userscript manager, signed handshake or production UI acceptance is exercised.
// The fixture's opener sends relay-complete only after its synthetic port-ready.
// No browser clocks or production deadlines are changed. Native iOS is unverified.
// KWX_HELPER_ASSETS=/path/to/connect-port overrides all three production assets.
// KWX_HELPER_WORKER=/path/to/worker.js overrides only the worker source file.
// Baseline: export ALL THREE assets from 26344ba (old relay capability + worker),
// then run with KWX_HELPER_ASSETS pointing there; both close cases must fail with
// helper-unavailable. A new relay paired with the old worker is NOT this control.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const assets = resolve(process.env.KWX_HELPER_ASSETS || join(root, 'modules/ui/connect-port'));
const output = resolve(process.env.KWX_HELPER_OUTPUT || mkdtempSync(join(tmpdir(), 'kwx-helper-lifetime-')));
const engines = (process.env.KWX_HELPER_BROWSERS || 'chromium,webkit').split(',');
const sources = Object.fromEntries(['relay.html', 'relay.js', 'worker.js'].map(name => {
    const path = name === 'worker.js' && process.env.KWX_HELPER_WORKER
        ? resolve(process.env.KWX_HELPER_WORKER) : join(assets, name);
    const body = readFileSync(path);
    return [name, { path, body, sha256: createHash('sha256').update(body).digest('hex') }];
}));
const report = {
    scope: 'Synthetic App metadata/ping routing acceptance; not credential E2E or UI/signed-handshake acceptance',
    nativeIOSVerified: false, credentialE2E: false, productionUIHandshakeVerified: false,
    assets: Object.fromEntries(Object.entries(sources).map(([name, { path, sha256 }]) => [name, { path, sha256 }])),
    checks: [], passed: false
};
mkdirSync(output, { recursive: true });

function appFixture() {
    const MARK = 'keewebx-connect-port-v1';
    const params = new URL(location.href).searchParams;
    const appBoot = params.get('boot'), token = params.get('token');
    const endpoint = location.origin + '/app';
    const held = [];
    window.fixture = { probes: [], attachments: [], pings: [], released: false };
    function reply(event) {
        const data = { marker: MARK, kind: 'app-ready', appBoot, endpoint, traceId: event.data.traceId };
        // Both real discovery transports are supported by the production worker.
        event.ports[0]?.postMessage(data);
        if (event.data.replyViaWorker) event.source.postMessage(data);
    }
    window.releaseDiscovery = () => {
        window.fixture.released = true;
        for (const event of held.splice(0)) reply(event);
    };
    navigator.serviceWorker.addEventListener('message', event => {
        if (!event.isTrusted || event.source?.scriptURL !== location.origin + '/connect-port/worker.js' ||
            event.data?.marker !== MARK) return;
        if (event.data.kind === 'find-app') {
            window.fixture.probes.push({ traceId: event.data.traceId, at: Date.now(), ports: event.ports.length });
            if (event.ports[0]) {
                event.ports[0].onmessage = message => {
                    if (message.data?.kind === 'probe-done') event.ports[0].close();
                };
                event.ports[0].start();
            }
            if (window.fixture.released) reply(event);
            else held.push(event);
        } else if (event.data.kind === 'attach-port') {
            window.fixture.attachments.push({ ...event.data, ports: event.ports.length, at: Date.now() });
            const port = event.ports[0];
            if (!port) return;
            port.onmessage = message => {
                if (message.data?.kind !== 'fixture-ping') return;
                window.fixture.pings.push(message.data);
                port.postMessage({ kind: 'fixture-pong', appBoot, token, id: message.data.id });
            };
            port.start();
            port.postMessage({ kind: 'fixture-port-ready', appBoot, token, connectionId: event.data.connectionId });
        }
    });
}

function websiteFixture() {
    const MARK = 'keewebx-connect-port-v1';
    window.fixture = { sent: 0, portMessages: [], windowErrors: [], completions: 0 };
    document.querySelector('button').onclick = () => { window.helper = window.open(window.config.url, '_blank'); };
    window.addEventListener('message', event => {
        const config = window.config;
        if (!config || !event.isTrusted || event.source !== window.helper || event.origin !== config.origin ||
            event.data?.marker !== MARK || event.data.nonce !== config.nonce) return;
        if (event.data.kind === 'error') window.fixture.windowErrors.push(event.data);
        if (event.data.kind !== 'relay-ready' || window.fixture.sent) return;
        const channel = new MessageChannel();
        window.websitePort = channel.port1;
        channel.port1.onmessage = message => {
            window.fixture.portMessages.push(message.data);
            if (message.data?.kind === 'fixture-port-ready' && !window.helper.closed) {
                // Synthetic completion only: this does not stand in for or prove
                // production signed authentication or the user's consent flow.
                window.helper.postMessage({ marker: MARK, kind: 'relay-complete', nonce: config.nonce,
                    connectionId: config.connectionId, endpoint: config.endpoint }, config.origin);
                window.fixture.completions++;
            }
        };
        channel.port1.start();
        window.fixture.sent++;
        window.fixture.attachedAt = Date.now();
        window.helper.postMessage({ marker: MARK, kind: 'attach', nonce: config.nonce,
            appBoot: config.appBoot, connectionId: config.connectionId, endpoint: config.endpoint,
            siteOrigin: location.origin }, config.origin, [channel.port2]);
    });
}

const pem = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', '-', '-out', '-', '-days', '1', '-subj', '/CN=localhost'], { stdio: ['ignore', 'pipe', 'ignore'] });
const server = createServer({ key: pem, cert: pem }, (request, response) => {
    const path = new URL(request.url, 'https://localhost').pathname;
    if (path === '/app' || path === '/website') {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        const fixture = path === '/app' ? appFixture : websiteFixture;
        response.end(`<!doctype html><title>Synthetic routing fixture</title><button>Connect</button><script>(${fixture.toString()})();</script>`);
        return;
    }
    const file = path.startsWith('/connect-port/') ? path.slice('/connect-port/'.length) : '';
    const source = Object.hasOwn(sources, file) && sources[file];
    if (!source) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'application/javascript' : 'text/html', 'cache-control': 'no-store' });
    response.end(source.body);
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const origin = `https://localhost:${server.address().port}`;
let browser;
try {
    for (const engine of engines) {
        if (!['chromium', 'webkit'].includes(engine)) throw new Error('Unsupported helper test browser');
        browser = await ({ chromium, webkit })[engine].launch({ headless: true,
            ...(engine === 'chromium' ? { args: ['--ignore-certificate-errors'] } : {}) });
        for (const scenario of ['normal self-close', 'close during first probe', 'close before second round; resume at 10s']) {
            const context = await browser.newContext({ ignoreHTTPSErrors: true });
            const check = { engine, scenario, passed: false };
            let app, website;
            try {
                const appBoot = randomUUID(), token = randomUUID(), nonce = randomUUID(), connectionId = randomUUID();
                const endpoint = origin + '/app';
                app = await context.newPage();
                await app.goto(`${endpoint}?boot=${appBoot}&token=${token}`);
                website = await context.newPage();
                await website.goto(`https://127.0.0.1:${server.address().port}/website`);
                const url = new URL('/connect-port/relay.html', origin);
                url.searchParams.set('site', new URL(website.url()).origin);
                url.searchParams.set('nonce', nonce); url.searchParams.set('endpoint', endpoint);
                await website.evaluate(config => { window.config = config; }, { url: url.href, origin, nonce, appBoot, connectionId, endpoint });
                const opened = context.waitForEvent('page');
                await website.locator('button').click();
                const helper = await opened;
                // A trusted SW discovery event proves the real helper validated
                // the attachment and transferred the website port to the worker.
                await app.waitForFunction(() => window.fixture.probes.length > 0, undefined, { timeout: 8000 });
                const firstProbeAt = await app.evaluate(() => window.fixture.probes[0].at);
                expect(helper.isClosed()).toBe(false);
                expect(await app.evaluate(() => window.fixture.attachments.length)).toBe(0);
                if (scenario !== 'normal self-close') {
                    await helper.close(); // Actual native page destruction, not window.close interception.
                    expect(helper.isClosed()).toBe(true);
                    check.helperClosedAt = Date.now();
                }
                if (scenario.includes('second round')) {
                    // Hold public metadata replies through the real 8s first
                    // round, then resume at 10s inside the existing 16s budget.
                    await new Promise(resolve => setTimeout(resolve, Math.max(0, firstProbeAt + 10000 - Date.now())));
                }
                check.replyReleasedAfterMs = Date.now() - firstProbeAt;
                await app.evaluate(() => window.releaseDiscovery());
                await website.waitForFunction(() => window.fixture.portMessages.some(message =>
                    ['fixture-port-ready', 'error'].includes(message.kind)), undefined,
                { timeout: Math.max(1, firstProbeAt + 16000 - Date.now()) });
                const result = await website.evaluate(() => window.fixture);
                check.portErrors = result.portMessages.filter(message => message.kind === 'error');
                expect(check.portErrors, 'original website port must survive helper destruction').toEqual([]);
                expect(result.portMessages.filter(message => message.kind === 'fixture-port-ready')).toEqual([
                    { kind: 'fixture-port-ready', appBoot, token, connectionId }
                ]);
                const pingId = randomUUID();
                await website.evaluate(id => window.websitePort.postMessage({ kind: 'fixture-ping', id }), pingId);
                await website.waitForFunction(() => window.fixture.portMessages.some(message => message.kind === 'fixture-pong'), undefined, { timeout: 2500 });
                if (scenario === 'normal self-close') {
                    await expect.poll(() => helper.isClosed(), { timeout: 2500,
                        message: 'live helper must self-close after opener fixture completion' }).toBe(true);
                }
                // Allow queued duplicate deliveries to surface using real time.
                await new Promise(resolve => setTimeout(resolve, 250));
                const actualApp = await app.evaluate(() => window.fixture);
                const actualSite = await website.evaluate(() => window.fixture);
                expect(actualApp.attachments).toHaveLength(1);
                expect(actualApp.attachments[0]).toMatchObject({ appBoot, connectionId, endpoint,
                    siteOrigin: new URL(website.url()).origin, ports: 1 });
                expect(actualApp.attachments[0].handoffDeadline - actualApp.attachments[0].at).toBeGreaterThan(0);
                expect(actualApp.pings).toEqual([{ kind: 'fixture-ping', id: pingId }]);
                expect(actualSite.portMessages).toEqual([
                    { kind: 'fixture-port-ready', appBoot, token, connectionId },
                    { kind: 'fixture-pong', appBoot, token, id: pingId }
                ]);
                expect(actualSite.sent).toBe(1);
                expect(actualSite.windowErrors).toEqual([]);
                expect(actualSite.completions).toBe(scenario === 'normal self-close' ? 1 : 0);
                const rounds = new Set(actualApp.probes.map(probe => probe.traceId)).size;
                if (scenario.includes('second round')) {
                    expect(rounds).toBe(2);
                    expect(check.replyReleasedAfterMs).toBeGreaterThanOrEqual(10000);
                }
                check.discoveryRounds = rounds;
                check.attachments = actualApp.attachments.length;
                check.pings = actualApp.pings.length;
                check.pongs = actualSite.portMessages.filter(message => message.kind === 'fixture-pong').length;
                check.helperClosed = helper.isClosed();
                check.passed = true;
            } catch (error) {
                check.failure = String(error?.stack || error);
                check.app = app && !app.isClosed() ? await app.evaluate(() => window.fixture).catch(() => null) : null;
                check.website = website && !website.isClosed() ? await website.evaluate(() => window.fixture).catch(() => null) : null;
            } finally {
                report.checks.push(check);
                process.stdout.write(JSON.stringify(check) + '\n');
                await context.close();
            }
        }
        await browser.close(); browser = undefined;
    }
    report.passed = report.checks.length === engines.length * 3 && report.checks.every(check => check.passed);
} catch (error) {
    report.failure = String(error?.stack || error);
} finally {
    await browser?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ report: join(output, 'report.json'), passed: report.passed, failure: report.failure }) + '\n');
    if (!report.passed) process.exitCode = 1;
}
