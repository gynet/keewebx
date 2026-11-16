// Real production-app regression for one global Userscripts Connect authorization.
// GM is simulated across independent Chromium tabs; the shipped bundle, KDBX,
// native consent, ProtocolImpl, and encrypted app endpoint are real.
// KWX_APP_SERVER=http://127.0.0.1:39232 KWX_BUN=/path/to/bun node modules/extension/userscript/tests/gm-connect.mjs
// Also supports KWX_USERSCRIPT, KWX_LEGACY_APP_USERSCRIPT, KWX_REPO_ROOT, KWX_DB_ROOT,
// KWX_CHROMIUM_EXECUTABLE, KWX_E2E_OUTPUT_DIR, and KWX_E2E_REPORT.
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(process.env.KWX_REPO_ROOT || fileURLToPath(new URL('../../../..', import.meta.url)));
const DB_ROOT = resolve(process.env.KWX_DB_ROOT || ROOT);
const BUN = process.env.KWX_BUN || (typeof Bun !== 'undefined' ? process.execPath : 'bun');
const APP_SERVER = process.env.KWX_APP_SERVER || 'http://127.0.0.1:39232';
const SOURCE = resolve(process.env.KWX_USERSCRIPT || join(ROOT, 'modules/extension/userscript/keewebx-connect.user.js'));
const LEGACY_APP = process.env.KWX_LEGACY_APP_USERSCRIPT;
const OUT = process.env.KWX_E2E_OUTPUT_DIR ? resolve(process.env.KWX_E2E_OUTPUT_DIR) : mkdtempSync(join(tmpdir(), 'keewebx-gm-connect-'));
mkdirSync(OUT, { recursive: true });
const APP = 'https://keewebx.app/app';
const ROUTE_KEY = `keewebx-userscript-connect-route-v2:${APP}`;
const TRANSIENT = /^keewebx-userscript-connect-(?:request|reply)-v2:/;
const PERSISTENT = /^(?:keewebx-userscript-connect-(?:identity|settings)-v1|keewebx-userscript-connect-route-v2:.+)$/;
const DB_PASSWORD = 'Disposable-GM-vault-2026!';
const ACCOUNTS = [
    { title: 'First global Connect account', url: 'https://login.example.org/', user: 'gm-first-fixture-user', password: 'Disposable-GM-first-2026!' },
    { title: 'Second global Connect account', url: 'https://signin.example.net/', user: 'gm-second-fixture-user', password: 'Disposable-GM-second-2026!' },
    { title: 'Unrelated global Connect account', url: 'https://wrong.example.com/', user: 'gm-wrong-fixture-user', password: 'Disposable-GM-wrong-2026!' }
];
const PRIVATE_VALUES = [DB_PASSWORD, ...ACCOUNTS.flatMap(account => [account.title, account.user, account.password])];
const redact = value => PRIVATE_VALUES.reduce((result, secret) => result.replaceAll(secret, '[fixture value]'), String(value));
const report = {
    started: new Date().toISOString(), appServer: APP_SERVER, artifactDirectory: OUT,
    scope: 'Production New UI and actual bundled Connect protocol; shared simulated private GM in Chromium MAIN WORLD',
    gmMock: true, executionWorld: 'main', extensionLoaded: false, realManagerVerified: false,
    nativeIOSVerified: false, backgroundBehaviorVerified: false,
    oneAuthorizationVerified: false, twoIndependentOriginsVerified: false,
    repeatLookupVerified: false, reloadVerified: false, navigationNoFillVerified: false,
    cancellationNoFillVerified: false, expiredResponseNoFillVerified: false,
    lockedAppNoFillVerified: false, noHelperOrFocusVerified: false,
    steps: [], errors: [], payloadLogCount: 0
};
const gm = new Map();
// A native WebExtension storage bridge may serialize dictionaries in a different
// order. Persist JSON-compatible values with reversed nested key order.
const storedValue = value => JSON.parse(JSON.stringify(value, (_key, item) => !LEGACY_APP && item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().reverse().map(key => [key, item[key]])) : item));
const stableJSON = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const gmHistory = [];
const tabState = new Map();
const tabIds = new WeakMap();
const cdpByPage = new WeakMap();
let browser, context, app, first, second, originalApp, approvedRoute, heldGmReply;
let holdGmReplyFor, appNavigationRequests = 0, pageCount = 0;
let explicitFocusCalls = 0;

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

