// Focused production smoke: real App/KDBX/consent, with only GM adapted in a WebKit user world.
// Run with built dist assets: node modules/extension/userscript/tests/port-connect-webkit.mjs
// KWX_BUN selects Bun; KWX_WEBKIT_OUTPUT selects the disposable artifact directory.
import { webkit, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { once } from 'node:events';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const OUT = resolve(process.env.KWX_WEBKIT_OUTPUT || mkdtempSync(join(tmpdir(), 'keewebx-port-webkit-')));
const PASSWORD = 'Disposable-port-vault-2026!';
const ACCOUNTS = [
    { title: 'First fixture account', url: 'https://login.example.org/', user: 'first-fixture-user', password: 'Disposable-first-password!' },
    { title: 'Second fixture account', url: 'https://signin.example.net/', user: 'second-fixture-user', password: 'Disposable-second-password!' },
    { title: 'Unrelated fixture account', url: 'https://wrong.example.com/', user: 'unrelated-fixture-user', password: 'Disposable-unrelated-password!' }
];
const PORT_MARK = 'keewebx-connect-port-v1';
const CASES = [
    'authorize original App once with encrypted KDBX and native consent',
    'signed ready closes site A helper while hello is held; a cached retry survives a lost first reply',
    'site B fills and repeated Test connection reuses both physical ports to the same App',
    'site A reload rebuilds transport to the original App',
    'after both websites close a fresh site finds the original App and signed transport is audited'
];
const secrets = [PASSWORD, ...ACCOUNTS.flatMap(item => [item.user, item.password])];
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[fixture value]'), String(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const report = { browser: 'webkit', headless: true, nativeIOSVerified: false, realUserscriptsManagerVerified: false,
    isolatedWorld: 'WebKit utility world', gmFixture: 'DOM events/main-world binding/Node Map',
    started: new Date().toISOString(), steps: [], errors: [] };
const values = new Map(), helpers = new Map(), sockets = new Set(), requests = new Map();
let browser, context, server, app, first, second, appOrigin, appURL, routeKey, approved, originalApp;
let appNavigations = 0;
mkdirSync(OUT, { recursive: true });

async function utility(page, expression) {
    const world = await page._connection.toImpl(page).mainFrame()._utilityContext();
    return world.evaluateExpression(expression, { isFunction: false });
}
const snapshot = page => utility(page, '__kwxWebKit.snapshot()');
const shadow = (page, selector, property = 'textContent') => utility(page,
    `__kwxWebKit.roots.get(document.getElementById('keewebx-userscript-connect'))?.querySelector(${JSON.stringify(selector)})?.[${JSON.stringify(property)}] ?? null`);
