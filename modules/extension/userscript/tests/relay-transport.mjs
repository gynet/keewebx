// Transport classes only: real HTTPS pages and BroadcastChannel; no vault,
// protocol mock, credentials, extension, native approval, or iOS execution.
// node modules/extension/userscript/tests/relay-transport.mjs chromium webkit
// Portable overrides: KWX_REPO_ROOT, KWX_BUN, KWX_CHROMIUM_EXECUTABLE,
// KWX_WEBKIT_EXECUTABLE, KWX_WEBKIT_LIB, KWX_RELAY_REPORT; FORM_GUARD_* aliases
// match form-guards.mjs. Results default to the system temporary directory.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = process.env.KWX_REPO_ROOT || process.env.FORM_GUARD_REPO || fileURLToPath(new URL('../../../../', import.meta.url));
const bun = process.env.KWX_BUN || process.env.FORM_GUARD_BUN || (typeof Bun !== 'undefined' ? process.execPath : 'bun');
const require = createRequire(path.join(root, 'package.json'));
const { chromium, webkit, expect } = require('@playwright/test');
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit'];
assert(engines.every(name => ['chromium', 'webkit'].includes(name)), 'Use chromium and/or webkit');
const files = ['relay', 'app-bridge', 'native-rpc'].map(name => `modules/extension/userscript/src/${name}.ts`);
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')
])));
const sourceHashes = await hashes();
const source = execFileSync(bun, ['-e', `
    const result = await Bun.build({entrypoints:['modules/extension/userscript/src/relay.ts'], target:'browser', format:'esm', minify:false, sourcemap:'none'});
    if (!result.success) throw new AggregateError(result.logs, 'Actual relay class build failed');
    await Bun.write(Bun.stdout, await result.outputs[0].text());
`], { cwd: root, encoding: 'utf8', maxBuffer: 2 ** 20 });
assert.deepEqual(await hashes(), sourceHashes, 'Source changed during bundling; rerun');

const origin = 'https://relay-transport.example';
const report = { scope: 'Actual relay classes, independent HTTPS pages, native BroadcastChannel; transport only',
    nativeIOSVerified: false, nativeAuthorizationVerified: false, sourceHashes, engines: {} };

