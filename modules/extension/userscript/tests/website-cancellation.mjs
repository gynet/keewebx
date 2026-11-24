// Real website controller, closed-root UI, NativeRpc and SitePortLink in both engines.
// Only GM and the remote peer are fixtures; helper handoff uses real windows/ports.
// Repro: node modules/extension/userscript/tests/website-cancellation.mjs chromium webkit
// KWX_WEBSITE_SOURCE permits a read-only negative control from git show.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(path.join(repo, 'modules/extension/package.json'));
const browsers = require('@playwright/test');
const { sign } = require('tweetnacl');
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit'];
assert(engines.every(name => ['chromium', 'webkit'].includes(name)));
const endpoint = 'https://keewebx.app/app';
const site = 'https://website-cancellation.example.test';
const keys = sign.keyPair();
const identity = { publicKey: Buffer.from(keys.publicKey).toString('base64'), secretKey: Buffer.from(keys.secretKey).toString('base64') };
const route = { host: crypto.randomUUID(), owner: crypto.randomUUID(), endpoint, publicKey: identity.publicKey,
    messagePort: 1, readyProof: 1, authorizationRevision: 1 };
const src = path.join(repo, 'modules/extension/userscript/src');
const fixture = `
    import { watchTransport } from ${JSON.stringify(path.join(src, 'transport-events.ts'))};
    import { signPortReady } from ${JSON.stringify(path.join(src, 'port-auth.ts'))};
    import { sign } from ${JSON.stringify(require.resolve('tweetnacl'))};
    const secret = Uint8Array.from(atob(${JSON.stringify(identity.secretKey)}), c => c.charCodeAt(0));
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
    const record = data => window.fixture.events.push({ at: performance.now(), ...data });
    window.fixture = { events: [], peers: [], requests: [], releases: 0 };
    watchTransport(record);
    for (const type of ['pointerdown', 'focus']) addEventListener(type, event => {
        if (event.isTrusted) record({ event: type === 'focus' ? 'page-focus' : 'page-interaction', windowTarget: event.target === window });
    }, true);
    addEventListener('message', event => {
        if (!event.isTrusted || event.origin !== 'https://keewebx.app' || !event.data?.fixturePeer || event.ports.length !== 1) return;
        const binding = event.data.binding, port = event.ports[0];
        const peer = { binding, port, closed: false };
        window.fixture.peers.push(peer);
        port.onmessage = ({ data }) => {
            if (data.kind === 'close') { peer.closed = true; return; }
            if (data.kind !== 'request') return;
            const request = data.value.packet;
            window.fixture.requests.push(request.operation);
            if (request.operation === 'release') { window.fixture.releases++; return; }
            // Credential protocol is deliberately unavailable in this transport/UI fixture.
            if (!['hello', 'probe'].includes(request.operation)) return;
            const body = request.operation === 'hello'
                ? { scope: crypto.randomUUID(), appBoot: binding.appBoot, expiresAt: Date.now() + 120000 }
                : { visibility: 'visible' };
            const packet = canonical({ ...request, type: 'reply', body });
            const signature = btoa(String.fromCharCode(...sign.detached(new TextEncoder().encode(JSON.stringify(packet)), secret)));
            port.postMessage({ ...binding, kind: 'reply', value: { packet, signature } });
        };
        window.fixture.releaseSetup = () => port.postMessage({ ...binding, kind: 'ready', proof: signPortReady(binding, secret) });
    });
    void import(${JSON.stringify(path.join(src, 'simple-connect.ts'))});
`;
const bundle = execFileSync(process.env.KWX_BUN || 'bun', ['-e', `
    const result = await Bun.build({ entrypoints: ['virtual:website-cancellation'], target: 'browser', format: 'iife',
        plugins: [{ name: 'website-cancellation', setup(builder) {
            builder.onResolve({filter: /^virtual:website-cancellation$/}, () => ({path:'fixture.ts',namespace:'fixture'}));
            builder.onLoad({filter: /.*/,namespace:'fixture'}, () => ({loader:'ts',contents:${JSON.stringify(fixture)}}));
            if (process.env.KWX_WEBSITE_SOURCE) builder.onLoad({filter: /simple-connect[.]ts$/}, async () => ({
                loader:'ts', contents:await Bun.file(process.env.KWX_WEBSITE_SOURCE).text()
            }));
        }}] });
    if (!result.success) throw new AggregateError(result.logs, 'Website cancellation fixture build failed');
    await Bun.write(Bun.stdout, await result.outputs[0].text());
`], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

const helper = `<!doctype html><title>Controlled remote peer</title><script>
    const query = new URL(location.href).searchParams;
    addEventListener('message', event => {
        if (event.source !== opener || event.origin !== query.get('site') || event.data?.kind !== 'attach') return;
        // Keep the remote endpoint alive in the fixture after the real helper closes.
        opener.postMessage({ fixturePeer: true, binding: event.data }, event.origin, event.ports);
    });
    opener.postMessage({ marker:'keewebx-connect-port-v1',kind:'relay-ready',nonce:query.get('nonce'),endpoint:query.get('endpoint') }, query.get('site'));
</script>`;
const report = { source: process.env.KWX_WEBSITE_SOURCE || 'working tree', engines: {} };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const state = page => page.evaluate(() => window.testRoot.querySelector('[data-state]').dataset.state);
async function click(page, action) {
    const box = await page.evaluate(action => {
        const element = window.testRoot.querySelector(action.startsWith('[') || action.startsWith('.') ? action : '[data-action="' + action + '"]');
        element.scrollIntoView({ block: 'nearest' });
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, action);
    await page.mouse.click(box.x, box.y);
    await settle(page);
}
async function pending(page, action = 'probe') {
    const count = await page.evaluate(() => window.fixture.peers.length);
    await page.evaluate(() => { window.fixture.events = []; });
    await click(page, action);
    await page.waitForFunction(count => window.fixture.peers.length === count + 1, count);
    await page.bringToFront();
    await settle(page);
    assert.equal(await state(page), 'Connecting');
    const events = await page.evaluate(() => window.fixture.events);
    const accepted = events.findIndex(event => event.action === (action === 'toggle' ? 'panel-open' : action));
    assert(accepted >= 0 && accepted < events.findIndex(event => event.event === 'relay-opened'), 'Action must precede setup');
    await page.evaluate(() => { window.fixture.events = []; });
}
async function preserved(page) {
    assert.equal(await state(page), 'Connecting');
    assert.equal(await page.evaluate(() => window.fixture.events.some(event => event.event === 'port-rejected' && event.detail === 'closed')), false);
    assert.equal(await page.evaluate(() => window.fixture.peers.at(-1).closed), false);
}
async function canceled(page, action) {
    await page.waitForFunction(() => window.fixture.peers.at(-1).closed);
    assert.equal(await state(page), 'ReadyToConnect');
    const events = await page.evaluate(() => window.fixture.events);
    const closed = events.findIndex(event => event.event === 'port-rejected' && event.detail === 'closed');
    const ready = events.findIndex(event => event.state === 'ReadyToConnect');
    assert(closed >= 0 && ready > closed, 'Expected closed then ReadyToConnect');
    if (action) {
        const accepted = events.findIndex(event => event.action === action);
        assert(accepted >= 0 && accepted < closed, 'Action must precede cancellation');
    }
    assert(!events.some(event => event.state === 'Error' || event.event === 'discovery-timeout'));
}
async function completes(page) {
    await page.evaluate(() => window.fixture.releaseSetup());
    await page.waitForFunction(() => window.testRoot.querySelector('[data-state]').dataset.state === 'Connected');
    await page.waitForFunction(() => window.fixture.peers.at(-1).closed);
    assert.deepEqual(await page.evaluate(() => window.fixture.requests.slice(-3)), ['hello', 'probe', 'release']);
    assert.deepEqual(await page.locator('form input').evaluateAll(inputs => inputs.map(input => input.value)), ['', '']);
}

for (const engine of engines) {
    const browser = await browsers[engine].launch({ headless: true });
    const cases = report.engines[engine] = [];
    async function check(name, test) {
        const context = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ identity, route }) => {
            const storage = new Map([
                ['keewebx-userscript-connect-identity-v1', identity],
                ['keewebx-native-connect-v1:selected:' + route.endpoint, route]
            ]);
            window.GM = { getValue: async key => storage.get(key), setValue: async (key, value) => storage.set(key, value),
                deleteValue: async key => storage.delete(key), getTab: async () => ({}), saveTab: async () => {} };
            const attach = Element.prototype.attachShadow;
            Element.prototype.attachShadow = function(options) {
                const root = attach.call(this, options);
                window.testRoot = root;
                return root;
            };
        }, { identity, route });
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            return route.fulfill(url.pathname === '/fixture.js' ? { contentType: 'application/javascript', body: bundle }
                : { contentType: 'text/html', body: url.origin === 'https://keewebx.app' ? helper
                    : `<!doctype html><style>body{min-height:2000px}form{margin:30px}input{display:block;width:230px;height:30px;margin:8px}#outside{position:absolute;left:600px;top:30px}</style>
                        <button id="outside">Ordinary page button</button><form><input id="user" autocomplete="username"><input id="password" type="password"></form><script src="/fixture.js"></script>` });
        });
        try {
            await page.goto(site);
            await page.waitForFunction(() => window.testRoot?.querySelector('[data-state]')?.dataset.state === 'ReadyToConnect');
            assert.equal(await page.evaluate(() => document.getElementById('keewebx-userscript-connect').shadowRoot), null);
            // Opening the launcher performs an initial probe. Finish it before arranging each case.
            await pending(page, 'toggle');
            await completes(page);
            await click(page, 'config-tab');
            await test(page);
            assert.deepEqual(errors, []);
            for (const event of await page.evaluate(() => window.fixture.events)) {
                if (event.action) assert.deepEqual(Object.keys(event).sort(), ['action', 'at'], 'UI action log must contain no field or account data');
            }
            cases.push({ name, passed: true });
        } catch (error) {
            cases.push({ name, passed: false, error: String(error.message || error),
                events: await page.evaluate(() => window.fixture?.events).catch(() => []) });
        } finally { await context.close(); }
        console.log(`${cases.at(-1).passed ? 'PASS' : 'FAIL'} ${engine}: ${name}`);
    }
    try {
        await check('switching informational tabs preserves pending probe and its eventual result', async page => {
            await pending(page);
            await click(page, 'accounts-tab'); await preserved(page);
            await click(page, 'config-tab'); await preserved(page);
            assert.deepEqual(await page.evaluate(() => window.fixture.events.filter(event => event.action).map(event => event.action)), ['accounts', 'config']);
            await completes(page);
        });
        for (const activation of ['mouse', 'Enter', 'Space']) await check(`reselecting Connection with ${activation} preserves pending setup`, async page => {
            await pending(page);
            if (activation === 'mouse') await click(page, 'config-tab');
            else {
                await page.evaluate(() => window.testRoot.querySelector('[data-action=config-tab]').focus());
                await page.keyboard.press(activation); await settle(page);
            }
            await preserved(page); await completes(page);
        });
        await check('Connection can inspect a pending account lookup without canceling it', async page => {
            await click(page, 'accounts-tab'); await pending(page, 'lookup');
            await click(page, 'config-tab'); await preserved(page);
            await click(page, 'close'); await canceled(page, 'panel-close');
            assert.equal(await page.evaluate(() => window.fixture.requests.includes('wire')), false);
        });
        await check('ordinary field/page focus and log expansion do not cancel setup', async page => {
            await pending(page);
            await page.locator('#user').click(); await preserved(page);
            await page.locator('#password').click(); await preserved(page);
            await page.locator('#outside').click(); await preserved(page);
            assert(await page.evaluate(() => window.fixture.events.some(event => event.event === 'page-focus' && !event.windowTarget)));
            await click(page, '.kwx-connect__local-log summary'); await preserved(page);
            await completes(page);
        });
        for (const action of ['close', 'toggle', 'Escape']) await check(`explicit ${action} still cancels`, async page => {
            await pending(page);
            if (action === 'Escape') {
                await page.evaluate(() => window.testRoot.querySelector('[data-action=config-tab]').focus());
                await page.keyboard.press('Escape'); await settle(page);
            } else await click(page, action);
            await canceled(page, action === 'Escape' ? 'escape' : 'panel-close');
            // Late transport readiness cannot revive a canceled operation.
            await page.evaluate(() => window.fixture.releaseSetup()); await settle(page);
            assert.equal(await state(page), 'ReadyToConnect');
        });
        await check('explicit reconnect replaces the pending operation', async page => {
            await pending(page);
            const previous = await page.evaluate(() => window.fixture.peers.length - 1);
            await pending(page, 'open');
            assert.equal(await page.evaluate(index => window.fixture.peers[index].closed, previous), true);
            await completes(page);
        });
        await check('URL change still cancels pending setup', async page => {
            await pending(page);
            await page.evaluate(() => { location.hash = 'different'; });
            await canceled(page);
        });
        await check('losing all visible login anchors retains existing cancellation', async page => {
            await pending(page);
            await page.evaluate(() => { document.querySelector('form').hidden = true; });
            await canceled(page, 'anchor-lost');
        });
        for (const [control, action] of [['save', 'save'], ['auto-fill-single', 'preference']]) {
            await check(`${action} still cancels and records its action before closing the port`, async page => {
                await pending(page); await click(page, control); await canceled(page, action);
            });
        }
        await check('untrusted UI events cannot cancel or reconnect', async page => {
            await pending(page);
            const count = await page.evaluate(() => window.fixture.peers.length);
            await page.evaluate(() => {
                for (const action of ['close', 'toggle', 'config-tab', 'open']) window.testRoot.querySelector('[data-action=' + action + ']').click();
                window.testRoot.querySelector('[data-action=config-tab]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            });
            await preserved(page);
            assert.equal(await page.evaluate(() => window.fixture.peers.length), count);
            assert.deepEqual(await page.evaluate(() => window.fixture.events.filter(event => event.action)), []);
            await completes(page);
        });
    } finally { await browser.close(); }
}
const output = process.env.KWX_WEBSITE_RESULTS || path.join(tmpdir(), 'keewebx-website-cancellation-results.json');
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
const cases = Object.values(report.engines).flat();
console.log(`${cases.filter(test => test.passed).length}/${cases.length} passed; ${output}`);
assert(cases.every(test => test.passed), 'Website cancellation regression failed');
