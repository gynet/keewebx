// Production installer acceptance with native MessagePorts and a real encrypted KDBX.
// Fixture helpers follow native-connect.mjs; importing it would execute its suite.
// Build the 0.6.2 installer and app assets, serve dist on KWX_APP_SERVER, then run:
// node modules/extension/userscript/tests/port-connect.mjs
// KWX_APP_GM_BLOCK=1 leaves every app GM read unresolved after authorization.
// Chromium's isolated extension world adapts GM; this does not certify an iOS manager.
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer as createHTTPServer } from 'node:http';
import { createServer as createHTTPSServer } from 'node:https';
import { connect as connectSocket } from 'node:net';
import { once } from 'node:events';

const ROOT = resolve(process.env.KWX_REPO_ROOT || fileURLToPath(new URL('../../../..', import.meta.url)));
const BUN = process.env.KWX_BUN || (typeof Bun !== 'undefined' ? process.execPath : 'bun');
const APP_SERVER = process.env.KWX_APP_SERVER || 'http://127.0.0.1:39232';
const SOURCE = resolve(process.env.KWX_USERSCRIPT || join(ROOT, 'modules/extension/userscript/keewebx-connect.user.js'));
const OUT = resolve(process.env.KWX_E2E_OUTPUT_DIR || mkdtempSync(join(tmpdir(), 'keewebx-port-connect-')));
const BLOCK_APP_GM = process.env.KWX_APP_GM_BLOCK === '1';
const APP = 'https://keewebx.app/app';
const MARK = 'keewebx-native-connect-v1';
const PORT_MARK = 'keewebx-connect-port-v1';
const ROUTE_KEY = `${MARK}:selected:${APP}`;
const IDENTITY_KEY = 'keewebx-userscript-connect-identity-v1';
const PREFIX = 'Connect.user.js---';
const DB_PASSWORD = 'Disposable-port-vault-2026!';
const ACCOUNTS = [
    { title: 'First fixture account', url: 'https://login.example.org/', user: 'first-fixture-user', password: 'Disposable-first-password!' },
    { title: 'Second fixture account', url: 'https://signin.example.net/', user: 'second-fixture-user', password: 'Disposable-second-password!' },
    { title: 'Unrelated fixture account', url: 'https://wrong.example.com/', user: 'unrelated-fixture-user', password: 'Disposable-unrelated-password!' }
];
const PRIVATE_VALUES = [DB_PASSWORD, ...ACCOUNTS.flatMap(account => [account.title, account.user, account.password])];
const redact = value => PRIVATE_VALUES.reduce((result, secret) => result.replaceAll(secret, '[fixture value]'), String(value));
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const report = {
    started: new Date().toISOString(),
    scope: 'Production 0.6.2 installer in Chromium isolated content scripts, native MessagePort and service-worker handoff, GM adapter, real KDBX and native consent',
    nativeIOSVerified: false, realManagerVerified: false, appGMBlockedAfterAuthorization: BLOCK_APP_GM,
    steps: [], errors: []
};
const cdpByPage = new WeakMap(), helpers = new Map(), documents = new Map(), sockets = new Set();
const assetRequests = new Map();
let context, nativeWorker, app, first, second, originalApp, approvedRoute, tlsServer, proxyServer;
let appNavigationRequests = 0;
mkdirSync(OUT, { recursive: true });

async function step(name, fn) {
    console.log(JSON.stringify({ step: name, state: 'started' }));
    const started = Date.now();
    try {
        const detail = await fn() || {};
        const result = { name, state: 'passed', milliseconds: Date.now() - started, ...detail };
        report.steps.push(result);
        console.log(JSON.stringify(result));
    } catch (error) {
        report.steps.push({ name, state: 'failed', error: redact(error.message) });
        throw error;
    }
}