async function fixture(browser, run) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
        await context.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><title>Relay transport fixture</title><body>Transport test only</body></html>' }));
        const host = await context.newPage(), helper = await context.newPage();
        for (const [role, page] of [['host', host], ['helper', helper]]) {
            await page.goto(`${origin}/${role}`);
            assert(await page.evaluate(() => isSecureContext && window.opener === null), 'Fixture must be HTTPS and independently opened');
            await page.evaluate(async ({ source, role, origin }) => {
                const nativeTimeout = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
                const nativeAdd = BroadcastChannel.prototype.addEventListener, nativeRemove = BroadcastChannel.prototype.removeEventListener;
                const nativePost = BroadcastChannel.prototype.postMessage;
                const realNow = Date.now.bind(Date), wrappers = new WeakMap();
                const state = { offset: 0, holdKinds: [], held: [], holdTimers: false, timers: new Map(), timerCallbacks: 0,
                    sent: [], received: [], pairing: undefined, updates: [], reservation: 'idle', authorizationGateEntries: 0 };
                let timerId = -1;
                Date.now = () => realNow() + state.offset;
                window.setTimeout = (fn, delay, ...args) => {
                    if (!state.holdTimers) return nativeTimeout(fn, delay, ...args);
                    const id = timerId--; state.timers.set(id, { fn, args, delay }); return id;
                };
                window.clearTimeout = id => { if (!state.timers.delete(id)) nativeClear(id); };
                BroadcastChannel.prototype.postMessage = function (data) {
                    state.sent.push({ kind: data.kind, host: data.host, token: data.token, deadline: data.deadline });
                    return nativePost.call(this, data);
                };
                BroadcastChannel.prototype.addEventListener = function (type, listener, options) {
                    if (type !== 'message' || typeof listener !== 'function') return nativeAdd.call(this, type, listener, options);
                    const wrapped = event => {
                        state.received.push({ kind: event.data.kind, trusted: event.isTrusted, origin: event.origin, token: event.data.token });
                        // Retain the browser's original trusted event and callback.
                        // No dispatchEvent(), fabricated MessageEvent, or isTrusted override.
                        if (state.holdKinds.includes(event.data.kind)) state.held.push({ event, deliver: () => listener.call(this, event) });
                        else listener.call(this, event);
                    };
                    let map = wrappers.get(this); if (!map) wrappers.set(this, map = new Map()); map.set(listener, wrapped);
                    return nativeAdd.call(this, type, wrapped, options);
                };
                BroadcastChannel.prototype.removeEventListener = function (type, listener, options) {
                    return nativeRemove.call(this, type, wrappers.get(this)?.get(listener) || listener, options);
                };
                const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
                const { RelayHost, RelayClientBridge } = await import(blob); URL.revokeObjectURL(blob);
                const endpoint = new URL(`${origin}/app`);
                const instance = role === 'host'
                    ? new RelayHost(endpoint, request => { state.pairing = request; })
                    : new RelayClientBridge(endpoint, 'https://login.example.org', (status, count) => state.updates.push({ status, count }));
                // A real peer sends adversarial but otherwise fresh frames only in
                // discovery-expiry tests, isolating discovery TTL from envelope TTL.
                const peer = new BroadcastChannel('keewebx-connect-relay-v1:/app');
                window.transport = {
                    state, instance,
                    reserve() {
                        state.reservation = 'pending';
                        void instance.reserve().then(() => {
                            try { instance.beginAuthorization(); state.authorizationGateEntries++; state.reservation = 'resolved'; }
                            catch (error) { state.reservation = 'rejected'; state.error = error.message; }
                        }, error => { state.reservation = 'rejected'; state.error = error.message; });
                    },
                    async release(kind) {
                        const items = state.held.filter(item => item.event.data.kind === kind);
                        state.held = state.held.filter(item => item.event.data.kind !== kind);
                        for (const item of items) item.deliver();
                        await new Promise(resolve => nativeTimeout(resolve, 0));
                        return items.map(item => ({ trusted: item.event.isTrusted, origin: item.event.origin }));
                    },
                    async releaseTimers() {
                        const timers = [...state.timers.values()]; state.timers.clear();
                        for (const timer of timers) { state.timerCallbacks++; timer.fn(...timer.args); }
                        await new Promise(resolve => nativeTimeout(resolve, 0));
                    },
                    emit(data) { peer.postMessage(data); },
                    snapshot() { return { reservation: state.reservation, authorizationGateEntries: state.authorizationGateEntries,
                        timerCallbacks: state.timerCallbacks, heldTimers: state.timers.size, held: state.held.length,
                        connected: instance.connected, received: state.received, sent: state.sent, updates: state.updates }; },
                    dispose() { instance.dispose(); peer.close(); }
                };
            }, { source, role, origin });
        }
        await helper.evaluate(() => transport.instance.discover());
        await expect.poll(() => host.evaluate(() => !!transport.state.pairing), { timeout: 5000 }).toBe(true);
        await expect.poll(() => helper.evaluate(() => transport.instance.candidateCount), { timeout: 5000 }).toBe(1);
        await run({ host, helper });
    } finally { await context.close(); }
}
const snapshot = page => page.evaluate(() => transport.snapshot());
async function reserve(host) {
    await host.evaluate(() => transport.reserve());
    await expect.poll(() => host.evaluate(() => transport.state.reservation), { timeout: 5000 }).toBe('resolved');
}
async function emitFresh(host, helper, kind, token) {
    const ids = await helper.evaluate(() => ({ helper: transport.instance.helper, discovery: transport.instance.discovery, now: Date.now() }));
    const hostId = await host.evaluate(() => transport.instance.id);
    await host.evaluate(data => transport.emit(data), { marker: 'keewebx-connect-relay-v1', kind, helper: ids.helper,
        discovery: ids.discovery, host: hostId, token, sentAt: ids.now, deadline: ids.now + 65000 });
    await expect.poll(() => helper.evaluate(kind => transport.state.received.filter(event => event.kind === kind).length, kind), { timeout: 5000 }).toBeGreaterThan(0);
}

