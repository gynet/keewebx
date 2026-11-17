// Acceptance against the built installer; no product internals are replaced.
// Repro: bun modules/extension/userscript/build-connect.ts
//       node modules/extension/userscript/tests/diagnostics.mjs [chromium webkit]
// Defaults to both desktop engines and both callback/Promise GM HTTP transports.
// This simulates a userscript manager in the main world; it is NOT native iOS
// or real Userscripts extension certification. HTTPS pages and HTTP responses
// are fixtures; native postMessage, timers, closed shadows and clicks are real.
// KWX_DIAGNOSTICS_OUTPUT defaults to a new directory outside the repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium, webkit } = require('@playwright/test');
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit'];
assert(engines.every(name => ['chromium', 'webkit'].includes(name)), 'Use chromium and/or webkit');
const BUN = process.env.KWX_BUN || 'bun';
const OUT = path.resolve(process.env.KWX_DIAGNOSTICS_OUTPUT || await mkdtemp(path.join(os.tmpdir(), 'keewebx-diagnostics-')));
const outputRelative = path.relative(ROOT, OUT);
assert(outputRelative === '..' || outputRelative.startsWith('..' + path.sep) || path.isAbsolute(outputRelative), 'Write reports outside the repository');
await mkdir(OUT, { recursive: true });
const APP = 'https://keewebx.app/app';
const WEBSITE = 'https://login.example.org/login';
const SECOND = 'https://signin.example.net/login';
const MARK = 'keewebx-connect-diagnostics-v1';
const KEY = 'keewebx-connect-diagnostics-session-v1';
const REVOCATION_KEY = KEY + ':revocation';
const CHECKBOX = '[data-action="diagnostics-enabled"]';
const DIAGNOSTIC_STATUS = '[data-role="remote-diagnostics-status"]';
const LABEL = 'Enable remote diagnostics for 1 hour';
const POLL_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRETS = ['fixture-username-never-send', 'fixture-password-never-send', 'raw-error-never-send', 'fixture-vault-password-never-send'];
const installer = await readFile(path.join(ROOT, 'modules/extension/userscript/keewebx-connect.user.js'), 'utf8');
const version = (await readFile(path.join(ROOT, 'modules/extension/userscript/src/version.ts'), 'utf8')).match(/CONNECT_VERSION\s*=\s*'([^']+)'/)[1];
assert.equal(installer.match(/@version\s+(\S+)/)?.[1], version, 'Rebuild the current installer before running');
assert(installer.includes('/api/connect-diagnostics/'), 'Installer must contain the actual diagnostics adapter');