const status = page => shadow(page, '[role="status"]');
const consent = () => app.getByRole('dialog', { name: 'Allow browser extension access', exact: true });
const isHelper = url => url.startsWith(appOrigin + '/connect-port/relay.html');
async function action(page, name) {
    await page.bringToFront();
    const point = await utility(page, `(() => {
        const button = __kwxWebKit.roots.get(document.getElementById('keewebx-userscript-connect'))?.querySelector('[data-action="${name}"]');
        if (!button || button.disabled) throw new Error('Control missing or disabled: ${name}');
        button.scrollIntoView({block:'nearest'});
        const box = button.getBoundingClientRect();
        if (!box.width || !box.height) throw new Error('Control hidden: ${name}');
        return {x:box.x+box.width/2,y:box.y+box.height/2};
    })()`);
    await page.mouse.click(point.x, point.y);
}
async function ready(page) {
    await expect(page.locator('#keewebx-userscript-connect')).toBeAttached({ timeout: 15000 });
    expect(await shadow(page, '[data-role="version"]')).toBe('Connect 0.6.2');
    expect(await utility(page, "__kwxWebKit.roots.get(document.getElementById('keewebx-userscript-connect')).mode")).toBe('closed');
    expect(await page.evaluate(() => [typeof globalThis.__kwxWebKit, document.getElementById('keewebx-userscript-connect').shadowRoot])).toEqual(['undefined', null]);
    if (page !== app) await expect.poll(() => shadow(page, '[data-action="lookup"]', 'disabled')).toBe(false);
}
async function sameApp() {
    expect(await app.evaluate(() => ({ href: location.href, timeOrigin: performance.timeOrigin }))).toEqual(originalApp);
    expect(appNavigations).toBe(1);
    expect(context.pages().filter(page => page.url().startsWith(appOrigin) && !isHelper(page.url()))).toEqual([app]);
    await expect(app.locator('.vault')).toBeVisible();
    await expect(consent()).toHaveCount(0);
    expect(await app.evaluate(() => __kwxFixture.consentCount)).toBe(1);
    expect(values.get(routeKey)).toEqual(approved);
}
async function noHelpers() {
    await expect.poll(() => context.pages().filter(page => isHelper(page.url())).length, { timeout: 10000 }).toBe(0);
    expect([...helpers.values()].every(helper => helper.closedAt !== null && helper.automaticClosure)).toBe(true);
}
async function emptyFields(page) {
    await expect(page.locator('#username')).toHaveValue('');
    await expect(page.locator('#login-password')).toHaveValue('');
    expect(await page.evaluate(() => window.formSubmits)).toBe(0);
}
async function startLookup(page) {
    await page.bringToFront();
    await page.locator('#username').click();
    if (await shadow(page, 'section', 'hidden')) await action(page, 'toggle');
    else { await action(page, 'accounts-tab'); await action(page, 'lookup'); }
}
async function matching(page, account) {
    await expect.poll(() => shadow(page, '[data-role="entries"]'), { timeout: 30000 }).toContain(account.title);
    const listed = await shadow(page, '[data-role="entries"]');
    for (const other of ACCOUNTS.filter(item => item !== account)) expect(listed).not.toContain(other.title);
    expect(await status(page)).toContain('Found 1 matching account');
    await emptyFields(page);
}
async function lookup(page, account) { await startLookup(page); await matching(page, account); }
async function fill(page, account) {
    await action(page, 'entry-0');
    await expect(page.locator('#username')).toHaveValue(account.user, { timeout: 10000 });
    await expect(page.locator('#login-password')).toHaveValue(account.password);
    expect(await page.evaluate(() => window.formSubmits)).toBe(0);
    await sameApp(); await noHelpers();
}
async function testConnection(page) {
    if (await shadow(page, 'section', 'hidden')) {
        await action(page, 'toggle');
        await expect.poll(() => shadow(page, '[data-action="lookup"]', 'disabled'), { timeout: 30000 }).toBe(false);
    }
    await action(page, 'config-tab'); await action(page, 'probe');
    await expect.poll(() => status(page), { timeout: 15000 }).toContain('Connected to the authorized KeeWebX tab');
}
async function physicalPort(page) {
    const state = await snapshot(page), sent = state.packets.filter(item => item.direction === 'sent' && item.data.kind === 'request');
    const ports = [...new Set(sent.map(item => item.port))], connections = [...new Set(sent.map(item => item.data.connectionId))];
    expect(ports).toHaveLength(1); expect(connections).toHaveLength(1);
    return { boot: state.boot, port: ports[0], connection: connections[0] };
}
function signingPublicKey() {
    return createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(approved.publicKey, 'base64')
    ]) });
}
function validSignature(envelope) {
    return verify(null, Buffer.from(stable(envelope.packet)), signingPublicKey(), Buffer.from(envelope.signature, 'base64'));
}
function validReadyProof(data) {
    const payload = JSON.stringify(['keewebx-connect-port-ready-v1', data.appBoot, data.connectionId, data.endpoint, data.siteOrigin]);
    return typeof data.proof === 'string' && Buffer.from(data.proof, 'base64').length === 64
        && verify(null, Buffer.from(payload), signingPublicKey(), Buffer.from(data.proof, 'base64'));
}
async function closedHelper(page, before) {
    await noHelpers(); expect(helpers.size).toBe(before + 1);
    const helper = [...helpers.values()][before], url = new URL(helper.url);
    expect(url.searchParams.getAll('site')).toEqual([new URL(page.url()).origin]);
    expect(url.searchParams.getAll('endpoint')).toEqual([appURL]);
    expect(url.searchParams.getAll('nonce')).toHaveLength(1);
    expect(url.searchParams.get('nonce')).toMatch(/^[0-9a-f-]{36}$/i);
    const { packets } = await snapshot(page);
    const received = packets.filter(item => item.direction === 'received'
        && item.at >= helper.openedAt && item.data.kind === 'ready');
    expect(received).toHaveLength(1);
    const ready = received[0];
    expect(ready.data.marker).toBe(PORT_MARK);
    expect(ready.data.appBoot).toBe(approved.host);
    expect(ready.data.endpoint).toBe(appURL);
    expect(ready.data.siteOrigin).toBe(new URL(page.url()).origin);
    expect(ready.data.connectionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(validReadyProof(ready.data)).toBe(true);
    expect(ready.at).toBeLessThanOrEqual(helper.closedAt);
    expect(packets.some(item => item.direction === 'sent' && item.port === ready.port
        && item.data.kind === 'request' && item.data.connectionId === ready.data.connectionId
        && item.data.value?.packet?.operation === 'hello' && item.at >= ready.at)).toBe(true);
    expect(helper.automaticClosure).toBe(true);
    helper.signedReadyBeforeClosure = true;
}
async function step(name, fn) {
    const started = Date.now();
    try {
        const detail = await fn();
        report.steps.push({ name, passed: true, milliseconds: Date.now() - started, ...detail });
        console.log('PASS ' + name);
    } catch (error) { report.steps.push({ name, passed: false }); throw error; }
}

// All wrappers below live only in the utility world and preserve native behavior.
function adapter(marker) {
    const roots = new WeakMap(), ports = new WeakMap();
    const state = { boot: crypto.randomUUID(), packets: [], attachments: [], holdHello: false, held: [] };
    globalThis.__kwxWebKit = { roots, snapshot: () => ({ boot: state.boot, packets: state.packets, attachments: state.attachments, held: state.held.length }),
        hold: () => { state.holdHello = true; }, release: (dropFirst = false) => {
            state.holdHello = false;
            const pending = state.held.splice(0);
            const released = dropFirst ? pending.slice(1) : pending;
            for (const [port, data, rest] of released) { record(port, 'sent', data); nativePost.call(port, data, ...rest); }
            return released.length;
        } };
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (...args) { const root = attach.apply(this, args); roots.set(this, root); return root; };
    let sequence = 0, tab = null;
    const record = (port, direction, data) => {
        if (data?.marker === marker) state.packets.push({ at: Date.now(), port: ports.get(port), direction, data: structuredClone(data) });
    };
    const observe = port => {
        if (ports.has(port)) return;
        ports.set(port, ++sequence);
        port.addEventListener('message', event => record(port, 'received', event.data));
    };
    // Observe the initial ready proof before the receiver can close its helper.
    globalThis.MessageChannel = new Proxy(MessageChannel, {
        construct(target, args, newTarget) {
            const channel = Reflect.construct(target, args, newTarget);
            observe(channel.port1); observe(channel.port2);
            return channel;
        }
    });
    const nativePost = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (data, ...rest) {
        if (data?.marker === marker) {
            observe(this);
            if (state.holdHello && data.kind === 'reply' && data.value?.packet?.operation === 'hello') { state.held.push([this, data, rest]); return; }
            record(this, 'sent', data);
        }
        return nativePost.call(this, data, ...rest);
    };
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.marker !== marker) return;
        for (const port of event.ports) observe(port);
        state.attachments.push({ trusted: event.isTrusted, worker: event.source?.scriptURL, data: structuredClone(event.data) });
    });
    const call = (action, key, value) => new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        document.addEventListener('kwx-gm-' + id, event => {
            const data = JSON.parse(event.detail); if (data.error) reject(new Error(data.error)); else resolve(data.value);
        }, { once: true });
        document.dispatchEvent(new CustomEvent('kwx-gm-request', { detail: JSON.stringify({ id, action, key, value }) }));
    });
    return { info: { scriptHandler: 'Userscripts', script: { filename: 'Connect.user.js' } },
        getValue: async (key, fallback) => (await call('get', key)) ?? fallback,
        setValue: (key, value) => call('set', key, value), deleteValue: key => call('delete', key),
        getTab: async () => structuredClone(tab), saveTab: async value => { tab = structuredClone(value); } };
}