for (const engine of engines) {
    const executablePath = engine === 'chromium'
        ? process.env.KWX_CHROMIUM_EXECUTABLE || process.env.FORM_GUARD_CHROMIUM
        : process.env.KWX_WEBKIT_EXECUTABLE || process.env.FORM_GUARD_WEBKIT;
    const lib = process.env.KWX_WEBKIT_LIB || process.env.FORM_GUARD_WEBKIT_LIB;
    const browser = await ({ chromium, webkit }[engine]).launch({ headless: true,
        ...(executablePath ? { executablePath } : {}),
        ...(engine === 'webkit' && lib ? { env: { ...process.env, LD_LIBRARY_PATH: [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } } : {}) });
    const tests = report.engines[engine] = [];
    const run = async (name, test) => {
        try { await fixture(browser, test); tests.push({ name, passed: true }); console.log(`PASS ${engine}: ${name}`); }
        catch (error) { tests.push({ name, passed: false, error: error.message }); console.error(`FAIL ${engine}: ${name}: ${error.message}`); }
    };
    try {
        await run('independent same-origin discovery and committed reservation (no native authorization)', async ({ host, helper }) => {
            await reserve(host);
            const h = await snapshot(host), c = await snapshot(helper);
            assert.equal(h.authorizationGateEntries, 1);
            assert(c.updates.some(update => update.status === 'confirming'));
            assert.equal(c.connected, false, 'Reservation alone must not mark the helper ready');
            assert(h.received.some(event => event.kind === 'commit' && event.trusted && event.origin === origin));
        });
        await run('original trusted commit rejected after 8s while timeout callback is withheld', async ({ host, helper }) => {
            await host.evaluate(() => { transport.state.holdKinds = ['commit']; transport.state.holdTimers = true; transport.reserve(); });
            await expect.poll(() => host.evaluate(() => transport.state.held.length), { timeout: 5000 }).toBe(1);
            assert((await snapshot(helper)).sent.some(frame => frame.kind === 'commit'));
            await host.evaluate(() => { transport.state.offset += 9000; });
            assert.deepEqual(await host.evaluate(() => transport.release('commit')), [{ trusted: true, origin }]);
            const h = await snapshot(host);
            assert.equal(h.reservation, 'pending', 'Expired commit must not grant the reservation before the timeout callback');
            assert.equal(h.authorizationGateEntries, 0);
            assert.equal(h.heldTimers, 1);
            assert.equal(h.timerCallbacks, 0);
            await host.evaluate(() => transport.releaseTimers());
            const afterTimer = await snapshot(host);
            assert.equal(afterTimer.timerCallbacks, 1);
            assert.equal(afterTimer.reservation, 'rejected');
            assert.equal(afterTimer.authorizationGateEntries, 0);
        });
        await run('expired discovery rejects a fresh native claim instead of creating a commit', async ({ host, helper }) => {
            await helper.evaluate(() => { transport.state.offset += 121000; });
            await emitFresh(host, helper, 'claim');
            const c = await snapshot(helper);
            assert(c.received.some(event => event.kind === 'claim' && event.trusted && event.origin === origin));
            assert(!c.sent.some(frame => frame.kind === 'commit'), 'Expired discovery accepted a fresh-envelope claim');
            assert.equal((await snapshot(host)).authorizationGateEntries, 0);
        });
        await run('expired discovery rejects a fresh native ready frame for the selected host/token', async ({ host, helper }) => {
            await reserve(host);
            const token = (await snapshot(host)).received.find(event => event.kind === 'commit').token;
            assert.equal(typeof token, 'string');
            await helper.evaluate(() => { transport.state.offset += 121000; });
            await emitFresh(host, helper, 'ready', token);
            const c = await snapshot(helper);
            assert(c.received.some(event => event.kind === 'ready' && event.trusted && event.origin === origin));
            assert.equal(c.connected, false, 'Expired discovery became connected');
            assert(!c.updates.some(update => update.status === 'connected'));
        });
    } finally { await browser.close(); }
}
const output = process.env.KWX_RELAY_REPORT || path.join(os.tmpdir(), 'keewebx-userscripts-relay-transport-results.json');
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
const tests = Object.values(report.engines).flat();
console.log(`${tests.filter(test => test.passed).length}/${tests.length} transport cases passed; results: ${output}`);
assert(tests.length > 0 && tests.every(test => test.passed), 'Relay transport regression failed');