// Closed-shadow controls are inspected with CDP, just as in connect.mjs.
async function cdp(page) {
    if (!cdpByPage.has(page)) cdpByPage.set(page, await context.newCDPSession(page));
    return cdpByPage.get(page);
}
function hostIn(node) {
    if (node.attributes?.some((value, index, attributes) => index % 2 === 0 && value === 'id' && attributes[index + 1] === 'keewebx-userscript-connect')) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
        const found = hostIn(child); if (found) return found;
    }
}
async function shadowNode(page, selector, index = 0) {
    const session = await cdp(page);
    const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = hostIn(root);
    if (!host?.shadowRoots?.[0]) throw new Error('Closed-shadow Connect widget missing');
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
const fieldReads = () => app.evaluate(() => globalThis.__kwxGmTest.wireRequests['kwx-get-entry-fields'] || 0);
const documentState = page => page.evaluate(() => ({ href: location.href, timeOrigin: performance.timeOrigin, boot: globalThis.__kwxGmTest.documentBoot }));
const consent = () => app.getByRole('dialog', { name: 'Allow browser extension access', exact: true });
const pendingKeys = () => [...gm.keys()].filter(key => TRANSIENT.test(key));
async function untilStatus(page, expression, timeout = 10000) {
    await expect.poll(() => status(page), { timeout, message: `Connect status must match ${expression}` }).toMatch(expression);
    return status(page);
}
async function ready(page) {
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#keewebx-userscript-connect')).toBeAttached({ timeout: 15000 });
}
async function emptyFields(page) {
    await expect(page.locator('#username')).toHaveValue('');
    await expect(page.locator('#login-password')).toHaveValue('');
    expect(await page.evaluate(() => window.formSubmits)).toBe(0);
}
async function clearFields(page) {
    await page.locator('#username').fill('');
    await page.locator('#login-password').fill('');
}
async function lookup(page, account) {
    await page.locator('#username').click();
    const readsBefore = await fieldReads();
    if (await shadowValue(page, 'section', 'hidden')) await action(page, 'toggle');
    else { await action(page, 'accounts-tab'); await action(page, 'lookup'); }
    await expect.poll(() => entries(page), { timeout: 15000 }).toContain(account.title);
    const listed = await entries(page);
    for (const other of ACCOUNTS.filter(item => item !== account)) expect(listed).not.toContain(other.title);
    expect(await status(page)).toMatch(/Found 1 matching account/);
    expect(await fieldReads()).toBe(readsBefore);
    await emptyFields(page);
}
async function fill(page, account) {
    const readsBefore = await fieldReads();
    await action(page, 'entry-0');
    await expect(page.locator('#username')).toHaveValue(account.user, { timeout: 10000 });
    await expect(page.locator('#login-password')).toHaveValue(account.password);
    expect(await fieldReads()).toBe(readsBefore + 1);
    expect(await page.evaluate(() => window.formSubmits)).toBe(0);
}
async function assertOneApp() {
    expect(await documentState(app)).toEqual(originalApp);
    expect(appNavigationRequests).toBe(1);
    expect(context.pages()).toHaveLength(second ? 3 : 2);
    expect(pageCount).toBe(second ? 3 : 2);
    expect(gm.get(ROUTE_KEY)).toEqual(approvedRoute);
    await expect(consent()).toHaveCount(0);
    expect(await app.evaluate(() => globalThis.__kwxGmTest.consentCount)).toBe(1);
    for (const page of context.pages()) {
        const observation = await page.evaluate(() => ({ opens: globalThis.__kwxGmTest.openCalls, focuses: globalThis.__kwxGmTest.focusCalls }));
        expect(observation).toEqual({ opens: 0, focuses: page === app ? explicitFocusCalls : 0 });
        expect(await shadowValue(page, '.pairing-card', 'hidden')).not.toBe(false);
    }
}
async function holdFieldResponse(page) {
    const before = await page.evaluate(() => window.credentialInputEvents);
    const readsBefore = await fieldReads();
    await app.evaluate(() => { globalThis.__kwxGmTest.holdFields = true; });
    await action(page, 'entry-0');
    await expect.poll(() => app.evaluate(() => globalThis.__kwxGmTest.heldFields.length), { timeout: 5000 }).toBeGreaterThan(0);
    expect(await fieldReads()).toBe(readsBefore + 1);
    await emptyFields(page);
    return before;
}
async function releaseFieldResponse() {
    const released = await app.evaluate(() => globalThis.__kwxGmTest.releaseFields());
    expect(released).toBeGreaterThan(0);
}
async function noLateFill(page, eventsBefore) {
    // Wait for actual requests, including release, to reach the app, then cross
    // two frames so a queued continuation cannot evade the no-fill assertions.
    // Audit orphaned replies separately at the end so all negative cases run.
    await expect.poll(() => pendingKeys().filter(key => key.startsWith('keewebx-userscript-connect-request-v2:')),
        { timeout: 7000 }).toEqual([]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await emptyFields(page);
    expect(await page.evaluate(() => window.credentialInputEvents)).toBe(eventsBefore);
}

async function setup(bundle) {
    context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await context.exposeBinding('__kwxSharedGM', (source, operation, key, value) => {
        if (!tabIds.has(source.page)) tabIds.set(source.page, randomUUID());
        const tab = tabIds.get(source.page);
        if (operation === 'get') {
            const result = structuredClone(gm.get(key));
            gmHistory.push({ operation, key, value: result });
            if (source.page === holdGmReplyFor && result?.packet?.body?.action === 'kwx-get-entry-fields') {
                holdGmReplyFor = undefined;
                return new Promise(resolve => { heldGmReply = { resolve, result }; });
            }
            return result;
        }
        gmHistory.push({ operation, key, value: structuredClone(value) });
        if (operation === 'set') { gm.set(key, storedValue(value)); return; }
        if (operation === 'delete') { gm.delete(key); return; }
        if (operation === 'list') return [...gm.keys()];
        // Userscripts returns null until saveTab initializes this tab.
        if (operation === 'getTab') return structuredClone(tabState.get(tab) ?? null);
        if (operation === 'saveTab') { tabState.set(tab, structuredClone(value)); return; }
        throw new Error(`Unsupported GM operation: ${operation}`);
    });
    await context.addInitScript({ content: `(() => {
        const start = () => {
            if (location.protocol !== 'https:' || window.top !== window) return;
            const observed = { documentBoot: crypto.randomUUID(), wireRequests: {}, openCalls: 0, focusCalls: 0,
                consentCount: 0, holdFields: false, heldFields: [] };
            globalThis.__kwxGmTest = observed;
            const nativeOpen = window.open, nativeFocus = window.focus;
            window.open = function(...args) { observed.openCalls++; return nativeOpen.apply(this, args); };
            window.focus = function(...args) { observed.focusCalls++; return nativeFocus.apply(this, args); };
            // Observe action names only; never inspect a decrypted protocol reply.
            addEventListener('message', event => {
                if (event.source === window && event.origin === location.origin && event.data?.kwConnect === 'request') {
                    const action = event.data.action;
                    if (typeof action === 'string') observed.wireRequests[action] = (observed.wireRequests[action] || 0) + 1;
                }
            });
            const seenConsent = new WeakSet();
            const observeConsent = () => {
                for (const dialog of document.querySelectorAll('[role="dialog"],dialog')) {
                    const label = dialog.getAttribute('aria-label') || dialog.textContent;
                    if (label.includes('Allow browser extension access') && !seenConsent.has(dialog)) {
                        seenConsent.add(dialog); observed.consentCount++;
                    }
                }
            };
            new MutationObserver(observeConsent).observe(document.body, { childList: true, subtree: true });
            observeConsent();
            // Keep the real trusted MessageEvent and its encrypted wire body.
            // This delays AppBridge delivery without fabricating protocol data.
            const nativeAdd = window.addEventListener, nativeRemove = window.removeEventListener;
            const wrappers = new WeakMap();
            const deliver = (listener, event) => typeof listener === 'function' ? listener.call(window, event) : listener.handleEvent(event);
            window.addEventListener = function(type, listener, options) {
                if (type !== 'message' || !listener) return nativeAdd.call(this, type, listener, options);
                let wrapped = wrappers.get(listener);
                if (!wrapped) {
                    wrapped = event => {
                        if (observed.holdFields && event.source === window && event.origin === location.origin &&
                            event.data?.kwConnect === 'response' && event.data.action === 'kwx-get-entry-fields') {
                            observed.heldFields.push({ listener, event }); return;
                        }
                        deliver(listener, event);
                    };
                    wrappers.set(listener, wrapped);
                }
                return nativeAdd.call(this, type, wrapped, options);
            };
            window.removeEventListener = function(type, listener, options) {
                return nativeRemove.call(this, type, type === 'message' ? wrappers.get(listener) || listener : listener, options);
            };
            observed.releaseFields = () => {
                observed.holdFields = false;
                const held = observed.heldFields.splice(0);
                for (const item of held) deliver(item.listener, item.event);
                return held.length;
            };
            const GM = {
                getValue: async (key, fallback) => {
                    if (observed.hangIdentity && key.endsWith('identity-v1')) return new Promise(() => {});
                    if (observed.slowReads) await new Promise(resolve => setTimeout(resolve, observed.slowReads));
                    const value = await globalThis.__kwxSharedGM('get', key); return value === undefined ? fallback : value;
                },
                setValue: (key, value) => globalThis.__kwxSharedGM('set', key, value),
                deleteValue: key => {
                    if (observed.throwCleanup) throw new Error('Injected cleanup API failure');
                    return globalThis.__kwxSharedGM('delete', key);
                },
                listValues: () => globalThis.__kwxSharedGM('list'),
                getTab: callback => { const result = globalThis.__kwxSharedGM('getTab'); return callback ? result.then(callback) : result; },
                saveTab: value => globalThis.__kwxSharedGM('saveTab', undefined, value)
            };
            if (location.href.startsWith(${JSON.stringify(APP)}) && ${Boolean(LEGACY_APP)}) {
                ${LEGACY_APP ? readFileSync(LEGACY_APP, 'utf8') : ''}
            } else {
                ${bundle}
            }
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    })();` });
    context.on('page', page => {
        pageCount++;
        page.on('console', message => {
            if (/Request payload|Response payload/.test(message.text())) report.payloadLogCount++;
            if (message.type() === 'error') report.errors.push({ kind: 'console', url: page.url(), message: redact(message.text()).slice(0, 1000) });
        });
        page.on('pageerror', error => report.errors.push({ kind: 'pageerror', url: page.url(), message: redact(error.message).slice(0, 1000) }));
    });
    await context.route('https://keewebx.app/**', async route => {
        const url = new URL(route.request().url());
        if (route.request().isNavigationRequest()) appNavigationRequests++;
        let path = url.pathname.replace(/^\/app(?=\/|$)/, '') || '/next.html';
        if (path === '/') path = '/next.html';
        const response = await context.request.get(`${APP_SERVER}${path}${url.search}`);
        await route.fulfill({ response });
    });
    for (const account of ACCOUNTS.slice(0, 2)) await context.route(`${new URL(account.url).origin}/**`, route => route.fulfill({
        contentType: 'text/html', body: `<!doctype html><title>Disposable GM login</title>
        <style>body{font:18px system-ui;padding:80px}input{display:block;width:300px;height:40px;margin:12px}</style>
        <h1>Disposable login</h1><form><input id="username" autocomplete="username"><input id="login-password" type="password" autocomplete="current-password"><button>Sign in</button></form>
        <script>window.formSubmits=0;window.credentialInputEvents=0;
        document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.formSubmits++});
        for(const input of document.querySelectorAll('input'))input.addEventListener('input',()=>{if(input.value)window.credentialInputEvents++});</script>`
    }));
}

function auditStorage() {
    const historical = JSON.stringify(gmHistory);
    const persistent = JSON.stringify(Object.fromEntries(gm));
    const operations = Object.fromEntries(['get', 'set', 'delete', 'list', 'getTab', 'saveTab'].map(operation => [operation, gmHistory.filter(item => item.operation === operation).length]));
    const packets = gmHistory.filter(item => item.operation === 'set' && TRANSIENT.test(item.key));
    const sensitiveActions = new Set(['kwx-pair', 'kwx-features', 'kwx-get-entries', 'kwx-get-entry-fields']);
    const sensitiveBodies = packets.map(item => item.value?.packet?.body).filter(body => sensitiveActions.has(body?.action));
    let allSignaturesValid = false;
    if (approvedRoute) {
        const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
            Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(approvedRoute.publicKey, 'base64')
        ]) });
        allSignaturesValid = packets.length > 0 && packets.every(({ key: packetKey, value }) => value?.packet && typeof value.signature === 'string' &&
            (verify(null, Buffer.from(stableJSON(value.packet)), key, Buffer.from(value.signature, 'base64')) ||
                LEGACY_APP && packetKey.includes('reply-v2:') && verify(null, Buffer.from(JSON.stringify(value.packet)), key, Buffer.from(value.signature, 'base64'))));
    }
    const result = {
        backend: 'Simulated shared private GM with stable per-page getTab/saveTab across reload',
        operations, writtenValues: operations.set, keys: [...gm.keys()], pendingKeys: pendingKeys(),
        onlyPersistentKeysRemain: [...gm.keys()].every(key => PERSISTENT.test(key)),
        historicalNoPlaintext: PRIVATE_VALUES.every(value => !historical.includes(value)),
        persistentNoPlaintext: PRIVATE_VALUES.every(value => !persistent.includes(value)),
        allSignaturesValid,
        sensitiveWireEncrypted: sensitiveBodies.length > 0 && sensitiveBodies.every(body =>
            typeof body.message === 'string' && body.message.length > 0 && typeof body.nonce === 'string' &&
            !('values' in body) && !('items' in body) && !('suggested' in body)),
        oneSharedIdentity: gmHistory.filter(item => item.operation === 'set' && item.key === 'keewebx-userscript-connect-identity-v1').length === 1,
        requestWrites: gmHistory.filter(item => item.operation === 'set' && item.key?.startsWith('keewebx-userscript-connect-request-v2:')).length,
        replyWrites: gmHistory.filter(item => item.operation === 'set' && item.key?.startsWith('keewebx-userscript-connect-reply-v2:')).length
    };
    report.storageAudit = result;
    return result;
}