try {
    const installer = readFileSync(join(ROOT, 'modules/extension/userscript/keewebx-connect.user.js'), 'utf8');
    expect(installer).toMatch(/@version\s+0\.6\.2\b/);
    for (const asset of ['index.html', 'connect-port/relay.html', 'connect-port/relay.js', 'connect-port/worker.js'])
        expect(readFileSync(join(ROOT, 'dist', asset)).length).toBeGreaterThan(0);
    const fixture = join(OUT, 'fixture.kdbx');
    execFileSync(process.env.KWX_BUN || 'bun', ['--eval', `
        import * as kdbx from ${JSON.stringify(pathToFileURL(join(ROOT, 'modules/db/lib/index.ts')).href)};
        import {argon2} from ${JSON.stringify(pathToFileURL(join(ROOT, 'modules/db/test/test-support/argon2.ts')).href)};
        import {writeFileSync} from 'node:fs'; kdbx.CryptoEngine.setArgon2Impl(argon2);
        const db=kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(${JSON.stringify(PASSWORD)})),'Disposable Connect');
        db.header.kdfParameters.set('M',kdbx.VarDictionary.ValueType.UInt64,kdbx.Int64.from(32768));
        db.header.kdfParameters.set('I',kdbx.VarDictionary.ValueType.UInt64,kdbx.Int64.from(2));
        for(const account of ${JSON.stringify(ACCOUNTS)}){const entry=db.createEntry(db.getDefaultGroup());
            for(const [key,value] of Object.entries({Title:account.title,URL:account.url,UserName:account.user}))entry.fields.set(key,value);
            entry.fields.set('Password',kdbx.ProtectedValue.fromString(account.password));}
        writeFileSync(${JSON.stringify(fixture)},new Uint8Array(await db.save()));
    `], { cwd: ROOT, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    report.kdbx = { generated: true, encrypted: true, sha256: sha256(readFileSync(fixture)) };
    const pem = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '-', '-out', '-',
        '-days', '1', '-subj', '/CN=localhost'], { stdio: ['ignore', 'pipe', 'ignore'] });
    server = createServer({ key: pem, cert: pem }, (request, response) => {
        const pathname = new URL(request.url, 'https://localhost').pathname;
        requests.set(pathname, (requests.get(pathname) || 0) + 1);
        const path = resolve(ROOT, 'dist', '.' + (['/app', '/app/'].includes(pathname) ? '/index.html' : pathname));
        if (!path.startsWith(join(ROOT, 'dist') + '/')) { response.writeHead(403).end(); return; }
        try {
            const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(path)] || 'application/octet-stream';
            // Read before committing headers so missing optional assets return one 404.
            const body = readFileSync(path);
            response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' }).end(body);
        } catch { response.writeHead(404).end(); }
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '0.0.0.0'); await once(server, 'listening');
    appOrigin = 'https://localhost:' + server.address().port; appURL = appOrigin + '/app';
    routeKey = 'keewebx-native-connect-v1:selected:' + appURL;
    const bundle = installer.replaceAll('https://keewebx.app', appOrigin);
    report.appOrigin = appOrigin; report.endpointSubstituted = true;
    report.installer = { bytes: Buffer.byteLength(installer), sha256: sha256(installer), executedSha256: sha256(bundle), onlyChange: 'replaceAll(https://keewebx.app, appOrigin)' };
    browser = await webkit.launch({ headless: true }); report.browserVersion = browser.version();
    context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    await context.exposeBinding('kwxFixtureTrace', (_source, detail) => { (report.helperMessages ||= []).push(detail); });
    await context.exposeBinding('kwxFixtureGM', (_source, action, key, value) => {
        if (key.startsWith('keewebx-connect-mailbox-v1:')) throw new Error('Unexpected legacy mailbox access');
        if (action === 'set') values.set(key, structuredClone(value));
        else if (action === 'delete') values.delete(key);
        else return structuredClone(values.get(key));
    });
    await context.addInitScript(() => {
        if (location.pathname === '/connect-port/relay.html') addEventListener('message', event => {
            if (event.data?.marker === 'keewebx-connect-port-v1') void globalThis.kwxFixtureTrace({
                kind: event.data.kind, data: event.data, ports: event.ports.length, trusted: event.isTrusted, origin: event.origin
            });
        });
        document.addEventListener('kwx-gm-request', async event => {
            const { id, action, key, value } = JSON.parse(event.detail);
            let result;
            try { result = { value: await globalThis.kwxFixtureGM(action, key, value) }; }
            catch (error) { result = { error: String(error) }; }
            document.dispatchEvent(new CustomEvent('kwx-gm-' + id, { detail: JSON.stringify(result) }));
        });
        globalThis.__kwxFixture = { consentCount: 0 };
        document.addEventListener('DOMContentLoaded', () => {
            const seen = new WeakSet();
            new MutationObserver(() => {
                for (const dialog of document.querySelectorAll('[role="dialog"],dialog'))
                    if ((dialog.getAttribute('aria-label') || dialog.textContent).includes('Allow browser extension access') && !seen.has(dialog)) {
                        seen.add(dialog); __kwxFixture.consentCount++;
                    }
            }).observe(document.body, { childList: true, subtree: true });
        }, { once: true });
    });
    context.on('request', request => { if (request.isNavigationRequest() && request.url() === appURL) appNavigations++; });
    context.on('page', page => {
        const track = () => { if (isHelper(page.url()) && !helpers.has(page)) helpers.set(page,
            { url: page.url(), openedAt: Date.now(), closedAt: null, automaticClosure: false, signedReadyBeforeClosure: false }); };
        track(); page.on('framenavigated', track);
        page.on('close', () => {
            const helper = helpers.get(page);
            if (helper) { helper.closedAt = Date.now(); helper.automaticClosure = true; }
        });
        page.on('pageerror', error => report.errors.push(redact(error.message)));
        page.on('domcontentloaded', () => {
            if (![appOrigin, ...ACCOUNTS.slice(0, 2).map(item => new URL(item.url).origin)].includes(new URL(page.url()).origin) || isHelper(page.url())) return;
            void utility(page, `(() => { const GM = (${adapter.toString()})(${JSON.stringify(PORT_MARK)}); ${bundle}\n})();`)
                .catch(error => report.errors.push(redact(error.stack)));
        });
    });
    for (const account of ACCOUNTS.slice(0, 2)) await context.route(account.url + '**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Disposable login</title>
        <style>body{font:18px system-ui;padding:80px}input{display:block;width:300px;height:40px;margin:12px}</style>
        <h1>Login</h1><form><input id="username" autocomplete="username"><input id="login-password" type="password" autocomplete="current-password"><button>Sign in</button></form>
        <script>window.formSubmits=0;document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.formSubmits++});</script>` }));

    await step(CASES[0], async () => {
        app = await context.newPage(); await app.goto(appURL); await ready(app);
        await app.locator('#open-file-input, #kdbx-file-input').first().setInputFiles(fixture);
        const fallback = app.getByRole('button', { name: 'Use password', exact: true });
        if (await fallback.isVisible()) await fallback.click();
        await app.locator('#password').fill(PASSWORD); await app.locator('#unlock').click();
        await expect(app.locator('.entry-row').first()).toBeVisible();
        await action(app, 'toggle'); await action(app, 'authorize'); await expect(consent()).toBeVisible();
        await consent().getByRole('checkbox', { name: 'Allow listing and searching entries', exact: true }).check();
        await consent().getByRole('button', { name: 'Allow', exact: true }).click();
        await expect.poll(() => status(app), { timeout: 15000 }).toContain('Authorized');
        approved = structuredClone(values.get(routeKey)); expect(approved.messagePort).toBe(1); expect(approved.endpoint).toBe(appURL);
        expect(approved.readyProof).toBe(1);
        originalApp = await app.evaluate(() => ({ href: location.href, timeOrigin: performance.timeOrigin }));
        await sameApp(); await noHelpers();
    });
    await step(CASES[1], async () => {
        first = await context.newPage(); await first.goto(ACCOUNTS[0].url); await ready(first);
        expect(helpers.size).toBe(0); await emptyFields(first);
        await utility(app, '__kwxWebKit.hold()');
        try {
            await startLookup(first);
            await expect.poll(async () => (await snapshot(app)).held || (/invalid|blocked|could not/i.test(await status(first)) ? -1 : 0), { timeout: 25000 }).not.toBe(0);
            if ((await snapshot(app)).held < 1) throw new Error('Signed hello was not reached: ' + await status(first));
            await expect.poll(() => helpers.size).toBe(1);
            await expect.poll(() => [...helpers.keys()][0].isClosed(), { timeout: 2000, message: 'Signed ready must close the helper while RPC hello is held' }).toBe(true);
            await closedHelper(first, 0);
            expect([...helpers.keys()][0].isClosed()).toBe(true);
            await expect.poll(async () => (await snapshot(app)).held, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
            expect([...helpers.keys()][0].isClosed()).toBe(true);
            const helloRepliesHeld = (await snapshot(app)).held, port = await physicalPort(first);
            const { packets } = await snapshot(first);
            const hellos = packets.filter(item => item.direction === 'sent' && item.data.kind === 'request'
                && item.data.value?.packet?.operation === 'hello');
            expect(hellos.length).toBeGreaterThanOrEqual(2);
            expect(new Set(hellos.map(item => JSON.stringify(item.data.value))).size).toBe(1);
            expect(packets.filter(item => item.direction === 'received'
                && item.data.value?.packet?.operation === 'hello')).toHaveLength(0);
            expect(await shadow(first, '[data-action="entry-0"]')).toBe(null);
            await emptyFields(first);
            for (const account of ACCOUNTS) expect(await shadow(first, '[data-role="entries"]')).not.toContain(account.title);
            expect(await utility(app, '__kwxWebKit.release(true)')).toBeGreaterThanOrEqual(1);
            await matching(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]);
            report.appHiddenDuringSiteA = await app.evaluate(() => document.hidden);
            report.siteA = await physicalPort(first);
            expect(report.siteA).toEqual(port);
            return { helloRepliesHeld, droppedFirstHelloReply: true, identicalHelloRetries: true, physicalPortReused: true };
        } finally { await utility(app, '__kwxWebKit.release()'); }
    });
    await step(CASES[2], async () => {
        second = await context.newPage(); await second.goto(ACCOUNTS[1].url); await ready(second); expect(helpers.size).toBe(1);
        await lookup(second, ACCOUNTS[1]); await closedHelper(second, 1); await fill(second, ACCOUNTS[1]);
        report.appHiddenDuringSiteB = await app.evaluate(() => document.hidden);
        report.siteB = await physicalPort(second); expect(report.siteB.connection).not.toBe(report.siteA.connection);
        await first.locator('#username').fill(''); await first.locator('#login-password').fill('');
        await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]);
        expect(await physicalPort(first)).toEqual(report.siteA); expect(helpers.size).toBe(2);
        const attached = (await snapshot(app)).attachments.filter(item => item.data.kind === 'attach-port');
        expect(new Set(attached.map(item => item.data.connectionId)).size).toBe(2);
        for (const [page, port] of [[first, report.siteA], [second, report.siteB]]) {
            for (let attempt = 0; attempt < 2; attempt++) {
                await testConnection(page);
                expect(await physicalPort(page)).toEqual(port);
                expect(helpers.size).toBe(2); await sameApp(); await noHelpers();
            }
        }
        report.repeatedConnectionTests = { checks: 4, persistentPhysicalPorts: 2, idleHelpers: 0 };
    });
    await step(CASES[3], async () => {
        await first.reload(); await ready(first); expect(helpers.size).toBe(2);
        await lookup(first, ACCOUNTS[0]); await closedHelper(first, 2); await fill(first, ACCOUNTS[0]);
        report.siteAReload = await physicalPort(first);
        expect(report.siteAReload.boot).not.toBe(report.siteA.boot); expect(report.siteAReload.connection).not.toBe(report.siteA.connection);
        expect(await physicalPort(second)).toEqual(report.siteB);
    });
    await step(CASES[4], async () => {
        await noHelpers(); await first.close(); await second.close(); first = second = undefined;
        expect(context.pages()).toEqual([app]); await sameApp();
        const before = helpers.size;
        first = await context.newPage(); await first.goto(ACCOUNTS[0].url); await ready(first);
        expect(helpers.size).toBe(before); await emptyFields(first);
        await lookup(first, ACCOUNTS[0]); await closedHelper(first, before); await fill(first, ACCOUNTS[0]);
        report.siteAFresh = await physicalPort(first);
        expect(report.siteAFresh.boot).not.toBe(report.siteAReload.boot);
        expect(report.siteAFresh.connection).not.toBe(report.siteAReload.connection);
        expect(report.siteAFresh.connection).not.toBe(report.siteB.connection);
        expect(context.pages()).toHaveLength(2); await sameApp(); await noHelpers();
        const observed = await snapshot(app), attachments = observed.attachments.filter(item => item.data.kind === 'attach-port');
        expect(attachments).toHaveLength(4);
        expect(attachments.every(item => item.trusted && item.worker === appOrigin + '/connect-port/worker.js'
            && item.data.appBoot === approved.host && item.data.endpoint === appURL)).toBe(true);
        const envelopes = observed.packets.filter(item => item.data.value?.packet).map(item => item.data.value);
        expect(envelopes.length).toBeGreaterThan(0); expect(envelopes.every(validSignature)).toBe(true);
        const sensitive = envelopes.filter(item => ['kwx-pair', 'kwx-features', 'kwx-get-entries', 'kwx-get-entry-fields'].includes(item.packet.body?.action));
        expect(sensitive.length).toBeGreaterThan(0);
        expect(sensitive.every(item => typeof item.packet.body.message === 'string' && typeof item.packet.body.nonce === 'string')).toBe(true);
        const readyProofs = observed.packets.filter(item => item.direction === 'sent' && item.data.kind === 'ready');
        const signedReadyBeforeClosure = [...helpers.values()].filter(helper => helper.signedReadyBeforeClosure).length;
        expect(readyProofs).toHaveLength(4); expect(signedReadyBeforeClosure).toBe(4);
        expect(readyProofs.every(item => validReadyProof(item.data) && item.data.appBoot === approved.host
            && item.data.endpoint === appURL && ACCOUNTS.slice(0, 2).some(account => new URL(account.url).origin === item.data.siteOrigin))).toBe(true);
        for (const secret of secrets) expect(JSON.stringify(observed.packets)).not.toContain(secret);
        expect(requests.get('/connect-port/worker.js')).toBeGreaterThan(0);
        report.transport = { nativeWorkerAttachments: attachments.length, signedEnvelopes: envelopes.length, encryptedSensitiveEnvelopes: sensitive.length,
            signedReadyProofs: readyProofs.length, signedReadyBeforeClosure,
            workerRequestsViaHTTPS: requests.get('/connect-port/worker.js'), legacyMailboxUsed: false };
    });
    expect(report.errors).toEqual([]); report.passed = true;
} catch (error) {
    report.passed = false; report.failure = redact(error.stack || error); console.error('FAIL ' + report.failure);
    process.exitCode = 1;
    for (const name of CASES.slice(report.steps.length)) report.steps.push({ name, passed: null, skipped: true, reason: 'Earlier case failed' });
    for (const [name, page] of [['app', app], ['siteA', first], ['siteB', second]]) if (page && !page.isClosed()) {
        report[name + 'Status'] = await status(page).catch(() => null);
        report[name + 'Traffic'] = await snapshot(page).then(state => ({ held: state.held, attachments: state.attachments,
            packets: state.packets.map(item => ({ port: item.port, direction: item.direction, kind: item.data.kind, operation: item.data.value?.packet?.operation, error: item.data.message })) })).catch(() => null);
        await page.screenshot({ path: join(OUT, name + '-failure.png') }).catch(() => {});
    }
} finally {
    if (app && !app.isClosed()) await utility(app, '__kwxWebKit.release()').catch(() => {});
    report.appNavigations = appNavigations;
    report.helpers = { opened: helpers.size, automaticallyClosed: [...helpers.values()].filter(helper => helper.automaticClosure).length,
        signedReadyBeforeClosure: [...helpers.values()].filter(helper => helper.signedReadyBeforeClosure).length,
        remaining: context?.pages().filter(page => isHelper(page.url())).length || 0, lifecycle: [...helpers.values()] };
    report.finished = new Date().toISOString(); report.output = OUT;
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    await browser?.close();
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
}