// Bundle the real vault emitter and adapter export separately for narrowly
// scoped boundary checks. Installer scenarios never use this adapter handle.
const fixtureSource = `
import { startConnectDiagnostics, recordConnectDiagnostic } from ${JSON.stringify(path.join(ROOT, 'modules/vault/src/comp/extension/diagnostic-events.ts'))};
import { diagnosticRequest } from ${JSON.stringify(path.join(ROOT, 'modules/extension/userscript/src/diagnostics.ts'))};
globalThis.__diagnosticBoundaryRequest = diagnosticRequest;
if (location.href === ${JSON.stringify(APP)}) {
  startConnectDiagnostics(() => ({ live: true, locked: false, hasPort: false, pending: 0, authorization: 0 }));
  globalThis.__emitVaultDiagnostic = (code, data) => recordConnectDiagnostic(code, data);
}`;
const fixtureBundle = execFileSync(BUN, ['-e', `
const result = await Bun.build({entrypoints:['diagnostics-browser-fixture'],target:'browser',format:'iife',
 plugins:[{name:'fixture',setup(build){
 build.onResolve({filter:/^diagnostics-browser-fixture$/},()=>({path:'entry',namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:${JSON.stringify(fixtureSource)},loader:'ts',resolveDir:${JSON.stringify(ROOT)}}));
 }}]});
if(!result.success) throw new AggregateError(result.logs,'Diagnostic browser fixture build failed');
await Bun.write(Bun.stdout,await result.outputs[0].text());
`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

const report = {
    started: new Date().toISOString(), version,
    installerSha256: createHash('sha256').update(installer).digest('hex'),
    scope: 'Built installer, desktop Chromium and WebKit, simulated GM manager in main world, HTTPS fixture pages and fake diagnostic HTTP server; real closed ShadowRoot and trusted browser clicks; actual bundled vault diagnostic-events module',
    nativeIOSVerified: false, realUserscriptManagerVerified: false, realBackendVerified: false,
    pollMs: POLL_MS, viewport: { width: 390, height: 844 }, runs: [],
};

async function until(read, accept, message, timeout = 14000) {
    const start = Date.now();
    let value;
    do {
        value = await read();
        if (accept(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() - start < timeout);
    assert.fail(`${message}; last value: ${JSON.stringify(value)}`);
}

async function shadow(page, selector, property = 'textContent') {
    return page.evaluate(({ selector, property }) => {
        const root = window.__diagnosticFixture.roots.find(root => root.host.id === 'keewebx-userscript-connect');
        return root?.querySelector(selector)?.[property] ?? null;
    }, { selector, property });
}

async function click(page, selector) {
    await page.bringToFront();
    const element = (await page.evaluateHandle(selector => {
        const root = window.__diagnosticFixture.roots.find(root => root.host.id === 'keewebx-userscript-connect');
        return root?.querySelector(selector);
    }, selector)).asElement();
    assert(element, `Missing closed-shadow control ${selector}`);
    try {
        assert.equal(await element.isVisible(), true, `Control is visible: ${selector}`);
        await element.click({ timeout: 10000 });
    } finally { await element.dispose(); }
}

async function focus(page) {
    await page.bringToFront();
    // Playwright focus emulation differs by engine. Explicitly wake the actual
    // adapter's focus listener; all UI input uses trusted browser clicks.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

async function diagnostics(page, enabled) {
    await until(() => shadow(page, CHECKBOX, 'disabled'), value => value === false, 'Diagnostics control must settle');
    if (await shadow(page, CHECKBOX, 'checked') !== enabled) await click(page, CHECKBOX);
    await until(() => shadow(page, CHECKBOX, 'checked'), value => value === enabled, `Diagnostics checkbox ${enabled}`);
    await until(() => shadow(page, CHECKBOX, 'disabled'), value => value === false, 'Diagnostics control must be usable');
}

// This allowlist is intentionally independent of the production sanitizer.
const booleanFields = new Set(['locked', 'authorized', 'authorizing', 'selected', 'live', 'direct', 'hasSession', 'hasPort', 'online', 'visible', 'persisted']);
const numberFields = new Set(['elapsedMs', 'pending', 'ports', 'authorization', 'runtimeCount']);
const uuidFields = new Set(['traceId', 'portId']);
const enums = {
    layer: ['userscript', 'app', 'website', 'worker'],
    state: ['Initializing', 'ReadyToConnect', 'Connecting', 'Connected', 'Error'],
    action: ['open', 'authorize', 'revoke', 'lookup', 'probe', 'save', 'close'],
    stage: ['connect', 'access', 'lookup', 'fields', 'fill', 'test', 'authorize', 'restore'],
    event: ['receiver-ready', 'discovery', 'discovery-reply', 'discovery-timeout', 'handoff', 'port-ready', 'hello-received', 'hello-replied', 'wire-received', 'wire-replied', 'wire-error', 'receipt', 'suppressed', 'unavailable',
        'discovery-received', 'discovery-sent', 'discovery-rejected', 'port-received', 'port-rejected',
        'rpc-sent', 'rpc-received', 'rpc-accepted', 'rpc-rejected', 'runtime-duplicate'],
    reason: ['timeout', 'locked', 'canceled', 'unavailable', 'changed', 'other'],
    detail: ['wrong-source', 'wrong-address', 'wrong-host', 'wrong-origin', 'wrong-generation',
        'wrong-port', 'wrong-shape', 'bad-signature', 'no-pending', 'expired', 'closed',
        'not-selected', 'duplicate-runtime', 'legacy', 'matched'],
};
const eventCodes = new Set(['session.started', 'session.stopped', 'page.visible', 'page.hidden', 'page.show', 'page.hide', 'connect.state', 'connect.action', 'connect.stage', 'connect.error', 'app.locked', 'app.unlocked', 'app.receiver', 'transport.event', 'command.result']);
function safeData(data) {
    assert(data && typeof data === 'object' && !Array.isArray(data), 'Diagnostic data must be a flat object');
    for (const [key, value] of Object.entries(data)) {
        assert(['string', 'boolean', 'number'].includes(typeof value), `Primitive-only diagnostic field: ${key}`);
        if (booleanFields.has(key)) assert.equal(typeof value, 'boolean');
        else if (numberFields.has(key)) {
            assert.equal(typeof value, 'number');
            assert(Number.isFinite(value) && value >= 0 && value <= (key === 'elapsedMs' ? 3600000 : key === 'runtimeCount' ? 32 : 10000));
            if (key !== 'elapsedMs') assert(Number.isInteger(value));
        } else if (uuidFields.has(key)) {
            assert.equal(typeof value, 'string');
            assert.equal(value.length, 36);
            assert.match(value, UUID);
        } else assert(enums[key]?.includes(value), `Unknown diagnostic key/value: ${key}`);
    }
}

async function run(engine, transportMode) {
    const result = { engine, transportMode, cases: [], pageErrors: [], screenshots: [] };
    report.runs.push(result);
    const browser = await { chromium, webkit }[engine].launch({ headless: true });
    const context = await browser.newContext({ viewport: report.viewport, serviceWorkers: 'block' });
    context.setDefaultTimeout(10000);
    const store = new Map(), tabs = new WeakMap(), queues = new Map(), sessions = new Map();
    const requests = [], aborts = [], writes = [], pending = [], pendingCreations = [];
    let offline = false, holdClient, holdCreationPage;
    const clone = value => value === undefined ? undefined : structuredClone(value);
    const exchangeRequests = () => requests.filter(request => request.path.endsWith('/exchange'));
    const allEvents = () => exchangeRequests().flatMap(request => request.body.events);
    const allResults = () => exchangeRequests().flatMap(request => request.body.results);
    const step = async (name, work) => {
        const started = Date.now();
        try {
            const detail = await work();
            result.cases.push({ name, passed: true, milliseconds: Date.now() - started, ...detail });
            console.log(`${engine}/${transportMode}: PASS ${name}`);
        } catch (error) {
            result.cases.push({ name, passed: false, milliseconds: Date.now() - started, error: error.stack || String(error) });
            throw error;
        }
    };
    const queue = (client, commands) => queues.set(client, [...(queues.get(client) || []), ...commands]);
    const command = (client, kind, extra = {}) => ({ id: randomUUID(), kind, target: client, issuedAt: Date.now(), expiresAt: Date.now() + 55000, ...extra });
    await context.exposeBinding('__diagnosticGM', async ({ page }, operation, key, value) => {
        if (operation === 'get') return clone(store.get(key));
        if (operation === 'set') { store.set(key, clone(value)); writes.push({ operation, key }); return; }
        if (operation === 'delete') { store.delete(key); writes.push({ operation, key }); return; }
        if (operation === 'list') return [...store.keys()];
        if (operation === 'getTab') return clone(tabs.get(page) || {});
        if (operation === 'saveTab') { tabs.set(page, clone(value)); return; }
        if (operation === 'abort') { aborts.push(key); return; }
        assert.equal(operation, 'http', 'Unexpected GM fixture operation');
        const request = { ...key, body: JSON.parse(key.data), path: new URL(key.url).pathname, at: Date.now(), page: page.url() };
        delete request.data;
        requests.push(request);
        if (offline) { request.failed = true; return { error: SECRETS[2] + ': ' + WEBSITE }; }
        assert.equal(request.method, 'POST');
        assert.equal(new URL(request.url).origin, 'https://keewebx.app');
        assert.equal(request.anonymous, true);
        assert.equal(request.timeout, 8000);
        assert.equal(request.headers['Content-Type'], 'application/json');
        let body;
        if (request.path === '/api/connect-diagnostics/session') {
            assert.deepEqual(request.body, {});
            assert.equal(request.headers.Authorization, undefined);
            body = { id: randomUUID(), token: 'fixture-upload-token-' + randomUUID(), expiresAt: Date.now() + 3600000 };
            sessions.set(body.id, body);
            if (holdCreationPage === request.page) {
                holdCreationPage = undefined;
                return await new Promise(resolve => pendingCreations.push({ request, body, resolve }));
            }
        } else {
            assert.match(request.path, /^\/api\/connect-diagnostics\/[a-f0-9-]{36}\/exchange$/);
            const session = sessions.get(request.path.split('/')[3]);
            assert(session, 'Exchange uses a created session');
            assert.equal(request.headers.Authorization, `Bearer ${session.token}`);
            assert.deepEqual(Object.keys(request.body).sort(), ['client', 'source', 'version', 'events', 'results'].sort());
            assert.match(request.body.client, UUID);
            assert.equal(request.body.source, request.page === APP ? 'app' : 'website');
            assert.equal(request.body.version, version);
            assert(Array.isArray(request.body.events) && Array.isArray(request.body.results));
            body = { expiresAt: session.expiresAt, commands: (queues.get(request.body.client) || []).splice(0, 32) };
            if (holdClient === request.body.client) {
                holdClient = undefined;
                return await new Promise(resolve => pending.push({ request, body, resolve }));
            }
        }
        return { status: 200, responseText: JSON.stringify(body), finalUrl: request.url };
    });
    await context.addInitScript(({ transportMode, mark, app }) => {
        const fixture = window.__diagnosticFixture = { roots: [], messages: [], clicks: [], wire: [], transportMode };
        const attach = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (options) {
            const root = attach.call(this, options);
            fixture.roots.push(root);
            root.addEventListener('click', event => fixture.clicks.push({ trusted: event.isTrusted, action: event.target?.dataset?.action || '' }), true);
            return root;
        };
        window.__remoteCommandExecuted = false;
        window.addEventListener('message', event => {
            if (event.source !== window) return;
            if (event.data?.kwDiagnostics === mark) fixture.messages.push(event.data);
            if (event.data?.kwConnect) fixture.wire.push(event.data.kwConnect);
            if (location.href === app && event.data?.kwConnect === 'get-state') {
                window.postMessage({ kwConnect: 'state', action: 'database-locked' }, location.origin);
            }
        });
        const invoke = (operation, key, value) => window.__diagnosticGM(operation, key, value);
        window.GM = {
            info: { scriptHandler: 'Desktop acceptance fixture' },
            getValue: key => invoke('get', key), setValue: (key, value) => invoke('set', key, value),
            deleteValue: key => invoke('delete', key), listValues: () => invoke('list'),
            getTab: () => invoke('getTab'), saveTab: value => invoke('saveTab', undefined, value),
            xmlHttpRequest(options) {
                const id = crypto.randomUUID();
                const wire = { id, method: options.method, url: options.url, headers: options.headers, data: options.data, timeout: options.timeout, anonymous: options.anonymous };
                // Deliberately deliver late callback/Promise replies even after abort:
                // the production adapter and client must guard cancellation.
                const response = invoke('http', wire).then(reply => {
                    if (reply.error) throw new Error(reply.error);
                    return reply;
                });
                let aborted = false;
                const abort = () => {
                    if (aborted) return;
                    aborted = true;
                    void invoke('abort', id); options.onabort?.();
                };
                if (transportMode === 'promise') {
                    response.abort = abort; // Userscripts' abortable-Promise API.
                    return response;
                }
                response.then(reply => options.onload?.(reply), error => options.onerror?.(error));
                return { abort };
            },
        };
    }, { transportMode, mark: MARK, app: APP });
    const pages = [];
    context.on('page', page => {
        page.on('pageerror', error => result.pageErrors.push(error.message));
    });
    const open = async url => {
        const page = await context.newPage();
        pages.push(page);
        await page.route('**/*', route => {
            if (route.request().isNavigationRequest() && route.request().url() === url) {
                return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diagnostics acceptance</title>
<style>body{font:16px system-ui;margin:24px;background:#f1f5f9;color:#10223b}h1{font-size:24px}label,input{display:block}input{box-sizing:border-box;width:285px;max-width:100%;padding:12px;margin:8px 0 18px}button{padding:12px}p{line-height:1.5}</style></head><body>${url === APP ? '<main class="vault"><h1>KeeWebX App</h1><p>Passive locked protocol fixture.</p></main>' : '<main><h1>Sign in</h1><form><label for="username">Username</label><input id="username" autocomplete="username"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password"><button type="button">Sign in</button></form></main>'}</body></html>` });
            }
            return route.abort();
        });
        await page.goto(url);
        await page.addScriptTag({ content: fixtureBundle });
        await page.addScriptTag({ content: installer });
        await until(() => shadow(page, '[data-role="version"]'), value => value === `Connect ${version}`, 'Built installer starts');
        assert.equal(await page.evaluate(() => document.getElementById('keewebx-userscript-connect').shadowRoot), null, 'Production root remains closed');
        await until(() => shadow(page, '[data-action="toggle"]', 'hidden'), value => value === false, 'App/login key is available');
        await click(page, '[data-action="toggle"]');
        await click(page, '[data-action="config-tab"]');
        return page;
    };
    let app, website, second;
    try {
        await step('independent allowlist accepts bounded metadata and rejects private or malformed fields', async () => {
            const uuid = randomUUID();
            safeData({ traceId: uuid, portId: uuid.toUpperCase(), runtimeCount: 32, event: 'rpc-rejected', detail: 'wrong-origin' });
            for (const [key, values] of Object.entries(enums)) {
                assert.equal(new Set(values).size, values.length);
                for (const value of values) safeData({ [key]: value });
                for (const value of [SECRETS[0], WEBSITE, 'unknown', values[0] + '\n']) {
                    assert.throws(() => safeData({ [key]: value }));
                }
            }
            for (const key of uuidFields) {
                for (const value of [SECRETS[0], WEBSITE, uuid + '\n', uuid.slice(1), uuid.slice(0, 14) + '0' + uuid.slice(15),
                    '00000000-0000-0000-0000-000000000000', 1, null, {}]) assert.throws(() => safeData({ [key]: value }));
            }
            for (const value of [0, 32]) safeData({ runtimeCount: value });
            for (const value of [-1, 33, 1.5, Infinity, NaN, '2', true, null, {}]) {
                assert.throws(() => safeData({ runtimeCount: value }));
            }
            for (const key of ['url', 'password', 'key', 'keys', 'username', 'token', 'message', 'stack', 'nested']) {
                assert.throws(() => safeData({ traceId: uuid, [key]: SECRETS[0] }));
            }
        });
        await step('default off: no network or App event collection across a real poll interval', async () => {
            app = await open(APP); website = await open(WEBSITE); second = await open(SECOND);
            for (const page of pages) {
                assert.equal(await shadow(page, CHECKBOX, 'checked'), false);
                assert.equal(await shadow(page, `label[for="${await shadow(page, CHECKBOX, 'id')}"]`), LABEL);
                assert.match(await shadow(page, DIAGNOSTIC_STATUS), /^Off\./);
                await page.evaluate(mark => {
                    window.__emitVaultDiagnostic?.('app.locked', { locked: true, authorization: 9473 });
                    window.postMessage({ kwDiagnostics: mark, kind: 'event', code: 'app.locked', data: { authorization: 9473 } }, location.origin);
                }, MARK);
            }
            await app.waitForTimeout(POLL_MS + 400);
            assert.equal(requests.length, 0);
            assert.equal(store.has(KEY), false);
            const emitted = await app.evaluate(() => window.__diagnosticFixture.messages.filter(message => message.kind === 'event' && message.data?.locked === true));
            assert.deepEqual(emitted, [], 'The real vault emitter collects nothing before opt-in');
            for (const page of [website, second]) {
                assert.equal(await page.locator('#username').inputValue(), '');
                assert.equal(await page.locator('#password').inputValue(), '');
            }
        });
        await step('trusted checkbox creates a one-hour support session and hides its token', async () => {
            await diagnostics(app, true);
            await until(() => exchangeRequests().length, value => value > 0, 'Opt-in starts actual HTTP exchange');
            const grant = store.get(KEY);
            assert.match(grant.id, UUID); assert.equal(typeof grant.token, 'string');
            assert.equal(grant.consentFence, store.get(REVOCATION_KEY) || 'initial');
            assert(grant.expiresAt > Date.now() + 3590000 && grant.expiresAt <= Date.now() + 3600000);
            assert.equal(requests.filter(request => request.path.endsWith('/session')).length, 1);
            assert.equal(await shadow(app, '[data-role="diagnostics-id"]'), grant.id);
            return { sessionLifetimeMs: grant.expiresAt - requests[0].at };
        });
        await step('App and two website documents adopt the same stored Support ID', async () => {
            for (const page of [website, second]) {
                await focus(page);
                await until(() => shadow(page, CHECKBOX, 'checked'), Boolean, 'Shared opt-in adopted on focus');
                assert.equal(await shadow(page, '[data-role="diagnostics-id"]'), store.get(KEY).id);
            }
            await until(() => new Set(exchangeRequests().map(request => request.body.client)).size, value => value === 3, 'Three actual clients exchange');
            assert.equal(requests.filter(request => request.path.endsWith('/session')).length, 1, 'Joining tabs do not create more sessions');
        });
        await step('actual vault emitter forwards safe App events only while enabled; hostile event data stripped', async () => {
            const traceId = randomUUID(), portId = randomUUID();
            await app.evaluate(({ mark, secrets, website, traceId, portId }) => {
                window.__emitVaultDiagnostic('app.unlocked', { locked: false, pending: 7, password: secrets[1], url: website });
                window.postMessage({ kwDiagnostics: mark, kind: 'event', code: 'app.receiver', data: {
                    traceId, portId, runtimeCount: 32, event: 'rpc-rejected', detail: 'wrong-origin',
                } }, location.origin);
                window.postMessage({ kwDiagnostics: mark, kind: 'event', code: 'app.locked', data: {
                    locked: true, authorization: 8123, username: secrets[0], password: secrets[1], url: website,
                    error: secrets[2], nested: { secret: secrets[3] }, token: 'hostile-token', state: secrets[2], pending: secrets[1], reason: website,
                    traceId: secrets[0], portId: website, runtimeCount: 33, detail: secrets[2], event: secrets[3],
                } }, location.origin);
                window.postMessage({ kwDiagnostics: mark, kind: 'event', code: 'arbitrary.event', data: { locked: true } }, location.origin);
            }, { mark: MARK, secrets: SECRETS, website: WEBSITE, traceId, portId });
            await until(allEvents, events => events.some(event => event.code === 'app.unlocked' && event.data.pending === 7)
                && events.some(event => event.code === 'app.locked' && event.data.authorization === 8123)
                && events.some(event => event.data.traceId === traceId), 'Real and malicious events uploaded after sanitizing');
            assert.deepEqual(allEvents().find(event => event.data.traceId === traceId).data, {
                traceId, portId, runtimeCount: 32, event: 'rpc-rejected', detail: 'wrong-origin', layer: 'app',
            });
            assert(allEvents().some(event => event.code === 'app.receiver' && event.data.layer === 'app'
                && event.data.live === true && event.data.locked === false && event.data.hasPort === false && event.data.pending === 0 && event.data.authorization === 0), 'Actual startConnectDiagnostics emitted receiver state');
            const hostile = allEvents().find(event => event.data.authorization === 8123);
            assert.deepEqual(hostile.data, { locked: true, authorization: 8123, layer: 'app' });
            assert(!allEvents().some(event => event.data.authorization === 9473), 'Disabled observations were never buffered');
            const emitted = await app.evaluate(() => window.__diagnosticFixture.messages.find(message => message.kind === 'event' && message.code === 'app.unlocked' && message.data.pending === 7));
            assert.deepEqual(emitted.data, { locked: false, pending: 7 }, 'Real vault module strips unknown fields before posting');
        });
        const clientByPage = () => Object.fromEntries(exchangeRequests().map(request => [request.page, request.body.client]));
        let accepted, rejected;
        await step('snapshot, ping and receiver-check close the HTTP command/result loop for every exact client', async () => {
            const clients = clientByPage();
            accepted = Object.values(clients).flatMap(client => ['snapshot', 'ping', 'receiver-check'].map(kind => command(client, kind)));
            const client = clients[APP], now = Date.now();
            rejected = [
                command(client, 'eval', { code: 'window.__remoteCommandExecuted = true' }),
                command(client, 'window.__remoteCommandExecuted = true'),
                command(client, 'snapshot', { code: 'window.__remoteCommandExecuted = true' }),
                command(client, 'snapshot', { target: randomUUID() }),
                command(client, 'snapshot', { id: 'invalid-command-id' }),
                command(client, 'snapshot', { issuedAt: now - 10000, expiresAt: now - 1 }),
                command(client, 'snapshot', { issuedAt: now + 30000, expiresAt: now + 50000 }),
                command(client, 'snapshot', { expiresAt: now + 61000 }),
                { id: randomUUID(), target: client, kind: 'ping', expiresAt: now + 50000 },
            ];
            for (const target of Object.values(clients)) queue(target, [...accepted.filter(value => value.target === target), ...(target === client ? rejected : [])]);
            await until(allResults, results => accepted.every(command => results.some(result => result.id === command.id)), 'Every valid command gets uploaded in a subsequent exchange', 22000);
            for (const command of accepted) {
                const requestsWithResult = exchangeRequests().filter(request => request.body.results.some(result => result.id === command.id));
                assert.equal(requestsWithResult.length, 1);
                assert.equal(requestsWithResult[0].body.client, command.target, 'Result comes only from its target client');
                const result = requestsWithResult[0].body.results.find(result => result.id === command.id);
                assert.deepEqual(Object.keys(result).sort(), ['id', 'kind', 'status', 'data'].sort());
                assert.equal(result.kind, command.kind); assert.equal(result.status, 'ok'); safeData(result.data);
                assert.equal(result.data.layer, requestsWithResult[0].page === APP ? 'userscript' : 'website');
            }
            return { validCommands: accepted.length, rejectedCommands: rejected.length };
        });
        await step('duplicate IDs remain inert across later polls; no eval or arbitrary commands accepted', async () => {
            const client = clientByPage()[APP];
            queue(client, accepted.filter(value => value.target === client));
            const before = exchangeRequests().filter(request => request.body.client === client).length;
            await until(() => exchangeRequests().filter(request => request.body.client === client).length, count => count >= before + 2, 'Duplicate delivery and following result exchange', 16000);
            for (const command of accepted) assert.equal(allResults().filter(result => result.id === command.id).length, 1);
            for (const command of rejected) assert(!allResults().some(result => result.id === command.id));
            for (const page of pages) assert.equal(await page.evaluate(() => window.__remoteCommandExecuted), false);
            const times = exchangeRequests().filter(request => request.body.client === client).map(request => request.at);
            assert(times.some((time, index) => index && time - times[index - 1] >= 4800 && time - times[index - 1] < 8000), 'Unmodified client polls at five seconds');
        });
        await step('390px App and website enabled screenshots; session token absent from all DOM', async () => {
            for (const [label, page] of [['app', app], ['website', website]]) {
                await page.bringToFront();
                const filename = `${engine}-${transportMode}-${label}-enabled-390.png`;
                await page.screenshot({ path: path.join(OUT, filename), fullPage: true, animations: 'disabled' });
                result.screenshots.push(filename);
            }
            for (const page of pages) {
                const dom = await page.evaluate(() => document.documentElement.outerHTML + window.__diagnosticFixture.roots.map(root => root.innerHTML).join(''));
                for (const session of sessions.values()) assert(!dom.includes(session.token), 'Upload token must never enter DOM, attributes or closed shadow');
                const clicks = await page.evaluate(() => window.__diagnosticFixture.clicks);
                assert(clicks.length && clicks.every(event => event.trusted), 'All checkbox/panel input was trusted');
            }
        });
        await step('disable deletes shared grant; other documents turn off on focus and stop all HTTP/results', async () => {
            await diagnostics(app, false);
            assert.equal(store.has(KEY), false);
            assert(writes.some(write => write.operation === 'delete' && write.key === KEY));
            for (const page of [website, second]) {
                await focus(page);
                await until(() => shadow(page, CHECKBOX, 'checked'), value => value === false, 'Other document sees revocation on focus');
            }
            const count = requests.length, resultCount = allResults().length;
            await app.evaluate(() => window.__emitVaultDiagnostic('app.locked', { locked: true, authorization: 9651 }));
            await app.waitForTimeout(POLL_MS + 400);
            assert.equal(requests.length, count); assert.equal(allResults().length, resultCount);
            for (const page of pages) assert.equal(await shadow(page, '[data-role="diagnostics-id"]'), null);
        });
        await step('offline creation cannot hang Connect controls; explicit re-enable recovers', async () => {
            offline = true;
            await click(website, CHECKBOX);
            await until(() => shadow(website, DIAGNOSTIC_STATUS), value => /unavailable/i.test(value || ''), 'Offline diagnostic state');
            await until(() => shadow(website, CHECKBOX, 'disabled'), value => value === false, 'Offline checkbox usable');
            assert.equal(await shadow(website, CHECKBOX, 'checked'), false);
            assert.equal(await shadow(website, '[data-action="probe"]', 'disabled'), false);
            assert.equal(await shadow(website, '[data-action="lookup"]', 'disabled'), false);
            await click(website, '[data-action="accounts-tab"]');
            await click(website, '[data-action="config-tab"]');
            offline = false;
            await diagnostics(website, true);
            await until(() => shadow(website, DIAGNOSTIC_STATUS), value => /Connected/.test(value || ''), 'Re-enable recovers');
            assert(store.has(KEY));
        });
        await step('offline exchange leaves Connect usable; re-enable resumes the shared session', async () => {
            offline = true;
            await focus(website);
            await until(() => shadow(website, DIAGNOSTIC_STATUS), value => /unavailable/i.test(value || ''), 'Exchange error displayed');
            assert.equal(await shadow(website, CHECKBOX, 'disabled'), false);
            assert.equal(await shadow(website, '[data-action="probe"]', 'disabled'), false);
            assert.equal(await shadow(website, '[data-action="lookup"]', 'disabled'), false);
            await diagnostics(website, false);
            offline = false;
            await diagnostics(website, true);
            await until(() => shadow(website, DIAGNOSTIC_STATUS), value => /Connected/.test(value || ''), 'Fresh enable recovers from exchange error');
        });
        await step('response arriving after disable is ignored, including its valid command', async () => {
            const client = clientByPage()[WEBSITE];
            const late = command(client, 'snapshot');
            queue(client, [late]); holdClient = client;
            await focus(website);
            await until(() => pending.length, count => count === 1, 'HTTP fixture holds an actual in-flight exchange');
            await diagnostics(website, false);
            assert.equal(store.has(KEY), false);
            const count = requests.length;
            const held = pending.shift();
            held.resolve({ status: 200, responseText: JSON.stringify(held.body), finalUrl: held.request.url });
            await website.waitForTimeout(POLL_MS + 400);
            assert.equal(await shadow(website, CHECKBOX, 'checked'), false);
            assert.match(await shadow(website, DIAGNOSTIC_STATUS), /^Off\./);
            assert.equal(requests.length, count); assert(!allResults().some(result => result.id === late.id));
            assert.equal(aborts.filter(id => id === held.request.id).length, 1, 'Adapter aborts either manager handle exactly once');
        });
        await step('concurrent enable cannot resurrect consent after another document stops', async () => {
            assert.equal(store.has(KEY), false);
            const oldFence = store.get(REVOCATION_KEY);
            // B starts creating before A opts in. No stored grant exists for
            // either document to adopt; B's response is deliberately held.
            holdCreationPage = WEBSITE;
            await click(website, CHECKBOX);
            await until(() => pendingCreations.length, count => count === 1, 'B creation is in flight');
            const held = pendingCreations.shift();
            assert.equal(await shadow(website, CHECKBOX, 'checked'), true);
            assert.equal(await shadow(website, CHECKBOX, 'disabled'), false, 'Stop remains available during creation');
            assert.equal(store.has(KEY), false);
            await diagnostics(app, true);
            await until(() => shadow(app, DIAGNOSTIC_STATUS), value => /Connected/.test(value || ''), 'A concurrently creates its own live grant');
            assert(store.has(KEY));
            assert.notEqual(store.get(KEY).id, held.body.id);
            await diagnostics(app, false);
            const revokedFence = store.get(REVOCATION_KEY);
            assert.match(revokedFence, UUID);
            assert.notEqual(revokedFence, oldFence, 'A persists a new revocation tombstone');
            assert.equal(store.has(KEY), false);
            const count = requests.length;
            held.resolve({ status: 200, responseText: JSON.stringify(held.body), finalUrl: held.request.url });
            await until(() => shadow(website, CHECKBOX, 'checked'), value => value === false, 'B ignores creation made under the revoked fence');
            await until(() => shadow(website, '[data-role="remote-diagnostics"]', 'ariaBusy'), value => value === 'false', 'B creation completes without publishing consent');
            for (const page of pages) {
                await focus(page);
                assert.equal(await shadow(page, CHECKBOX, 'checked'), false);
            }
            await app.waitForTimeout(POLL_MS + 400);
            assert.equal(store.has(KEY), false, 'A late creation must not recreate the deleted grant');
            assert.equal(store.get(REVOCATION_KEY), revokedFence);
            assert.equal(requests.length, count, 'No document sends diagnostics after revocation');
            assert(!exchangeRequests().some(request => request.path.includes(held.body.id)), 'B never exchanges with its late session');
        });
        await step('trusted Stop cancels local creation and ignores the late creation reply', async () => {
            holdCreationPage = WEBSITE;
            await click(website, CHECKBOX);
            await until(() => pendingCreations.length, count => count === 1, 'Local session creation is held');
            const held = pendingCreations.shift();
            assert.equal(await shadow(website, CHECKBOX, 'checked'), true);
            assert.equal(await shadow(website, CHECKBOX, 'disabled'), false);
            await diagnostics(website, false);
            const revokedFence = store.get(REVOCATION_KEY), count = requests.length;
            assert.equal(store.has(KEY), false);
            held.resolve({ status: 200, responseText: JSON.stringify(held.body), finalUrl: held.request.url });
            await website.waitForTimeout(POLL_MS + 400);
            assert.equal(await shadow(website, CHECKBOX, 'checked'), false);
            assert.match(await shadow(website, DIAGNOSTIC_STATUS), /^Off\./);
            assert.equal(store.has(KEY), false);
            assert.equal(store.get(REVOCATION_KEY), revokedFence);
            assert.equal(requests.length, count);
            assert.equal(aborts.filter(id => id === held.request.id).length, 1, 'Creation transport aborted exactly once');
        });
        await step('adapter rejects malformed HTTP paths and already-aborted signals before GM HTTP', async () => {
            const before = requests.length;
            const outcome = await app.evaluate(async () => {
                const request = window.__diagnosticBoundaryRequest;
                const errors = [];
                for (const path of ['https://evil.example/api/connect-diagnostics/session', '/api/connect-diagnostics/session?token=bad', '/api/connect-diagnostics/../../vault', '/api/connect-diagnostics/session/extra']) {
                    try { await request(path, {}, undefined, new AbortController().signal); errors.push(false); }
                    catch { errors.push(true); }
                }
                const controller = new AbortController(); controller.abort();
                try { await request('/api/connect-diagnostics/session', {}, undefined, controller.signal); errors.push(false); }
                catch { errors.push(true); }
                return errors;
            });
            assert.deepEqual(outcome, [true, true, true, true, true]);
            assert.equal(requests.length, before);
        });
        await step('every uploaded event/result has primitive allowlist data and excludes private values', async () => {
            for (const event of allEvents()) {
                assert.deepEqual(Object.keys(event).sort(), ['seq', 'at', 'code', 'data'].sort());
                assert(eventCodes.has(event.code)); assert(Number.isInteger(event.seq) && event.seq > 0); safeData(event.data);
            }
            for (const value of allResults()) safeData(value.data);
            const payload = JSON.stringify(exchangeRequests().map(request => request.body));
            for (const secret of [...SECRETS, WEBSITE, SECOND, 'login.example.org', 'signin.example.net', ...[...sessions.values()].map(session => session.token)]) assert(!payload.includes(secret), 'No credentials, website URLs, raw errors or session token in telemetry');
            assert.equal(result.pageErrors.length, 0, 'No uncaught browser errors');
            for (const page of pages) {
                const wire = await page.evaluate(() => window.__diagnosticFixture.wire);
                assert(!wire.includes('request'), 'Passive fixture never exercises real vault protocol');
            }
            return { requests: requests.length, exchanges: exchangeRequests().length, events: allEvents().length, results: allResults().length };
        });
    } catch (error) {
        result.error = error.stack || String(error);
        console.error(`${engine}/${transportMode}: FAIL ${error.message}`);
        for (const [index, page] of pages.entries()) {
            try { await page.screenshot({ path: path.join(OUT, `${engine}-${transportMode}-failure-${index}.png`) }); } catch {}
        }
    } finally {
        // Capture HTTP data for inspection with upload tokens redacted, including
        // stored grants and headers. Tokens are never written into reports.
        const tokens = [...sessions.values()].map(session => session.token);
        const redact = value => tokens.reduce((text, token) => text.replaceAll(token, '[redacted upload token]'), JSON.stringify(value, null, 2));
        await writeFile(path.join(OUT, `${engine}-${transportMode}-http.json`), redact({ requests, aborts, writes }));
        await context.close(); await browser.close();
    }
}

await Promise.all(engines.map(async engine => {
    for (const mode of ['callback', 'promise']) {
        try { await run(engine, mode); }
        catch (error) { report.runs.push({ engine, transportMode: mode, cases: [], error: error.stack || String(error) }); }
        await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    }
}));
report.finished = new Date().toISOString();
report.passed = report.runs.flatMap(run => run.cases).filter(test => test.passed).length;
report.failed = report.runs.filter(run => run.error).length;
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output: OUT, version, passed: report.passed, failedRuns: report.failed }));
if (report.failed) process.exitCode = 1;