// Closed-shadow inspection and trusted mouse actions reuse the native fixture.
async function cdp(page) {
    if (!cdpByPage.has(page)) {
        const session = await context.newCDPSession(page), worlds = new Map();
        session.on('Runtime.executionContextCreated', ({ context: world }) => worlds.set(world.id, world));
        session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => worlds.delete(executionContextId));
        session.on('Runtime.executionContextsCleared', () => worlds.clear());
        cdpByPage.set(page, { session, worlds });
        await session.send('Runtime.enable');
    }
    return cdpByPage.get(page);
}
async function adapter(page, expression) {
    const { session, worlds } = await cdp(page);
    for (const world of worlds.values()) {
        if (world.auxData?.isDefault !== false) continue;
        const found = await session.send('Runtime.evaluate', {
            contextId: world.id, expression: 'typeof globalThis.__kwxPortAdapter === "object"', returnByValue: true
        });
        if (found.result.value !== true) continue;
        const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
            contextId: world.id, expression, returnByValue: true, awaitPromise: true
        });
        if (exceptionDetails) throw new Error('Isolated GM adapter inspection failed');
        return result.value;
    }
    throw new Error('Installer isolated content world missing');
}
const snapshot = page => adapter(page, '__kwxPortAdapter.snapshot()');
async function archive(page) {
    const document = await snapshot(page);
    documents.set(document.boot, document);
    return document;
}
async function realVisibility(page) {
    await page.waitForLoadState('domcontentloaded');
    // Playwright's own CDP session forces tabs visible unless this is disabled.
    const session = page._connection.toImpl(page).delegate._mainFrameSession._client;
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}
function hostIn(node) {
    if (node.attributes?.some((value, index, attributes) => index % 2 === 0 && value === 'id' && attributes[index + 1] === 'keewebx-userscript-connect')) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
        const found = hostIn(child);
        if (found) return found;
    }
}
async function shadowNode(page, selector, index = 0) {
    const { session } = await cdp(page);
    const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = hostIn(root);
    if (!host?.shadowRoots?.[0]) throw new Error('Closed-shadow Connect widget missing');
    expect(host.shadowRoots[0].shadowRootType).toBe('closed');
    const { nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: host.shadowRoots[0].nodeId, selector });
    return { session, nodeId: nodeIds[index] };
}
async function shadowValue(page, selector, property = 'textContent', index = 0) {
    const { session, nodeId } = await shadowNode(page, selector, index);
    if (!nodeId) return null;
    const { object } = await session.send('DOM.resolveNode', { nodeId });
    try {
        const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
            objectId: object.objectId, functionDeclaration: 'function(property) { return this[property]; }',
            arguments: [{ value: property }], returnByValue: true
        });
        if (exceptionDetails) throw new Error('CDP closed-shadow read failed');
        return result.value;
    } finally { await session.send('Runtime.releaseObject', { objectId: object.objectId }); }
}
async function shadowClick(page, selector) {
    await page.bringToFront();
    const { session, nodeId } = await shadowNode(page, selector);
    if (!nodeId) throw new Error(`Closed-shadow control missing: ${selector}`);
    await session.send('DOM.scrollIntoViewIfNeeded', { nodeId });
    const { model } = await session.send('DOM.getBoxModel', { nodeId });
    const q = model.content;
    await page.mouse.click((q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4);
}
const action = (page, name) => shadowClick(page, `[data-action="${name}"]`);
const status = page => shadowValue(page, '[role="status"]');
const entries = page => shadowValue(page, '[data-role="entries"]');
const fieldReads = () => app.evaluate(() => globalThis.__kwxNativeTest.wireRequests['kwx-get-entry-fields'] || 0);
const documentState = page => page.evaluate(() => ({ href: location.href, timeOrigin: performance.timeOrigin, boot: globalThis.__kwxNativeTest.documentBoot }));
const consent = () => app.getByRole('dialog', { name: 'Allow browser extension access', exact: true });
async function untilStatus(page, expression, timeout = 15000) {
    await expect.poll(() => status(page), { timeout, message: `Connect status must match ${expression}` }).toMatch(expression);
    return status(page);
}
async function ready(page) {
    await realVisibility(page);
    await expect(page.locator('#keewebx-userscript-connect')).toBeAttached({ timeout: 15000 });
    expect(await shadowValue(page, '[data-role="version"]')).toBe('Connect 0.6.2');
    expect(await page.evaluate(() => typeof globalThis.__kwxPortAdapter)).toBe('undefined');
    await snapshot(page);
    if (new URL(page.url()).origin !== new URL(APP).origin) {
        await expect.poll(() => shadowValue(page, '[data-action="lookup"]', 'disabled'), { timeout: 15000 }).toBe(false);
        await expect.poll(() => shadowValue(page, '[data-action="probe"]', 'disabled'), { timeout: 15000 }).toBe(false);
    }
}
async function emptyFields(page) {
    await expect(page.locator('#username')).toHaveValue('');
    await expect(page.locator('#login-password')).toHaveValue('');
    expect(await page.evaluate(() => window.formSubmits)).toBe(0);
}
async function clearFields(page) {
    await page.bringToFront();
    await page.locator('#username').fill('');
    await page.locator('#login-password').fill('');
}
async function settings() {
    const data = await nativeWorker.evaluate(() => chrome.storage.local.get());
    return new Map(Object.entries(data).filter(([key]) => key.startsWith(PREFIX)).map(([key, value]) => [key.slice(PREFIX.length), value]));
}
function helperURL(value) {
    try { const url = new URL(value); return url.origin === new URL(APP).origin && url.pathname === '/connect-port/relay.html'; }
    catch { return false; }
}
function trackHelper(page) {
    if (!helperURL(page.url()) || helpers.has(page)) return;
    helpers.set(page, { url: page.url(), openedAt: Date.now(), closedAt: null, automaticClosure: false, signedReadyBeforeClosure: false });
}
async function noHelpers() {
    await expect.poll(() => context.pages().filter(page => helperURL(page.url())).length, { timeout: 10000 }).toBe(0);
    expect([...helpers.values()].every(helper => helper.closedAt !== null && helper.automaticClosure)).toBe(true);
}
async function sameApp({ unlocked = true, authorized = true } = {}) {
    expect(await documentState(app)).toEqual(originalApp);
    expect(appNavigationRequests).toBe(1);
    expect(context.pages().filter(page => page.url().startsWith(new URL(APP).origin) && !helperURL(page.url()))).toEqual([app]);
    if (unlocked) await expect(app.locator('.vault')).toBeVisible();
    await expect(consent()).toHaveCount(0);
    expect(await app.evaluate(() => globalThis.__kwxNativeTest.consentCount)).toBe(1);
    if (authorized) expect((await settings()).get(ROUTE_KEY)).toEqual(approvedRoute);
    if (BLOCK_APP_GM) expect((await snapshot(app)).blockGM).toBe(true);
}
async function newWebsite(account) {
    const count = helpers.size;
    const page = await context.newPage();
    await page.goto(account.url);
    await ready(page);
    await page.waitForTimeout(200);
    expect(helpers.size).toBe(count);
    await emptyFields(page);
    return page;
}
async function startLookup(page) {
    await page.bringToFront();
    await page.locator('#username').click();
    if (await shadowValue(page, 'section', 'hidden')) await action(page, 'toggle');
    else { await action(page, 'accounts-tab'); await action(page, 'lookup'); }
}
async function matchingList(page, account, readsBefore) {
    await expect.poll(() => entries(page), { timeout: 30000 }).toContain(account.title);
    const listed = await entries(page);
    for (const other of ACCOUNTS.filter(item => item !== account)) expect(listed).not.toContain(other.title);
    expect(await status(page)).toMatch(/Found 1 matching account/);
    expect(await fieldReads()).toBe(readsBefore);
    await emptyFields(page);
}
async function lookup(page, account) {
    const readsBefore = await fieldReads();
    await startLookup(page);
    await matchingList(page, account, readsBefore);
}
async function fill(page, account) {
    const readsBefore = await fieldReads();
    await action(page, 'entry-0');
    await expect(page.locator('#username')).toHaveValue(account.user, { timeout: 10000 });
    await expect(page.locator('#login-password')).toHaveValue(account.password);
    expect(await fieldReads()).toBe(readsBefore + 1);
    expect(await page.evaluate(() => window.formSubmits)).toBe(0);
}
async function config(page) {
    if (await shadowValue(page, 'section', 'hidden')) {
        await action(page, 'toggle');
        // With a selected field, the key starts a lookup. Let that operation
        // finish before changing tabs, rather than canceling a pending hello.
        await expect.poll(() => shadowValue(page, '[data-action="lookup"]', 'disabled'), { timeout: 30000 }).toBe(false);
    }
    await action(page, 'config-tab');
}
async function probe(page) {
    await action(page, 'probe');
    await untilStatus(page, /Connected to the authorized KeeWebX tab/);
}
async function physicalPort(page) {
    const document = await snapshot(page);
    const requests = document.packets.filter(item => item.direction === 'sent' && item.data.kind === 'request');
    const ports = [...new Set(requests.map(item => item.port))];
    const connections = [...new Set(requests.map(item => item.data.connectionId))];
    expect(requests.length).toBeGreaterThan(0);
    expect(ports).toHaveLength(1);
    expect(connections).toHaveLength(1);
    return { boot: document.boot, port: ports[0], connection: connections[0] };
}
function signingPublicKey() {
    return createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(approvedRoute.publicKey, 'base64')
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
async function closedHelper(page, countBefore) {
    await noHelpers();
    expect(helpers.size).toBe(countBefore + 1);
    const helper = [...helpers.values()][countBefore], url = new URL(helper.url);
    expect(url.searchParams.getAll('site')).toEqual([new URL(page.url()).origin]);
    expect(url.searchParams.getAll('endpoint')).toEqual([APP]);
    expect(url.searchParams.getAll('nonce')).toHaveLength(1);
    expect(url.searchParams.get('nonce')).toMatch(/^[0-9a-f-]{36}$/i);
    const { packets } = await snapshot(page);
    const received = packets.filter(item => item.direction === 'received'
        && item.at >= helper.openedAt && item.data.kind === 'ready');
    expect(received).toHaveLength(1);
    const ready = received[0];
    expect(ready.data.marker).toBe(PORT_MARK);
    expect(ready.data.appBoot).toBe(approvedRoute.host);
    expect(ready.data.endpoint).toBe(APP);
    expect(ready.data.siteOrigin).toBe(new URL(page.url()).origin);
    expect(ready.data.connectionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(validReadyProof(ready.data)).toBe(true);
    expect(ready.at).toBeLessThanOrEqual(helper.closedAt);
    expect(packets.some(item => item.direction === 'sent' && item.port === ready.port
        && item.data.kind === 'request' && item.data.connectionId === ready.data.connectionId
        && item.data.value?.packet?.operation === 'hello' && item.at >= ready.at)).toBe(true);
    expect(helper.automaticClosure).toBe(true);
    helper.signedReadyBeforeClosure = true;
    await sameApp();
}
async function cancelPending(page, kind) {
    await clearFields(page);
    await lookup(page, ACCOUNTS[0]);
    const port = await physicalPort(page), count = helpers.size;
    await app.evaluate(() => { globalThis.__kwxNativeTest.holdFields = true; });
    try {
        await action(page, 'entry-0');
        await expect.poll(() => app.evaluate(() => globalThis.__kwxNativeTest.heldFields.length)).toBe(1);
        const before = await page.evaluate(() => window.credentialInputEvents);
        if (kind === 'close') await action(page, 'close');
        else if (kind === 'hidden') {
            await app.bringToFront();
            await expect.poll(() => page.evaluate(() => document.hidden)).toBe(true);
        } else await page.evaluate(() => { location.hash = 'changed-during-fill'; });
        expect(await app.evaluate(() => globalThis.__kwxNativeTest.releaseFields())).toBe(1);
        await page.waitForTimeout(350);
        await emptyFields(page);
        expect(await page.evaluate(() => window.credentialInputEvents)).toBe(before);
        expect(await physicalPort(page)).toEqual(port);
        expect(helpers.size).toBe(count);
        await sameApp();
    } finally { await app.evaluate(() => globalThis.__kwxNativeTest.releaseFields()); }
}

// These observers live beside the installer, in the extension's isolated world.
// They retain native port identity and traffic; they never implement a receiver.
function installAdapter({ appURL, prefix, portMarker }) {
    const isApp = location.href === appURL;
    const state = {
        boot: crypto.randomUUID(), href: location.href, role: isApp ? 'app' : 'site', blockGM: false,
        reads: 0, allowedReads: 0, blockedReads: 0, mailboxAttempts: [], packets: [], attachments: [],
        holdHello: false, heldHello: [], releaseHello: undefined, send: undefined
    };
    globalThis.__kwxPortAdapter = state;
    const ports = new WeakMap();
    const nativePost = MessagePort.prototype.postMessage;
    let sequence = 0, lastRequest;
    const record = (port, direction, data) => {
        if (data?.marker !== portMarker) return;
        state.packets.push({ at: Date.now(), port: ports.get(port), direction, data: structuredClone(data) });
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
    MessagePort.prototype.postMessage = function (data, ...rest) {
        if (data?.marker !== portMarker) return nativePost.call(this, data, ...rest);
        observe(this);
        if (!isApp && data.kind === 'request') lastRequest = { port: this, data };
        if (isApp && state.holdHello && data.kind === 'reply' && data.value?.packet?.operation === 'hello') {
            state.heldHello.push({ port: this, data, rest });
            return;
        }
        record(this, 'sent', data);
        return nativePost.call(this, data, ...rest);
    };
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.marker !== portMarker) return;
        for (const port of event.ports) observe(port);
        state.attachments.push({ at: Date.now(), trusted: event.isTrusted,
            worker: event.source?.scriptURL, data: structuredClone(event.data) });
    });
    state.releaseHello = (dropFirst = false) => {
        state.holdHello = false;
        const pending = state.heldHello.splice(0);
        const released = dropFirst ? pending.slice(1) : pending;
        for (const { port, data, rest } of released) {
            record(port, 'sent', data);
            nativePost.call(port, data, ...rest);
        }
        return released.length;
    };
    state.send = envelope => {
        if (!lastRequest) throw new Error('No physical website port available');
        lastRequest.port.postMessage({ ...lastRequest.data, value: envelope });
    };
    state.snapshot = () => ({
        boot: state.boot, href: state.href, role: state.role, blockGM: state.blockGM,
        reads: state.reads, allowedReads: state.allowedReads, blockedReads: state.blockedReads,
        mailboxAttempts: state.mailboxAttempts, packets: state.packets, attachments: state.attachments,
        heldHello: state.heldHello.length
    });
    function mailbox(operation, key) {
        if (!String(key).startsWith('keewebx-connect-mailbox-v1:')) return;
        state.mailboxAttempts.push({ operation, key });
        throw new Error('MessagePort acceptance forbids mailbox fallback');
    }
    function blocked() {
        state.reads++;
        if (!isApp || !state.blockGM) return false;
        state.blockedReads++;
        return true;
    }
    return {
        info: { scriptHandler: 'Userscripts', script: { filename: 'Connect.user.js' } },
        async listValues() {
            if (blocked()) return new Promise(() => {});
            state.allowedReads++;
            const values = await chrome.storage.local.get();
            return Object.keys(values).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
        },
        async getValue(key, fallback) {
            mailbox('getValue', key);
            if (blocked()) return new Promise(() => {});
            state.allowedReads++;
            const values = await chrome.storage.local.get(prefix + key);
            return (prefix + key) in values ? values[prefix + key] : fallback;
        },
        async setValue(key, value) { mailbox('setValue', key); await chrome.storage.local.set({ [prefix + key]: value }); },
        async deleteValue(key) { mailbox('deleteValue', key); await chrome.storage.local.remove(prefix + key); },
        getTab: () => chrome.runtime.sendMessage({ op: 'getTab' }),
        saveTab: value => chrome.runtime.sendMessage({ op: 'saveTab', value })
    };
}

// Browser routing cannot reliably intercept service-worker script updates.
// A disposable TLS forward proxy serves the actual assets at their published
// origin, including worker installation, without changing the installer endpoint.
async function publishedOriginServer() {
    const pem = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', '-', '-out', '-', '-days', '1', '-subj', '/CN=keewebx.app'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    tlsServer = createHTTPSServer({ key: pem, cert: pem }, async (request, response) => {
        try {
            const url = new URL(request.url, APP);
            if (url.origin !== new URL(APP).origin || request.headers.host !== new URL(APP).host) {
                response.writeHead(421).end(); return;
            }
            assetRequests.set(url.pathname, (assetRequests.get(url.pathname) || 0) + 1);
            let path = url.pathname.replace(/^\/app(?=\/|$)/, '') || '/next.html';
            if (path === '/') path = '/next.html';
            const upstream = await fetch(APP_SERVER + path + url.search, { signal: AbortSignal.timeout(10000) });
            const headers = Object.fromEntries([...upstream.headers].filter(([key]) =>
                !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key)));
            headers['cache-control'] = 'no-store';
            response.writeHead(upstream.status, headers);
            response.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (error) {
            report.errors.push(redact(error.message));
            response.writeHead(502).end('Disposable fixture asset server failed');
        }
    });
    tlsServer.listen(0, '127.0.0.1');
    await once(tlsServer, 'listening');
    proxyServer = createHTTPServer((_request, response) => response.writeHead(403).end());
    proxyServer.on('connect', (request, socket, head) => {
        if (request.url !== 'keewebx.app:443') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
        const upstream = connectSocket(tlsServer.address().port, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(socket); socket.pipe(upstream);
        });
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
    });
    for (const server of [tlsServer, proxyServer]) server.on('connection', socket => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    });
    proxyServer.listen(0, '127.0.0.1');
    await once(proxyServer, 'listening');
    return 'http://127.0.0.1:' + proxyServer.address().port;
}
async function setup(bundle) {
    const extension = join(OUT, 'extension');
    mkdirSync(extension, { recursive: true });
    writeFileSync(join(extension, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Disposable production MessagePort Connect fixture', version: '1.0',
        permissions: ['storage'], background: { service_worker: 'background.js' },
        content_scripts: [{ matches: ['https://*/*'], js: ['content.js'], run_at: 'document_idle', world: 'ISOLATED' }]
    }));
    writeFileSync(join(extension, 'background.js'), `
        const tabs = new Map(); globalThis.audit = [];
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local') for (const [key, value] of Object.entries(changes))
                globalThis.audit.push({ key, value: value.newValue });
        });
        chrome.runtime.onMessage.addListener((message, sender, reply) => {
            if (message.op === 'getTab') reply(tabs.get(sender.tab.id) ?? null);
            else if (message.op === 'saveTab') { tabs.set(sender.tab.id, message.value); reply(true); }
        });`);
    writeFileSync(join(extension, 'content.js'), `(() => {
        const GM = (${installAdapter.toString()})(${JSON.stringify({ appURL: APP, prefix: PREFIX, portMarker: PORT_MARK })});
        ${bundle}
    })();`);
    const proxy = await publishedOriginServer();
    context = await chromium.launchPersistentContext(join(OUT, 'profile'), {
        channel: 'chromium', headless: true, ignoreHTTPSErrors: true, proxy: { server: proxy },
        viewport: { width: 1280, height: 900 },
        args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-extensions-except=' + extension, '--load-extension=' + extension]
    });
    nativeWorker = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://'))
        || await context.waitForEvent('serviceworker', worker => worker.url().startsWith('chrome-extension://'));
    for (const page of context.pages()) await page.close();
    await context.addInitScript(() => {
        if (location.protocol !== 'https:') return;
        const observed = { documentBoot: crypto.randomUUID(), wireRequests: {}, consentCount: 0, heldFields: [], holdFields: false };
        globalThis.__kwxNativeTest = observed;
        const nativePost = window.postMessage.bind(window);
        window.postMessage = (value, ...rest) => {
            if (observed.holdFields && value?.kwConnect === 'response' && value.action === 'kwx-get-entry-fields') {
                observed.heldFields.push([value, rest]); return;
            }
            return nativePost(value, ...rest);
        };
        observed.releaseFields = () => {
            observed.holdFields = false;
            const pending = observed.heldFields.splice(0);
            for (const [value, rest] of pending) nativePost(value, ...rest);
            return pending.length;
        };
        addEventListener('message', event => {
            if (event.source === window && event.origin === location.origin && event.data?.kwConnect === 'request') {
                const name = event.data.action;
                observed.wireRequests[name] = (observed.wireRequests[name] || 0) + 1;
            }
        });
        const observe = () => {
            const seen = new WeakSet();
            const scan = () => {
                for (const dialog of document.querySelectorAll('[role="dialog"],dialog')) {
                    if ((dialog.getAttribute('aria-label') || dialog.textContent).includes('Allow browser extension access') && !seen.has(dialog)) {
                        seen.add(dialog); observed.consentCount++;
                    }
                }
            };
            new MutationObserver(scan).observe(document.body, { childList: true, subtree: true }); scan();
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true });
        else observe();
    });
    context.on('request', request => {
        if (!request.isNavigationRequest()) return;
        const url = new URL(request.url());
        if (url.origin === new URL(APP).origin && url.pathname.replace(/\/$/, '') === '/app') appNavigationRequests++;
    });
    context.on('page', page => {
        trackHelper(page);
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) trackHelper(page); });
        page.on('close', () => {
            const helper = helpers.get(page);
            if (helper) { helper.closedAt = Date.now(); helper.automaticClosure = true; }
        });
        page.on('pageerror', error => report.errors.push(redact(error.message)));
        page.on('console', message => {
            if (/Request payload|Response payload/.test(message.text())) report.errors.push('Unexpected credential payload logging');
        });
    });
    for (const account of ACCOUNTS.slice(0, 2)) await context.route(new URL(account.url).origin + '/**', route => route.fulfill({
        contentType: 'text/html', body: `<!doctype html><title>Disposable login</title>
        <style>body{font:18px system-ui;padding:80px}input{display:block;width:300px;height:40px;margin:12px}</style>
        <h1>Login</h1><form><input id="username" autocomplete="username">
        <input id="login-password" type="password" autocomplete="current-password"><button>Sign in</button></form>
        <script>window.formSubmits=0;window.credentialInputEvents=0;
        document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.formSubmits++});
        for(const input of document.querySelectorAll('input'))input.addEventListener('input',()=>{if(input.value)window.credentialInputEvents++});</script>`
    }));
}