try {
    const bundle = readFileSync(SOURCE, 'utf8');
    report.bundle = { source: SOURCE, bytes: Buffer.byteLength(bundle), sha256: createHash('sha256').update(bundle).digest('hex') };
    if (LEGACY_APP) report.legacyAppBundle = { source: LEGACY_APP, sha256: createHash('sha256').update(readFileSync(LEGACY_APP)).digest('hex'), storageKeyOrder: 'preserved for legacy signatures' };
    await step('create real encrypted KDBX with two distinct origin accounts and an unrelated account', async () => {
        const source = `
            import * as kdbx from ${JSON.stringify(pathToFileURL(join(DB_ROOT, 'modules/db/lib/index.ts')).href)};
            import { argon2 } from ${JSON.stringify(pathToFileURL(join(DB_ROOT, 'modules/db/test/test-support/argon2.ts')).href)};
            import { writeFileSync } from 'node:fs';
            kdbx.CryptoEngine.setArgon2Impl(argon2);
            const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(${JSON.stringify(DB_PASSWORD)})), 'GM Connect smoke');
            db.header.kdfParameters.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
            db.header.kdfParameters.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
            for (const account of ${JSON.stringify(ACCOUNTS)}) {
                const entry = db.createEntry(db.getDefaultGroup());
                entry.fields.set('Title', account.title); entry.fields.set('URL', account.url); entry.fields.set('UserName', account.user);
                entry.fields.set('Password', kdbx.ProtectedValue.fromString(account.password));
            }
            writeFileSync(${JSON.stringify(join(OUT, 'gm-connect.kdbx'))}, new Uint8Array(await db.save()));
        `;
        execFileSync(BUN, ['--eval', source], { cwd: ROOT, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
        return { entryCount: ACCOUNTS.length, differentOrigins: true };
    });
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
        ...(process.env.KWX_CHROMIUM_EXECUTABLE ? { executablePath: process.env.KWX_CHROMIUM_EXECUTABLE } : {}) });
    await setup(bundle);
    await step('unlock original independent production app and authorize Connect exactly once', async () => {
        app = await context.newPage(); await app.goto(APP); await ready(app);
        expect(await app.evaluate(() => window.opener === null)).toBe(true);
        await expect(app.locator('#open-file-input, #kdbx-file-input').first()).toBeAttached({ timeout: 15000 });
        await app.locator('#open-file-input, #kdbx-file-input').first().setInputFiles(join(OUT, 'gm-connect.kdbx'));
        const fallback = app.getByRole('button', { name: 'Use password', exact: true });
        if (await fallback.isVisible()) await fallback.click();
        await app.locator('#password').fill(DB_PASSWORD); await app.locator('#unlock').click();
        await expect(app.locator('.entry-row').first()).toBeVisible({ timeout: 15000 });
        if (await shadowValue(app, 'section', 'hidden')) await action(app, 'toggle');
        await action(app, 'config-tab'); await action(app, 'authorize');
        await expect(consent()).toBeVisible({ timeout: 10000 });
        const listing = consent().getByRole('checkbox', { name: 'Allow listing and searching entries', exact: true });
        if (await listing.count()) await listing.check();
        await consent().getByRole('button', { name: 'Allow', exact: true }).click();
        await untilStatus(app, /Authorized/);
        await expect.poll(() => gm.get(ROUTE_KEY), { timeout: 5000 }).toBeTruthy();
        approvedRoute = structuredClone(gm.get(ROUTE_KEY));
        expect(approvedRoute.endpoint).toBe(APP);
        expect(typeof approvedRoute.host).toBe('string');
        expect(typeof approvedRoute.publicKey).toBe('string');
        expect(approvedRoute.publicKey).toBe(gm.get('keewebx-userscript-connect-identity-v1').publicKey);
        if (!LEGACY_APP) expect(tabState.get(tabIds.get(app))?.[`keewebx-userscript-connect-host-v2:${APP}`]).toBe(approvedRoute.host);
        expect(await app.evaluate(key => sessionStorage.getItem(key), `keewebx-userscript-connect-host-v2:${APP}`)).toBe(approvedRoute.host);
        expect(await app.evaluate(() => globalThis.__kwxGmTest.consentCount)).toBe(1);
        expect(await fieldReads()).toBe(0);
        originalApp = await documentState(app);
        report.oneAuthorizationVerified = true;
        return { nativeConsentCount: 1, globalRouteRegistered: true, fieldsNotRead: true };
    });
    await step('independently opened website one finds and fills using approved app without helper or consent', async () => {
        first = await context.newPage(); await first.goto(ACCOUNTS[0].url); await ready(first);
        expect(await first.evaluate(() => window.opener === null)).toBe(true);
        await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]); await assertOneApp();
    });
    await step('independently opened different-origin website two uses same app and original authorization', async () => {
        second = await context.newPage(); await second.goto(ACCOUNTS[1].url); await ready(second);
        expect(await second.evaluate(() => window.opener === null)).toBe(true);
        await lookup(second, ACCOUNTS[1]); await fill(second, ACCOUNTS[1]); await assertOneApp();
        report.twoIndependentOriginsVerified = true;
    });
    await step('old authorization metadata permits signed lookup and fill without a reload or another grant', async () => {
        const route = { ...gm.get(ROUTE_KEY) }; delete route.format; gm.set(ROUTE_KEY, route);
        await clearFields(first); await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]);
        await clearFields(second); await lookup(second, ACCOUNTS[1]); await fill(second, ACCOUNTS[1]);
        expect(gm.get(ROUTE_KEY)).toEqual(route);
        gm.set(ROUTE_KEY, structuredClone(approvedRoute));
        await assertOneApp();
        report.oldMetadataVerified = true;
        return { noAppReload: true, nativeConsentCount: 1, signedConnectionRequired: true };
    });
    await step('first website repeats lookup and fill after second website without switching to app', async () => {
        await clearFields(first); await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]); await assertOneApp();
        report.repeatLookupVerified = true;
    });
    await step('reloaded website reuses global authorization and unchanged original app', async () => {
        const before = await documentState(first);
        await first.reload(); await ready(first);
        expect((await documentState(first)).boot).not.toBe(before.boot);
        await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]); await assertOneApp();
        report.reloadVerified = true;
    });
    await step('Test connection replies through serialized manager storage and clears its busy state', async () => {
        if (await shadowValue(first, 'section', 'hidden')) await action(first, 'toggle');
        await action(first, 'config-tab'); await action(first, 'probe');
        await untilStatus(first, /Connected to the authorized KeeWebX tab/);
        expect(await shadowValue(first, '[data-action="probe"]', 'disabled')).toBe(false);
        await assertOneApp();
        report.connectionProbeVerified = true;
        return { probeReturned: true, originalAppUnchanged: true };
    });
    await step('Test connection completes even when cleanup throws synchronously', async () => {
        await first.evaluate(() => { globalThis.__kwxGmTest.throwCleanup = true; });
        await action(first, 'probe'); await untilStatus(first, /Connected to the authorized KeeWebX tab/);
        expect(await shadowValue(first, '[data-action="probe"]', 'disabled')).toBe(false);
        await first.evaluate(() => { globalThis.__kwxGmTest.throwCleanup = false; });
        await assertOneApp();
    });
    await step('a manager identity read that never returns ends visibly and permits retry', async () => {
        await first.evaluate(() => { globalThis.__kwxGmTest.hangIdentity = true; });
        await action(first, 'probe');
        await untilStatus(first, /Checking Userscripts storage/);
        await untilStatus(first, /Userscripts storage did not respond/, 7000);
        expect(await shadowValue(first, '[data-action="probe"]', 'disabled')).toBe(false);
        await first.evaluate(() => { globalThis.__kwxGmTest.hangIdentity = false; });
        await action(first, 'probe'); await untilStatus(first, /Connected to the authorized KeeWebX tab/);
        await assertOneApp();
    });
    await step('navigation and closing a pending connection test clear its stale progress text', async () => {
        await first.evaluate(() => { globalThis.__kwxGmTest.hangIdentity = true; });
        await action(first, 'probe'); await untilStatus(first, /Checking Userscripts storage/);
        await first.evaluate(() => { location.hash = 'cancel-test'; });
        await untilStatus(first, /stopped.*retry/);
        expect(await shadowValue(first, '[data-action="probe"]', 'disabled')).toBe(false);
        await action(first, 'probe'); await untilStatus(first, /Checking Userscripts storage/);
        await action(first, 'close'); await untilStatus(first, /stopped.*retry/);
        await first.evaluate(() => { globalThis.__kwxGmTest.hangIdentity = false; });
        await action(first, 'toggle'); await action(first, 'config-tab');
        await action(first, 'probe'); await untilStatus(first, /Connected to the authorized KeeWebX tab/);
        await assertOneApp();
    });
    await step('the entire connection test stops at fifteen seconds even when each storage call is within its own limit', async () => {
        await first.evaluate(() => { globalThis.__kwxGmTest.slowReads = 3200; });
        const started = Date.now();
        await action(first, 'probe'); await untilStatus(first, /timed out after 15 seconds/, 18000);
        expect(Date.now() - started).toBeLessThan(18000);
        expect(await shadowValue(first, '[data-action="probe"]', 'disabled')).toBe(false);
        await first.evaluate(() => { globalThis.__kwxGmTest.slowReads = 0; });
        await action(first, 'probe'); await untilStatus(first, /Connected to the authorized KeeWebX tab/);
        await assertOneApp();
    });
    await step('Open KeeWebX with an approved route never opens, navigates or locks the original app', async () => {
        const before = await documentState(app);
        await action(first, 'open');
        explicitFocusCalls = LEGACY_APP ? 0 : 1;
        await untilStatus(first, /Connected to the authorized KeeWebX tab/);
        expect(await app.evaluate(() => globalThis.__kwxGmTest.focusCalls)).toBe(explicitFocusCalls);
        await expect(app.locator('.vault')).toBeVisible();
        await expect(app.locator('#password')).toHaveCount(0);
        expect(await documentState(app)).toEqual(before);
        await first.bringToFront();
        await assertOneApp();
        await clearFields(first); await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]);
        await assertOneApp();
        report.openPreservesUnlockVerified = true;
        return { appNavigationRequests, noNewTab: true, unlockedDocumentPreserved: true, fillAfterOpenWorks: true };
    });
    await step('ten alternating fills across two websites retain one authorization and one unlocked app', async () => {
        for (let cycle = 0; cycle < 5; cycle++) {
            await clearFields(second); await lookup(second, ACCOUNTS[1]); await fill(second, ACCOUNTS[1]);
            await clearFields(first); await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]);
            await assertOneApp();
        }
        report.alternatingRepeatedFillVerified = true;
        return { fills: 10, nativeConsentCount: 1, appNavigationRequests };
    });
    await step('global authorization survives the short-lived connection expiry boundary', async () => {
        for (const page of [app, first, second]) await page.evaluate(() => {
            const nativeNow = Date.now;
            Date.now = () => nativeNow() + 130000;
        });
        await clearFields(second); await lookup(second, ACCOUNTS[1]); await fill(second, ACCOUNTS[1]);
        await clearFields(first); await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]);
        await assertOneApp();
        report.authorizationSurvivesSessionExpiryVerified = true;
        return { simulatedElapsedMs: 130000, nativeConsentCount: 1, freshConnectionsUseExistingGrant: true };
    });
    await step('navigation while real encrypted credential response is pending prevents late fill', async () => {
        await clearFields(first); await lookup(first, ACCOUNTS[0]);
        const eventsBefore = await holdFieldResponse(first);
        await first.evaluate(() => { location.hash = 'navigation-during-field-read'; });
        await expect.poll(() => shadowValue(first, '[data-action="entry-0"]')).toBeNull();
        await releaseFieldResponse(); await noLateFill(first, eventsBefore); await assertOneApp();
        report.navigationNoFillVerified = true;
    });
    await step('closing account panel while credentials are pending cancels actual response without fill', async () => {
        await lookup(first, ACCOUNTS[0]);
        const eventsBefore = await holdFieldResponse(first);
        await action(first, 'close');
        expect(await shadowValue(first, '[data-action="entry-0"]')).toBeNull();
        await releaseFieldResponse(); await noLateFill(first, eventsBefore); await assertOneApp();
        report.cancellationNoFillVerified = true;
    });
    await step('real credential response delivered after website deadline cannot fill', async () => {
        await lookup(first, ACCOUNTS[0]);
        // Affect only this website's deadline checks. Browser-wide fake clocks
        // would also change the host's time and obscure document preservation.
        await first.evaluate(() => {
            const nativeNow = Date.now;
            globalThis.__kwxGmTest.clockOffset = 0;
            Date.now = () => nativeNow() + globalThis.__kwxGmTest.clockOffset;
        });
        const eventsBefore = await first.evaluate(() => window.credentialInputEvents);
        const readsBefore = await fieldReads();
        holdGmReplyFor = first;
        await action(first, 'entry-0');
        await expect.poll(() => !!heldGmReply, { timeout: 5000 }).toBe(true);
        expect(await fieldReads()).toBe(readsBefore + 1);
        await emptyFields(first);
        // Advance Date only; do not wait for the production session timeout.
        await first.evaluate(() => { globalThis.__kwxGmTest.clockOffset = 180000; });
        const reply = heldGmReply;
        heldGmReply = undefined;
        reply.resolve(reply.result);
        await untilStatus(first, /expired|timed out|did not reply|changed|canceled|cancelled/i);
        await noLateFill(first, eventsBefore);
        await first.evaluate(() => { globalThis.__kwxGmTest.clockOffset = 0; });
        await assertOneApp(); report.expiredResponseNoFillVerified = true;
    });
    await step('locked original app rejects selected account and subsequent lookup without fill or consent', async () => {
        await lookup(first, ACCOUNTS[0]);
        await app.bringToFront(); await app.getByRole('button', { name: 'Lock', exact: true }).click();
        await expect(app.locator('#password')).toBeVisible({ timeout: 10000 });
        await first.bringToFront();
        if (await shadowValue(first, '[data-action="entry-0"]')) await action(first, 'entry-0');
        await untilStatus(first, /lock|unlock|suspended|changed|find accounts again/i);
        await emptyFields(first);
        if (await shadowValue(first, 'section', 'hidden')) await action(first, 'toggle');
        else { await action(first, 'accounts-tab'); await action(first, 'lookup'); }
        await untilStatus(first, /lock|unlock|suspended/i);
        await emptyFields(first);
        expect(await shadowValue(first, '[data-action="entry-0"]')).toBeNull();
        await assertOneApp(); report.lockedAppNoFillVerified = true;
        report.noHelperOrFocusVerified = true;
    });
    await step('all transient GM requests drain and complete historical storage contains no plaintext fixture data', async () => {
        await expect.poll(() => pendingKeys().filter(key => key.startsWith('keewebx-userscript-connect-request-v2:')),
            { timeout: 7000 }).toEqual([]);
        // A client may disappear before consuming its encrypted reply. The
        // contract allows retaining that reply until its signed deadline.
        // Advance only host Date.now to exercise real expiry cleanup quickly.
        const replies = pendingKeys().map(key => gm.get(key)?.packet);
        if (replies.length) {
            const hostNow = await app.evaluate(() => Date.now());
            expect(replies.every(packet => Number.isFinite(packet?.deadline) && packet.deadline <= hostNow + 66000)).toBe(true);
            const expiredAt = Math.max(...replies.map(packet => packet.deadline)) + 1;
            await app.evaluate(expiredAt => {
                const nativeNow = Date.now;
                Date.now = () => Math.max(nativeNow(), expiredAt);
            }, expiredAt);
        }
        await expect.poll(pendingKeys, { timeout: 7000 }).toEqual([]);
        report.replyExpiryCleanupVerified = true;
        const audit = auditStorage();
        expect(audit.onlyPersistentKeysRemain).toBe(true);
        expect(audit.historicalNoPlaintext).toBe(true);
        expect(audit.persistentNoPlaintext).toBe(true);
        expect(audit.oneSharedIdentity).toBe(true);
        expect(audit.allSignaturesValid).toBe(true);
        expect(audit.sensitiveWireEncrypted).toBe(true);
        expect(audit.operations.list).toBeGreaterThan(0);
        expect(audit.operations.delete).toBeGreaterThan(0);
        expect(audit.requestWrites).toBeGreaterThan(0);
        expect(audit.replyWrites).toBeGreaterThan(0);
        expect(report.errors).toEqual([]);
        expect(report.payloadLogCount).toBe(0);
        return { allHistoricalValuesAudited: true, noPlaintextTitlesUsernamesOrPasswords: true,
            repliesCleanedAtDeadline: replies.length, transientKeysRemaining: 0 };
    });
    report.ok = true;
} catch (error) {
    report.ok = false;
    report.blocker = redact(error.message);
    report.blockerStack = redact(error.stack);
    report.pendingPackets = pendingKeys().map(key => {
        const packet = gm.get(key)?.packet;
        return { key, operation: packet?.operation, action: packet?.body?.action,
            error: packet?.error && redact(packet.error), millisecondsToDeadline: packet?.deadline - Date.now() };
    });
    if (app && !app.isClosed()) report.appWireObservations = await app.evaluate(() => {
        const observed = globalThis.__kwxGmTest;
        return { wireRequests: observed?.wireRequests, consentCount: observed?.consentCount,
            holdFields: observed?.holdFields, heldFieldEvents: observed?.heldFields.length };
    }).catch(() => undefined);
    for (const [label, page] of [['app', app], ['first', first], ['second', second]]) if (page && !page.isClosed()) {
        try {
            report[`${label}Status`] = await status(page);
            await page.screenshot({ path: join(OUT, `${label}-blocker.png`) });
        } catch {}
    }
} finally {
    auditStorage();
    if (context) await context.close();
    if (browser) await browser.close();
    if (!report.storageAudit.historicalNoPlaintext || !report.storageAudit.persistentNoPlaintext || report.errors.length || report.payloadLogCount) report.ok = false;
    report.finished = new Date().toISOString();
    report.elapsedMilliseconds = Date.parse(report.finished) - Date.parse(report.started);
    const reportPath = process.env.KWX_E2E_REPORT ? resolve(process.env.KWX_E2E_REPORT) : join(OUT, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, blocker: report.blocker, elapsedMilliseconds: report.elapsedMilliseconds, report: reportPath, storageAudit: report.storageAudit }, null, 2));
    process.exitCode = report.ok ? 0 : 1;
}