try {
    const bundle = readFileSync(SOURCE, 'utf8');
    report.bundle = { bytes: Buffer.byteLength(bundle), sha256: createHash('sha256').update(bundle).digest('hex') };
    await step('require the production 0.6.2 installer and built MessagePort assets', async () => {
        expect(bundle).toMatch(/^\/\/ @version\s+0\.6\.2\s*$/m);
        expect(bundle).toContain(PORT_MARK);
        for (const path of ['/next.html', '/connect-port/relay.html', '/connect-port/relay.js', '/connect-port/worker.js']) {
            const response = await fetch(APP_SERVER + path, { signal: AbortSignal.timeout(10000) });
            expect(response.status, `Build and serve the production asset ${path}`).toBe(200);
            const body = await response.text();
            if (path.endsWith('.js')) {
                expect(response.headers.get('content-type')).toMatch(/javascript/);
                expect(body.trimStart()).not.toMatch(/^<!doctype|^<html/i);
            }
            expect(body.length).toBeGreaterThan(0);
        }
    });
    await step('create a real encrypted KDBX with disposable accounts for two origins', async () => {
        const source = `import * as kdbx from ${JSON.stringify(pathToFileURL(join(ROOT, 'modules/db/lib/index.ts')).href)};
            import {argon2} from ${JSON.stringify(pathToFileURL(join(ROOT, 'modules/db/test/test-support/argon2.ts')).href)};
            import {writeFileSync} from 'node:fs'; kdbx.CryptoEngine.setArgon2Impl(argon2);
            const db=kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(${JSON.stringify(DB_PASSWORD)})),'Disposable Connect');
            db.header.kdfParameters.set('M',kdbx.VarDictionary.ValueType.UInt64,kdbx.Int64.from(32768));
            db.header.kdfParameters.set('I',kdbx.VarDictionary.ValueType.UInt64,kdbx.Int64.from(2));
            for(const account of ${JSON.stringify(ACCOUNTS)}){const entry=db.createEntry(db.getDefaultGroup());
                entry.fields.set('Title',account.title);entry.fields.set('URL',account.url);entry.fields.set('UserName',account.user);
                entry.fields.set('Password',kdbx.ProtectedValue.fromString(account.password));}
            writeFileSync(${JSON.stringify(join(OUT, 'fixture.kdbx'))},new Uint8Array(await db.save()));`;
        execFileSync(BUN, ['--eval', source], { cwd: ROOT, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    });
    await setup(bundle);
    await step('authorize the original unlocked app once through the real consent dialog', async () => {
        app = await context.newPage(); await app.goto(APP); await ready(app);
        await app.locator('#open-file-input, #kdbx-file-input').first().setInputFiles(join(OUT, 'fixture.kdbx'));
        const fallback = app.getByRole('button', { name: 'Use password', exact: true });
        if (await fallback.isVisible()) await fallback.click();
        await app.locator('#password').fill(DB_PASSWORD); await app.locator('#unlock').click();
        await expect(app.locator('.entry-row').first()).toBeVisible();
        await action(app, 'toggle'); await action(app, 'config-tab'); await action(app, 'authorize');
        await expect(consent()).toBeVisible();
        const listing = consent().getByRole('checkbox', { name: 'Allow listing and searching entries', exact: true });
        if (await listing.count()) await listing.check();
        await consent().getByRole('button', { name: 'Allow', exact: true }).click();
        await untilStatus(app, /Authorized/);
        approvedRoute = structuredClone((await settings()).get(ROUTE_KEY));
        expect(approvedRoute?.messagePort).toBe(1);
        expect(approvedRoute.readyProof).toBe(1);
        expect(approvedRoute.endpoint).toBe(APP);
        originalApp = await documentState(app);
        if (BLOCK_APP_GM) await adapter(app, '__kwxPortAdapter.blockGM = true');
        await sameApp(); await noHelpers();
    });
    await step('signed ready closes the first helper while hello is held; a cached retry survives a lost first reply', async () => {
        first = await newWebsite(ACCOUNTS[0]);
        const count = helpers.size, reads = await fieldReads();
        await adapter(app, '__kwxPortAdapter.holdHello = true');
        try {
            await startLookup(first);
            await expect.poll(async () => (await snapshot(app)).heldHello, { timeout: 25000 }).toBeGreaterThanOrEqual(1);
            await expect.poll(() => helpers.size).toBe(count + 1);
            const helper = [...helpers.keys()][count];
            await expect.poll(() => helper.isClosed(), { timeout: 2000, message: 'Signed ready must close the helper while RPC hello is held' }).toBe(true);
            await closedHelper(first, count);
            await expect.poll(async () => (await snapshot(app)).heldHello, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
            expect(helper.isClosed()).toBe(true);
            const helloRepliesHeld = (await snapshot(app)).heldHello, port = await physicalPort(first);
            const { packets } = await snapshot(first);
            const hellos = packets.filter(item => item.direction === 'sent' && item.data.kind === 'request'
                && item.data.value?.packet?.operation === 'hello');
            expect(hellos.length).toBeGreaterThanOrEqual(2);
            expect(new Set(hellos.map(item => JSON.stringify(item.data.value))).size).toBe(1);
            expect(packets.filter(item => item.direction === 'received'
                && item.data.value?.packet?.operation === 'hello')).toHaveLength(0);
            expect(await shadowValue(first, '[data-action="entry-0"]')).toBe(null);
            for (const account of ACCOUNTS) expect(await entries(first)).not.toContain(account.title);
            await emptyFields(first);
            expect(await fieldReads()).toBe(reads);
            expect(await adapter(app, '__kwxPortAdapter.releaseHello(true)')).toBeGreaterThanOrEqual(1);
            await matchingList(first, ACCOUNTS[0], reads);
            await fill(first, ACCOUNTS[0]);
            expect(await app.evaluate(() => document.hidden)).toBe(true);
            expect(await physicalPort(first)).toEqual(port);
            return { helloRepliesHeld, droppedFirstHelloReply: true, identicalHelloRetries: true, physicalPortReused: true };
        } finally { await adapter(app, '__kwxPortAdapter.releaseHello()'); }
    });
    await step('Find accounts on another origin opens one temporary helper and matches only that origin', async () => {
        second = await newWebsite(ACCOUNTS[1]);
        const count = helpers.size, reads = await fieldReads();
        // Open settings before selecting a field, so the first lookup uses Find accounts.
        await config(second); await action(second, 'accounts-tab');
        expect(helpers.size).toBe(count);
        await second.locator('#username').click(); await action(second, 'lookup');
        await matchingList(second, ACCOUNTS[1], reads); await closedHelper(second, count);
        await fill(second, ACCOUNTS[1]);
        const a = await physicalPort(first), b = await physicalPort(second);
        expect(a.connection).not.toBe(b.connection);
    });
    await step('Test connection is sufficient to attach a fresh website without an Open action', async () => {
        const website = await newWebsite(ACCOUNTS[0]), count = helpers.size;
        try {
            await config(website); expect(helpers.size).toBe(count);
            await probe(website); await closedHelper(website, count);
            const port = await physicalPort(website);
            await lookup(website, ACCOUNTS[0]); await fill(website, ACCOUNTS[0]);
            expect(await physicalPort(website)).toEqual(port); expect(helpers.size).toBe(count + 1);
        } finally { await archive(website); await website.close(); }
    });
    await step('six alternating fills and repeated UI tests reuse both physical ports with no idle helpers', async () => {
        const count = helpers.size, ports = [await physicalPort(first), await physicalPort(second)];
        for (let index = 0; index < 3; index++) for (const [page, account, port] of [
            [first, ACCOUNTS[0], ports[0]], [second, ACCOUNTS[1], ports[1]]
        ]) {
            await clearFields(page); await lookup(page, account); await fill(page, account);
            await config(page); await probe(page); await action(page, 'close');
            expect(await physicalPort(page)).toEqual(port); await sameApp(); await noHelpers();
        }
        await first.waitForTimeout(350);
        expect(helpers.size).toBe(count);
        return { alternatingFills: 6, persistentPhysicalPorts: 2, idleHelpers: 0 };
    });
    await step('real field fills succeed with all app GM reads blocked while website foreground reads work', async () => {
        const count = helpers.size;
        const before = await adapter(app, '(__kwxPortAdapter.blockGM = true, __kwxPortAdapter.snapshot())');
        try {
            for (const [page, account] of [[first, ACCOUNTS[0]], [second, ACCOUNTS[1]]]) {
                const websiteReads = (await snapshot(page)).allowedReads;
                await clearFields(page); await lookup(page, account); await fill(page, account);
                expect((await snapshot(page)).allowedReads).toBeGreaterThan(websiteReads);
            }
            const after = await snapshot(app);
            expect(after.blockGM).toBe(true);
            expect(after.allowedReads).toBe(before.allowedReads);
            expect(after.mailboxAttempts).toEqual([]);
            expect(helpers.size).toBe(count); await sameApp(); await noHelpers();
            return { appReadsAttemptedWhileBlocked: after.blockedReads - before.blockedReads, filledOrigins: 2 };
        } finally {
            if (!BLOCK_APP_GM) await adapter(app, '__kwxPortAdapter.blockGM = false');
        }
    });
    await step('a correctly signed forged site origin cannot use a port bound to another website', async () => {
        const before = await fieldReads(), count = helpers.size;
        const document = await snapshot(first);
        const hello = document.packets.find(item => item.direction === 'sent' && item.data.value?.packet?.operation === 'hello');
        expect(hello).toBeTruthy();
        const packet = { ...hello.data.value.packet, id: randomUUID(), origin: new URL(ACCOUNTS[1].url).origin, deadline: Date.now() + 1500 };
        const identity = (await settings()).get(IDENTITY_KEY);
        const key = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([
            Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(identity.secretKey, 'base64').subarray(0, 32)
        ]) });
        const envelope = { packet, signature: sign(null, Buffer.from(stable(packet)), key).toString('base64') };
        expect(validSignature(envelope)).toBe(true);
        await adapter(first, `__kwxPortAdapter.send(${JSON.stringify(envelope)})`);
        await first.waitForTimeout(1700);
        const replies = (await snapshot(first)).packets.filter(item => item.direction === 'received' && item.data.value?.packet?.id === packet.id);
        expect(replies.every(item => Boolean(item.data.value.packet.error))).toBe(true);
        expect(await fieldReads()).toBe(before); expect(helpers.size).toBe(count);
        await clearFields(first); await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]); await sameApp();
    });
    await step('closing the UI cancels a pending fill before its actual encrypted response', () => cancelPending(first, 'close'));
    await step('switching away cancels a pending fill without replacing the physical port', () => cancelPending(first, 'hidden'));
    await step('website reload rebuilds one port to the same original app and closes one helper', async () => {
        const before = await physicalPort(first), count = helpers.size;
        await archive(first); await first.reload(); await ready(first);
        expect(helpers.size).toBe(count);
        await lookup(first, ACCOUNTS[0]); await closedHelper(first, count); await fill(first, ACCOUNTS[0]);
        const after = await physicalPort(first);
        expect(after.boot).not.toBe(before.boot); expect(after.connection).not.toBe(before.connection);
        await sameApp();
    });
    await step('SPA history navigation rebuilds a port without reloading or replacing the App', async () => {
        const page = await newWebsite(ACCOUNTS[0]);
        try {
            let count = helpers.size;
            await lookup(page, ACCOUNTS[0]); await closedHelper(page, count); await fill(page, ACCOUNTS[0]);
            const before = await snapshot(page);
            const connection = before.packets.filter(item => item.direction === 'sent' && item.data.kind === 'request').at(-1).data.connectionId;
            await page.evaluate(() => history.pushState({}, '', '/spa/login?step=2#details'));
            count = helpers.size;
            await clearFields(page); await lookup(page, ACCOUNTS[0]); await closedHelper(page, count); await fill(page, ACCOUNTS[0]);
            const after = await snapshot(page);
            expect(after.boot).toBe(before.boot);
            expect(after.packets.filter(item => item.direction === 'sent' && item.data.kind === 'request').at(-1).data.connectionId).not.toBe(connection);
            await sameApp(); await noHelpers();
        } finally { await archive(page); await page.close(); }
    });
    await step('lock denies lookup and one unlock restores fills without another consent', async () => {
        const count = helpers.size, port = await physicalPort(first);
        await app.bringToFront(); await expect(app.locator('#sync-state')).toContainText('Up to date');
        await app.getByRole('button', { name: 'Lock', exact: true }).click(); await expect(app.locator('#password')).toBeVisible();
        await clearFields(first); const reads = await fieldReads(); await startLookup(first);
        await untilStatus(first, /locked.*unlock/i, 10000);
        await emptyFields(first); expect(await fieldReads()).toBe(reads);
        await sameApp({ unlocked: false }); expect(helpers.size).toBe(count);
        await app.bringToFront(); await app.locator('#password').fill(DB_PASSWORD); await app.locator('#unlock').click();
        await expect(app.locator('.entry-row').first()).toBeVisible(); await untilStatus(app, /Authorized/);
        await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]);
        expect(await physicalPort(first)).toEqual(port); expect(helpers.size).toBe(count); await sameApp(); await noHelpers();
    });
    await step('after every website closes a fresh site finds the original app three times', async () => {
        for (const account of [ACCOUNTS[1], ACCOUNTS[0], ACCOUNTS[1]]) {
            await noHelpers();
            for (const page of context.pages()) if (page !== app) { await archive(page); await page.close(); }
            first = second = undefined;
            expect(context.pages()).toEqual([app]); await sameApp();
            const count = helpers.size;
            first = await newWebsite(account); await config(first); await probe(first);
            await closedHelper(first, count); await lookup(first, account); await fill(first, account);
            expect(context.pages()).toHaveLength(2); await sameApp(); await noHelpers();
        }
    });
    await step('a generic timeout and its late signed hello never open or navigate another app', async () => {
        await archive(first); await first.reload(); await ready(first); await config(first);
        const count = helpers.size;
        await adapter(app, '__kwxPortAdapter.holdHello = true');
        try {
            await action(first, 'probe');
            await expect.poll(async () => (await snapshot(app)).heldHello).toBeGreaterThanOrEqual(1);
            await closedHelper(first, count);
            expect((await snapshot(app)).heldHello).toBeGreaterThanOrEqual(1);
            const timedOut = await untilStatus(first, /timed out|timeout|did not (?:reply|respond)|Visit your existing|unresponsive/i, 30000);
            await emptyFields(first); await sameApp(); expect(helpers.size).toBe(count + 1);
            expect(await adapter(app, '__kwxPortAdapter.releaseHello()')).toBeGreaterThanOrEqual(1);
            await first.waitForTimeout(350);
            expect(await status(first)).toBe(timedOut); await emptyFields(first);
            expect(helpers.size).toBe(count + 1); await sameApp(); await noHelpers();
        } finally { await adapter(app, '__kwxPortAdapter.releaseHello()'); }
        // A real timeout discards the failed port. Only this explicit user retry
        // may establish another port; idle time and late replies open nothing.
        await lookup(first, ACCOUNTS[1]); await closedHelper(first, count + 1); await fill(first, ACCOUNTS[1]);
        await sameApp(); await noHelpers();
    });
    await step('revocation denies an attached site and a fresh document without another app or consent', async () => {
        await clearFields(first); await lookup(first, ACCOUNTS[1]);
        const reads = await fieldReads(), count = helpers.size;
        await app.bringToFront(); await action(app, 'revoke'); await untilStatus(app, /Disconnected/);
        await first.bringToFront(); await startLookup(first);
        await untilStatus(first, /revoked|authorize|disabled|Enable Connect|disconnected|selected app changed|session changed|no longer connected/i, 15000);
        await emptyFields(first); expect(await fieldReads()).toBe(reads);
        expect((await settings()).has(ROUTE_KEY)).toBe(BLOCK_APP_GM);
        second = await newWebsite(ACCOUNTS[0]); await startLookup(second);
        await untilStatus(second, /authorize|disabled|Enable Connect/i); await emptyFields(second);
        expect(await fieldReads()).toBe(reads);
        if (!BLOCK_APP_GM) expect(helpers.size).toBe(count);
        await sameApp({ authorized: false }); await noHelpers();
    });
    await step('audit real worker provenance, signed encrypted port traffic and automatic helper closure', async () => {
        for (const page of context.pages()) await archive(page);
        const allDocuments = [...documents.values()];
        const traffic = allDocuments.flatMap(document => document.packets);
        const packets = traffic.filter(item => item.data.value?.packet);
        expect(packets.length).toBeGreaterThan(30);
        expect(packets.every(item => validSignature(item.data.value))).toBe(true);
        const privateActions = new Set(['kwx-pair', 'kwx-features', 'kwx-get-entries', 'kwx-get-entry-fields']);
        const sensitive = packets.map(item => item.data.value.packet.body).filter(body => privateActions.has(body?.action));
        expect(sensitive.length).toBeGreaterThan(10);
        expect(sensitive.every(body => typeof body.message === 'string' && typeof body.nonce === 'string'
            && !('values' in body) && !('suggested' in body))).toBe(true);
        const appDocument = allDocuments.find(document => document.role === 'app');
        const attachments = appDocument.attachments.filter(item => item.data.kind === 'attach-port');
        const signedReadyBeforeClosure = [...helpers.values()].filter(helper => helper.signedReadyBeforeClosure).length;
        const readyProofs = traffic.filter(item => item.direction === 'received' && item.data.kind === 'ready');
        expect(readyProofs.length).toBeGreaterThanOrEqual(signedReadyBeforeClosure);
        expect(readyProofs.every(item => validReadyProof(item.data) && item.data.appBoot === approvedRoute.host
            && item.data.endpoint === APP && ACCOUNTS.slice(0, 2).some(account => new URL(account.url).origin === item.data.siteOrigin))).toBe(true);
        expect(attachments.length).toBeGreaterThanOrEqual(signedReadyBeforeClosure);
        expect(attachments.every(item => item.trusted && item.worker === 'https://keewebx.app/connect-port/worker.js'
            && item.data.appBoot === approvedRoute.host && item.data.endpoint === APP)).toBe(true);
        expect(assetRequests.get('/connect-port/worker.js')).toBeGreaterThan(0);
        expect(await app.evaluate(() => navigator.serviceWorker.controller?.scriptURL || '')).not.toContain('/connect-port/worker.js');
        for (const document of allDocuments) expect(document.mailboxAttempts).toEqual([]);
        const audit = await nativeWorker.evaluate(() => globalThis.audit);
        expect(audit.length).toBeGreaterThan(0);
        expect(audit.some(item => item.key.includes('keewebx-connect-mailbox-v1:'))).toBe(false);
        const serialized = JSON.stringify({ audit, traffic });
        for (const secret of PRIVATE_VALUES) expect(serialized).not.toContain(secret);
        await noHelpers();
        expect(signedReadyBeforeClosure).toBeGreaterThanOrEqual(10);
        report.transportAudit = { signedEnvelopes: packets.length, encryptedSensitiveEnvelopes: sensitive.length,
            signedReadyProofs: readyProofs.length, signedReadyBeforeClosure,
            nativeWorkerAttachments: attachments.length, mailboxFallbacks: 0, noPlaintext: true };
        return report.transportAudit;
    });
    expect(report.errors).toEqual([]);
    report.passed = true;
} catch (error) {
    report.passed = false; report.failure = redact(error.stack || error); console.error(report.failure);
    for (const [name, page] of [['app', app], ['first', first], ['second', second]]) {
        if (page && !page.isClosed()) {
            report[name + 'Status'] = await status(page).catch(() => null);
            const document = await snapshot(page).catch(() => null);
            if (document) report[name + 'Diagnostics'] = {
                boot: document.boot, role: document.role, blockedReads: document.blockedReads,
                mailboxAttempts: document.mailboxAttempts,
                traffic: document.packets.map(item => ({ port: item.port, direction: item.direction,
                    kind: item.data.kind, operation: item.data.value?.packet?.operation, error: item.data.value?.packet?.error }))
            };
        }
    }
    process.exitCode = 1;
} finally {
    report.finished = new Date().toISOString();
    report.appNavigationRequests = appNavigationRequests;
    report.helpers = { opened: helpers.size, automaticallyClosed: [...helpers.values()].filter(helper => helper.automaticClosure).length,
        signedReadyBeforeClosure: [...helpers.values()].filter(helper => helper.signedReadyBeforeClosure).length,
        remaining: context ? context.pages().filter(page => helperURL(page.url())).length : 0, lifecycle: [...helpers.values()] };
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: join(OUT, 'report.json'), passed: report.passed }));
    await context?.close();
    for (const socket of sockets) socket.destroy();
    for (const server of [proxyServer, tlsServer]) if (server?.listening) await new Promise(resolve => server.close(resolve));
}
