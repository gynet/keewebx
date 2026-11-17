// Production installer acceptance with native MessagePorts and a real encrypted KDBX.
// Fixture helpers follow native-connect.mjs; importing it would execute its suite.
// Build the current installer and app assets, serve dist on KWX_APP_SERVER, then run:
// node modules/extension/userscript/tests/port-connect.mjs
// KWX_APP_GM_BLOCK=1 leaves every app GM read unresolved after authorization.
// KWX_BLOCK_HELPER_CLOSE=1 makes only userscript-held helper.close() calls no-ops.
// KWX_APP_USERSCRIPT=/path/to/historical.user.js overrides only the original App's installer.
// KWX_LEGACY_WORKER=/tmp/worker-0.6.3.js exercises the first-connection worker upgrade.
// KWX_FOCUS_HELLO=1 runs startup and delayed-hello recovery without the later stress cases.
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
const APP_SOURCE = process.env.KWX_APP_USERSCRIPT ? resolve(process.env.KWX_APP_USERSCRIPT) : SOURCE;
const OUT = resolve(process.env.KWX_E2E_OUTPUT_DIR || mkdtempSync(join(tmpdir(), 'keewebx-port-connect-')));
const BLOCK_APP_GM = process.env.KWX_APP_GM_BLOCK === '1';
const BLOCK_HELPER_CLOSE = process.env.KWX_BLOCK_HELPER_CLOSE === '1';
const FOCUS_HELLO = process.env.KWX_FOCUS_HELLO === '1';
// Optional upgrade run uses an unmodified historical worker supplied outside the repo.
const LEGACY_WORKER = process.env.KWX_LEGACY_WORKER ? readFileSync(process.env.KWX_LEGACY_WORKER, 'utf8') : null;
const OPERATION_BUDGET = 30000;
const SELECTION_STATUSES = ['Checking account access', 'Reading account details', 'Checking access before filling'];
const APP = 'https://keewebx.app/app';
const MARK = 'keewebx-native-connect-v1';
const PORT_MARK = 'keewebx-connect-port-v1';
const ROUTE_KEY = `${MARK}:selected:${APP}`;
const IDENTITY_KEY = 'keewebx-userscript-connect-identity-v1';
const PREFERENCES_KEY = 'keewebx-userscript-connect-preferences-v1';
const AUTO_FILL_LABEL = 'Fill a single matching account automatically';
const CHOICE_ORIGIN = 'https://choice.example.test';
const PREFIX = 'Connect.user.js---';
const DB_PASSWORD = 'Disposable-port-vault-2026!';
const ACCOUNTS = [
    { title: 'First fixture account', url: 'https://login.example.org/', user: 'first-fixture-user', password: 'Disposable-first-password!' },
    { title: 'Second fixture account', url: 'https://signin.example.net/', user: 'second-fixture-user', password: 'Disposable-second-password!' },
    { title: 'Unrelated fixture account', url: 'https://wrong.example.com/', user: 'unrelated-fixture-user', password: 'Disposable-unrelated-password!' }
];
// Extra entries belong only to the late preference cases, never the stress origins.
const CHOICE_ACCOUNTS = [
    { title: 'Choice fixture one', url: CHOICE_ORIGIN + '/', user: 'choice-one-user', password: 'Disposable-choice-one-password!' },
    { title: 'Choice fixture two', url: CHOICE_ORIGIN + '/', user: 'choice-two-user', password: 'Disposable-choice-two-password!' }
];
const VAULT_ACCOUNTS = [...ACCOUNTS, ...CHOICE_ACCOUNTS];
const WEBSITE_ORIGINS = [...ACCOUNTS.slice(0, 2), CHOICE_ACCOUNTS[0]].map(account => new URL(account.url).origin);
const PRIVATE_VALUES = [DB_PASSWORD, ...VAULT_ACCOUNTS.flatMap(account => [account.title, account.user, account.password])];
const redact = value => PRIVATE_VALUES.reduce((result, secret) => result.replaceAll(secret, '[fixture value]'), String(value));
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const report = {
    started: new Date().toISOString(),
    scope: 'Production installer in Chromium isolated content scripts, native MessagePort and service-worker handoff, GM adapter, real KDBX and native consent',
    nativeIOSVerified: false, realManagerVerified: false, appGMBlockedAfterAuthorization: BLOCK_APP_GM, helperCrossCloseBlocked: BLOCK_HELPER_CLOSE,
    steps: [], errors: []
};
const cdpByPage = new WeakMap(), helpers = new Map(), documents = new Map(), sockets = new Set();
const assetRequests = new Map();
let context, nativeWorker, app, first, second, originalApp, approvedRoute, tlsServer, proxyServer;
let appNavigationRequests = 0;
let expectedAppVersion, expectedSiteVersion;
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
// Count logical App requests, not handler executions; retries remain in windowRequests.
const fieldReads = () => app.evaluate(() => globalThis.__kwxNativeTest.logicalRequests['kwx-get-entry-fields'] || 0);
const entryReads = () => app.evaluate(() => globalThis.__kwxNativeTest.logicalRequests['kwx-get-entries'] || 0);
const windowTraffic = () => app.evaluate(() => ({ requests: __kwxNativeTest.windowRequests,
    responses: __kwxNativeTest.windowResponses, dropped: __kwxNativeTest.droppedResponses,
    postAttempts: __kwxNativeTest.wireRequests, logicalRequests: __kwxNativeTest.logicalRequests }));
const documentState = page => page.evaluate(() => ({ href: location.href, timeOrigin: performance.timeOrigin, boot: globalThis.__kwxNativeTest.documentBoot }));
const consent = () => app.getByRole('dialog', { name: 'Allow browser extension access', exact: true });
async function untilStatus(page, expression, timeout = 15000) {
    await expect.poll(() => status(page), { timeout, message: `Connect status must match ${expression}` }).toMatch(expression);
    return status(page);
}
async function ready(page, { loginFields = true } = {}) {
    await realVisibility(page);
    await expect(page.locator('#keewebx-userscript-connect')).toBeAttached({ timeout: 15000 });
    expect(await shadowValue(page, '[data-role="version"]')).toBe('Connect ' + (page.url() === APP ? expectedAppVersion : expectedSiteVersion));
    expect(await page.evaluate(() => typeof globalThis.__kwxPortAdapter)).toBe('undefined');
    await snapshot(page);
    if (new URL(page.url()).origin !== new URL(APP).origin) {
        await expect.poll(() => shadowValue(page, '[data-action="lookup"]', 'disabled'), { timeout: 15000 }).toBe(false);
        await expect.poll(() => shadowValue(page, '[data-action="probe"]', 'disabled'), { timeout: 15000 }).toBe(false);
        await expect.poll(() => shadowValue(page, '[data-action="toggle"]', 'hidden')).toBe(!loginFields);
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
    helpers.set(page, { url: page.url(), openedAt: Date.now(), closedAt: null, automaticClosure: false, signedReadyVerified: false });
}
async function noHelpers() {
    await expect.poll(() => context.pages().filter(page => helperURL(page.url())).length, { timeout: 10000 }).toBe(0);
    expect([...helpers.values()].every(helper => helper.closedAt !== null && helper.automaticClosure)).toBe(true);
}
async function sameApp({ unlocked = true, authorized = true } = {}) {
    expect(await documentState(app)).toEqual(originalApp);
    expect(appNavigationRequests).toBe(1);
    expect(context.pages().filter(page => page !== upgradePage && page.url().startsWith(new URL(APP).origin) && !helperURL(page.url()))).toEqual([app]);
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
    if (await shadowValue(page, 'section', 'hidden')) {
        await page.locator('#username').click();
        await action(page, 'toggle');
    } else { await action(page, 'accounts-tab'); await action(page, 'lookup'); }
}
async function bounded(label, run) {
    const deadline = Date.now() + OPERATION_BUDGET;
    const remaining = () => {
        const milliseconds = deadline - Date.now();
        if (milliseconds <= 0) throw new Error(`${label} exceeded its aggregate 30 second budget`);
        return milliseconds;
    };
    let timer;
    try {
        return await Promise.race([run(remaining), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} exceeded its aggregate 30 second budget`)), remaining());
        })]);
    } finally { clearTimeout(timer); }
}
async function matchingList(page, account, readsBefore, remaining = () => OPERATION_BUDGET) {
    await expect.poll(() => entries(page), { timeout: remaining() }).toContain(account.title);
    assertAccountAuthority((await snapshot(page)).packets);
    const listed = await entries(page);
    for (const other of ACCOUNTS.filter(item => item !== account)) expect(listed).not.toContain(other.title);
    expect(await status(page)).toMatch(/Found 1 matching account/);
    expect(await fieldReads()).toBe(readsBefore);
    await emptyFields(page);
}
async function lookup(page, account) {
    return bounded('Account lookup', async remaining => {
        const readsBefore = await fieldReads();
        await startLookup(page);
        await matchingList(page, account, readsBefore, remaining);
        remaining();
    });
}
async function fill(page, account) {
    return bounded('Selected account fill', async remaining => {
        const readsBefore = await fieldReads(), statusOffset = (await snapshot(page)).statuses.length;
        await action(page, 'entry-0');
        await expect(page.locator('#username')).toHaveValue(account.user, { timeout: remaining() });
        await expect(page.locator('#login-password')).toHaveValue(account.password, { timeout: remaining() });
        expect(await fieldReads()).toBe(readsBefore + 1);
        expect(await page.evaluate(() => window.formSubmits)).toBe(0);
        const observed = (await snapshot(page)).statuses.slice(statusOffset);
        let previous = -1;
        for (const text of SELECTION_STATUSES) {
            const index = observed.findIndex((value, index) => index > previous && value.startsWith(text));
            expect(index, `Selection must show ${text} in order`).toBeGreaterThan(previous);
            previous = index;
        }
        remaining();
    });
}
const readPreferences = async () => (await settings()).get(PREFERENCES_KEY);
async function panelLayout(page) {
    const { session, nodeId } = await shadowNode(page, 'section');
    const { object } = await session.send('DOM.resolveNode', { nodeId });
    try {
        const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
            objectId: object.objectId, functionDeclaration: 'function() { return (' + panelGeometry.toString() + ')(this); }',
            returnByValue: true
        });
        if (exceptionDetails) throw new Error('CDP panel layout inspection failed');
        return result.value;
    } finally { await session.send('Runtime.releaseObject', { objectId: object.objectId }); }
}

// These cases use the real vault and receiver. Only their new website is routed.
async function preferenceSettings(page) {
    if (await shadowValue(page, 'section', 'hidden')) {
        await action(page, 'toggle');
        await expect.poll(() => shadowValue(page, '[data-action="lookup"]', 'disabled'), { timeout: 30000 }).toBe(false);
    }
    await action(page, 'config-tab');
}
async function preferenceCheckbox(page, expected) {
    const selector = '[data-action="auto-fill-single"]';
    await expect.poll(() => shadowValue(page, selector, 'disabled')).toBe(false);
    expect(await shadowValue(page, selector, 'tagName')).toBe('INPUT');
    expect(await shadowValue(page, selector, 'type')).toBe('checkbox');
    const id = await shadowValue(page, selector, 'id');
    expect(id).toBeTruthy();
    expect((await shadowValue(page, 'label[for=' + JSON.stringify(id) + ']')).trim()).toBe(AUTO_FILL_LABEL);
    expect(await shadowValue(page, selector, 'checked')).toBe(expected);
}
async function setAutoFillSingle(page, enabled) {
    await preferenceSettings(page);
    const selector = '[data-action="auto-fill-single"]';
    await expect.poll(() => shadowValue(page, selector, 'disabled')).toBe(false);
    if (await shadowValue(page, selector, 'checked') !== enabled) {
        await action(page, 'auto-fill-single');
        expect((await snapshot(page)).actions.at(-1)).toEqual({ action: 'auto-fill-single', trusted: true });
    }
    await preferenceCheckbox(page, enabled);
    await expect.poll(readPreferences).toEqual({ autoFillSingle: enabled });
    expect(await page.evaluate(key => [localStorage.getItem(key), sessionStorage.getItem(key)], PREFERENCES_KEY)).toEqual([null, null]);
}
async function testLauncherVisibility() {
    await context.route(CHOICE_ORIGIN + '/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <meta name="viewport" content="width=device-width,initial-scale=1"><title>Disposable choice login</title>
        <style>*{box-sizing:border-box}body{font:16px system-ui;margin:16px}form{max-width:340px}
        input{display:block;width:100%;min-width:0;height:40px;margin:8px 0}button{min-height:40px}</style>
        <form role="search"><input id="search" type="search" aria-label="Search"></form>
        <form id="fixture-login" ${new URL(route.request().url()).pathname === '/no-login' ? 'hidden' : ''}>
        <label for="username">Username</label><input id="username" autocomplete="username">
        <label for="login-password">Password</label><input id="login-password" type="password" autocomplete="current-password">
        <button>Sign in</button></form>
        <script>window.formSubmits=0;window.credentialInputEvents=0;
        document.querySelector('#fixture-login').addEventListener('submit',event=>{event.preventDefault();window.formSubmits++});
        for(const input of document.querySelectorAll('input'))input.addEventListener('input',()=>{if(input.value)window.credentialInputEvents++});</script>` }));
    const page = await context.newPage(), count = helpers.size, requests = (await windowTraffic()).requests.length;
    const lists = await entryReads(), fields = await fieldReads();
    try {
        expect((await readPreferences())?.autoFillSingle ?? false).toBe(false);
        await page.goto(CHOICE_ORIGIN + '/no-login'); await ready(page, { loginFields: false });
        await page.locator('#search').click(); await page.waitForTimeout(250);
        expect(await shadowValue(page, '[data-action="toggle"]', 'hidden')).toBe(true);
        await page.locator('#fixture-login').evaluate(form => { form.hidden = false; });
        await expect.poll(() => shadowValue(page, '[data-action="toggle"]', 'hidden')).toBe(false);
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
        const syntheticFocus = await page.locator('#username').evaluate(input => {
            const event = new FocusEvent('focusin', { bubbles: true, composed: true });
            input.dispatchEvent(event);
            return { trusted: event.isTrusted, activeElement: document.activeElement?.id };
        });
        expect(syntheticFocus).toEqual({ trusted: false, activeElement: 'search' });
        // Keep Accounts open so changing tabs cannot cancel an unintended lookup.
        await action(page, 'toggle');
        await page.waitForTimeout(350);
        expect(await shadowValue(page, 'section', 'hidden')).toBe(false);
        expect(helpers.size).toBe(count);
        expect((await windowTraffic()).requests).toHaveLength(requests);
        expect(await entryReads()).toBe(lists); expect(await fieldReads()).toBe(fields);
        expect((await snapshot(page)).packets).toEqual([]);
        await preferenceSettings(page); await preferenceCheckbox(page, false);
        await page.waitForTimeout(250);
        expect(helpers.size).toBe(count);
        expect((await windowTraffic()).requests).toHaveLength(requests);
        expect((await snapshot(page)).packets).toEqual([]);
        await action(page, 'close');
        await page.locator('#fixture-login').evaluate(form => { form.hidden = true; });
        await expect.poll(() => shadowValue(page, '[data-action="toggle"]', 'hidden')).toBe(true);
        await page.locator('#fixture-login').evaluate(form => { form.hidden = false; });
        await expect.poll(() => shadowValue(page, '[data-action="toggle"]', 'hidden')).toBe(false);
        await action(page, 'toggle'); await action(page, 'accounts-tab');
        await page.locator('#username').click();
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('username');
        // Flush field detection, then arm only the next trusted closed-shadow click.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
        await page.evaluate(() => {
            const host = document.getElementById('keewebx-userscript-connect');
            window.__kwxLauncherGuard = { mutations: 0 };
            const mutate = event => {
                if (!event.isTrusted || event.target !== host) return;
                window.removeEventListener('click', mutate, true);
                const input = document.getElementById('username'), form = input.form;
                input.type = 'email'; input.autocomplete = 'email'; input.id = 'newsletter';
                input.name = 'newsletter'; form.id = 'newsletter-form';
                form.setAttribute('aria-label', 'Newsletter subscription');
                form.querySelector('button').textContent = 'Subscribe';
                document.getElementById('login-password').remove();
                Object.assign(window.__kwxLauncherGuard, { mutations: 1, trusted: event.isTrusted,
                    retargetedToHost: event.composedPath()[0] === host, type: input.type,
                    autocomplete: input.autocomplete, id: input.id, passwordRemoved: !form.querySelector('[type="password"]') });
            };
            window.addEventListener('click', mutate, true);
        });
        await action(page, 'lookup');
        expect(await page.evaluate(() => window.__kwxLauncherGuard)).toEqual({ mutations: 1, trusted: true,
            retargetedToHost: true, type: 'email', autocomplete: 'email', id: 'newsletter', passwordRemoved: true });
        expect((await snapshot(page)).actions.at(-1)).toEqual({ action: 'lookup', trusted: true });
        await expect.poll(() => shadowValue(page, '[data-action="toggle"]', 'hidden')).toBe(true);
        await page.waitForTimeout(350);
        expect(helpers.size).toBe(count);
        expect((await windowTraffic()).requests).toHaveLength(requests);
        expect(await entryReads()).toBe(lists); expect(await fieldReads()).toBe(fields);
        expect((await snapshot(page)).packets).toEqual([]);
        await expect(page.locator('#newsletter')).toHaveValue('');
        expect(await page.evaluate(() => [window.formSubmits, window.credentialInputEvents])).toEqual([0, 0]);
        await sameApp(); await noHelpers();
        return { hiddenWithoutLogin: true, followsFormVisibility: true, settingsBeforeLoginFocusRequests: 0,
            syntheticFocusIgnored: true, syntheticFocusRequests: 0, trustedCaptureFormMutationRequests: 0,
            changedFormHelpers: 0, changedFormAccountRequests: 0, changedFormFieldRequests: 0, defaultAutoFillSingle: false };
    } finally {
        try {
            if ((await readPreferences())?.autoFillSingle === true) await nativeWorker.evaluate(key =>
                chrome.storage.local.set({ [key]: { autoFillSingle: false } }), PREFIX + PREFERENCES_KEY);
        } finally { try { await archive(page); } finally { await page.close(); } }
    }
}
async function testSinglePreference() {
    const page = await context.newPage(), account = ACCOUNTS[0], count = helpers.size;
    try {
        await page.goto(account.url); await ready(page); await emptyFields(page);
        const requests = (await windowTraffic()).requests.length;
        await preferenceSettings(page); await preferenceCheckbox(page, false);
        await setAutoFillSingle(page, true);
        await archive(page);
        await page.reload(); await ready(page);
        await preferenceSettings(page); await preferenceCheckbox(page, true);
        await page.waitForTimeout(250);
        expect(helpers.size).toBe(count);
        expect((await windowTraffic()).requests).toHaveLength(requests);
        await emptyFields(page); await action(page, 'close');
        const reads = await fieldReads(), lists = await entryReads(), offset = (await snapshot(page)).actions.length;
        await bounded('Opted-in single-account fill', async remaining => {
            await startLookup(page);
            await expect(page.locator('#username')).toHaveValue(account.user, { timeout: remaining() });
            await expect(page.locator('#login-password')).toHaveValue(account.password, { timeout: remaining() });
        });
        expect(await fieldReads()).toBe(reads + 1);
        expect(await entryReads()).toBe(lists + 1);
        expect(await page.evaluate(() => window.formSubmits)).toBe(0);
        const observed = await snapshot(page), clicks = observed.actions.slice(offset);
        expect(clicks.some(item => item.trusted && ['toggle', 'lookup'].includes(item.action))).toBe(true);
        expect(clicks.filter(item => item.action.startsWith('entry-'))).toEqual([]);
        assertAccountAuthority(observed.packets);
        expect(await shadowValue(page, 'section')).not.toContain(account.password);
        await closedHelper(page, count);
        await archive(page);
        await page.reload(); await ready(page);
        await setAutoFillSingle(page, false);
        await clearFields(page); await lookup(page, account); await emptyFields(page);
        await closedHelper(page, count + 1);
        await fill(page, account);
        expect(helpers.size).toBe(count + 2);
        await sameApp(); await noHelpers();
        return { persistedInPrivateGM: true, automaticAccountClicks: 0, automaticFieldRequests: 1,
            automaticListRequests: 1, submissions: 0, optOutRestoresManualChoice: true };
    } finally { await archive(page); await page.close(); }
}
function panelGeometry(panel) {
    const box = panel.getBoundingClientRect(), viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    return { fits: box.width > 0 && box.height > 0 && box.left >= left - 1 && box.top >= top - 1
        && box.right <= left + width + 1 && box.bottom <= top + height + 1
        && panel.scrollWidth <= panel.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1,
        panel: { x: box.x, y: box.y, width: box.width, height: box.height },
        viewport: { left, top, width, height }, scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth };
}
async function captureNarrowPanels(page) {
    const original = page.viewportSize(), captures = [];
    await preferenceSettings(page);
    try {
        // A reduced desktop viewport models keyboard space; no native keyboard is emulated.
        for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 720 },
            { width: 320, height: 360 }, { width: 390, height: 360 }]) {
            await page.setViewportSize(viewport);
            await page.locator('#username').focus();
            await expect.poll(async () => (await panelLayout(page)).fits, { message: 'Panel must fit the visible viewport without horizontal overflow' }).toBe(true);
            const path = join(OUT, 'connect-' + viewport.width + (viewport.height === 360 ? '-keyboard' : '-panel') + '.png');
            await page.screenshot({ path });
            captures.push({ path, ...await panelLayout(page) });
        }
    } finally { if (original) await page.setViewportSize(original); }
    return captures;
}
async function testChoicePreference() {
    const page = await context.newPage(), count = helpers.size;
    try {
        await page.goto(CHOICE_ORIGIN + '/'); await ready(page);
        await setAutoFillSingle(page, true);
        const captures = await captureNarrowPanels(page);
        await emptyFields(page); await action(page, 'close');
        const reads = await fieldReads(), lists = await entryReads(), offset = (await snapshot(page)).actions.length;
        await startLookup(page);
        await expect.poll(() => shadowValue(page, '[data-role="entries"]'), { timeout: OPERATION_BUDGET }).toContain(CHOICE_ACCOUNTS[1].title);
        const listed = await shadowValue(page, '[data-role="entries"]');
        for (const account of CHOICE_ACCOUNTS) expect(listed).toContain(account.title);
        for (const account of ACCOUNTS) expect(listed).not.toContain(account.title);
        expect(await shadowValue(page, '[data-action="entry-0"]')).toBeTruthy();
        expect(await shadowValue(page, '[data-action="entry-1"]')).toBeTruthy();
        expect(await shadowValue(page, '[data-action="entry-2"]')).toBeNull();
        expect(await status(page)).toContain('Found 2 matching account');
        await expect.poll(() => shadowValue(page, '[data-action="lookup"]', 'disabled')).toBe(false);
        await page.waitForTimeout(250);
        await emptyFields(page);
        expect(await fieldReads()).toBe(reads);
        expect(await entryReads()).toBe(lists + 1);
        expect((await snapshot(page)).actions.slice(offset).filter(item => item.action.startsWith('entry-'))).toEqual([]);
        assertAccountAuthority((await snapshot(page)).packets);
        await closedHelper(page, count);
        const firstEntry = await shadowValue(page, '[data-action="entry-0"]');
        const selected = CHOICE_ACCOUNTS.find(account => firstEntry.includes(account.title));
        expect(selected).toBeTruthy();
        await fill(page, selected);
        await archive(page);
        await page.reload(); await ready(page);
        await setAutoFillSingle(page, false);
        expect(helpers.size).toBe(count + 1);
        await sameApp(); await noHelpers();
        return { matchingAccounts: 2, automaticFieldRequests: 0, manualSelectionStillFills: true,
            preferenceRestored: false, captures, keyboardViewport: 'resized desktop viewport' };
    } finally { await archive(page); await page.close(); }
}
async function armDrop(page, kind, wireAction) {
    const target = kind === 'reply' ? app : page, offset = (await snapshot(target)).packets.length;
    const beforeWindow = await windowTraffic();
    await adapter(target, `__kwxPortAdapter.dropWire(${JSON.stringify(kind)}, ${JSON.stringify(wireAction)})`);
    return { target, offset, kind, wireAction, windowOffset: beforeWindow.requests.length,
        postAttempts: beforeWindow.postAttempts[wireAction] || 0, logicalRequests: beforeWindow.logicalRequests[wireAction] || 0 };
}
async function droppedPacket(ticket) {
    const state = await snapshot(ticket.target);
    const dropped = state.packets.slice(ticket.offset).filter(item => item.direction === 'dropped');
    expect(dropped).toHaveLength(1);
    expect(state.dropNext).toBe(null);
    expect(dropped[0].data.kind).toBe(ticket.kind);
    expect(dropped[0].data.value.packet.body.action).toBe(ticket.wireAction);
    return dropped[0];
}
async function recoveredDrop(page, ticket) {
    const dropped = await droppedPacket(ticket), packet = dropped.data.value.packet;
    expect(validSignature(dropped.data.value)).toBe(true);
    const requests = (await snapshot(page)).packets.filter(item => ['sent', 'dropped'].includes(item.direction)
        && item.data.kind === 'request' && item.data.value?.packet?.id === packet.id);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(requests.map(item => stable(item.data.value))).size).toBe(1);
    expect(new Set(requests.map(item => item.port)).size).toBe(1);
    expect(new Set(requests.map(item => item.data.connectionId)).size).toBe(1);
    expect(requests.every(item => item.at < packet.deadline)).toBe(true);
    const replies = (await snapshot(page)).packets.filter(item => item.direction === 'received'
        && item.data.value?.packet?.id === packet.id);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every(item => item.at < packet.deadline && validSignature(item.data.value))).toBe(true);
    const traffic = await windowTraffic(), original = requests[0].data.value.packet.body;
    const posts = traffic.requests.slice(ticket.windowOffset).filter(item => item.data.action === ticket.wireAction);
    expect(posts.length).toBeGreaterThanOrEqual(ticket.kind === 'reply' ? 2 : 1);
    expect(traffic.postAttempts[ticket.wireAction] - ticket.postAttempts).toBe(posts.length);
    expect(traffic.logicalRequests[ticket.wireAction] - ticket.logicalRequests).toBe(1);
    expect(posts[0].data.kwRequest).toMatch(/^[0-9a-f-]{36}$/i);
    expect(new Set(posts.map(item => item.data.kwRequest)).size).toBe(1);
    expect(posts.every(item => /^[0-9a-f-]{36}$/i.test(item.data.kwAttempt))).toBe(true);
    expect(new Set(posts.map(({ data: { kwAttempt, ...execution } }) => stable(execution))).size).toBe(1);
    if (ticket.kind === 'reply') expect(new Set(posts.map(item => item.data.kwAttempt)).size).toBeGreaterThanOrEqual(2);
    expect(posts.every(item => item.data.message === original.message && item.data.nonce === original.nonce
        && item.data.kwDeadline === packet.deadline && item.at < packet.deadline)).toBe(true);
    if (ticket.kind === 'reply') {
        // With unchanged permission, core revalidation preserves the encrypted reply.
        const receipts = (await snapshot(app)).packets.filter(item => ['sent', 'dropped'].includes(item.direction)
            && item.data.kind === 'reply' && item.data.value?.packet?.id === packet.id);
        expect(receipts.length).toBeGreaterThanOrEqual(2);
        expect(new Set(receipts.map(item => stable(item.data.value))).size).toBe(1);
    }
    return { action: ticket.wireAction, dropped: ticket.kind, identicalSignedAttempts: requests.length,
        physicalWindowPosts: posts.length, logicalAppRequests: 1, originalAppRequestReplayed: ticket.kind === 'reply' };
}
async function recoverOperation(page, account, kind, wireAction) {
    await clearFields(page);
    const before = { fields: await fieldReads(), entries: await entryReads(), helpers: helpers.size, port: await physicalPort(page) };
    let ticket, recovery;
    if (wireAction === 'kwx-get-entries') ticket = await armDrop(page, kind, wireAction);
    await lookup(page, account);
    expect(await entryReads()).toBe(before.entries + 1);
    if (wireAction === 'kwx-get-entries') recovery = await recoveredDrop(page, ticket);
    else ticket = await armDrop(page, kind, wireAction);
    await fill(page, account);
    if (wireAction === 'kwx-get-entry-fields') recovery = await recoveredDrop(page, ticket);
    expect(await fieldReads()).toBe(before.fields + 1);
    expect(await physicalPort(page)).toEqual(before.port);
    expect(helpers.size).toBe(before.helpers);
    await sameApp(); await noHelpers();
    return { ...recovery, logicalFieldRequests: 1, logicalAccountListRequests: 1, physicalPortReused: true };
}
async function recoverInnerReply(page, account) {
    await clearFields(page); await lookup(page, account);
    const reads = await fieldReads(), port = await physicalPort(page), count = helpers.size, before = await windowTraffic();
    expect(before.responses.some(response => response.data.kwReceipt === 1 && before.requests.some(request =>
        request.data.kwRequest === response.data.kwRequest && request.data.kwConnection === response.data.kwConnection))).toBe(true);
    await app.evaluate(() => { __kwxNativeTest.dropNextResponse = 'kwx-get-entry-fields'; });
    await fill(page, account);
    const traffic = await windowTraffic(), dropped = traffic.dropped.slice(before.dropped.length);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].data.action).toBe('kwx-get-entry-fields');
    expect(dropped[0].data.kwReceipt).toBe(1);
    const posts = traffic.requests.slice(before.requests.length).filter(item => item.data.action === 'kwx-get-entry-fields');
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(traffic.postAttempts['kwx-get-entry-fields'] - (before.postAttempts['kwx-get-entry-fields'] || 0)).toBe(posts.length);
    const request = posts[0].data;
    expect(request.kwRequest).toMatch(/^[0-9a-f-]{36}$/i);
    expect(request.kwRequest).toBe(dropped[0].data.kwRequest);
    expect(request.kwAttempt).toBe(dropped[0].data.kwAttempt);
    expect(request.kwConnection).toBe(dropped[0].data.kwConnection);
    expect(typeof request.message).toBe('string'); expect(typeof request.nonce).toBe('string');
    expect(new Set(posts.map(item => item.data.kwRequest)).size).toBe(1);
    expect(new Set(posts.map(item => item.data.nonce)).size).toBe(1);
    expect(new Set(posts.map(item => stable(item.data))).size).toBe(1);
    expect(posts.every(item => item.at < request.kwDeadline)).toBe(true);
    const replies = traffic.responses.slice(before.responses.length).filter(item => item.data.kwRequest === request.kwRequest);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every(item => item.at < request.kwDeadline && stable(item.data) === stable(dropped[0].data))).toBe(true);
    expect(await fieldReads()).toBe(reads + 1);
    expect(await app.evaluate(() => __kwxNativeTest.dropNextResponse)).toBe(null);
    expect(await physicalPort(page)).toEqual(port); expect(helpers.size).toBe(count);
    await sameApp(); await noHelpers();
    return { logicalFieldRequests: 1, physicalWindowPosts: posts.length, droppedAppWindowResponses: 1,
        sameEncryptedClientNonce: true, physicalPortReused: true };
}
async function cancelWithToggle(page, account, operation) {
    return bounded(`Toggle cancels pending ${operation}`, async remaining => {
        await clearFields(page);
        if (operation === 'fill') await lookup(page, account);
        const reads = await fieldReads(), lists = await entryReads(), port = await physicalPort(page), count = helpers.size;
        const events = await page.evaluate(() => window.credentialInputEvents);
        const wireAction = operation === 'fill' ? 'kwx-get-entry-fields' : 'kwx-get-entries';
        await app.evaluate(wireAction => { __kwxNativeTest.holdAction = wireAction; }, wireAction);
        try {
            if (operation === 'fill') await action(page, 'entry-0'); else await startLookup(page);
            await expect.poll(() => app.evaluate(() => __kwxNativeTest.heldResponses.length),
                { timeout: remaining(), intervals: [25, 50, 100] }).toBeGreaterThan(0);
            await emptyFields(page);
            const packet = (await snapshot(page)).packets.filter(item => item.direction === 'sent'
                && item.data.value?.packet?.body?.action === wireAction).at(-1).data.value.packet;
            await action(page, 'toggle');
            expect(await shadowValue(page, 'section', 'hidden')).toBe(true);
            expect(await shadowValue(page, '[data-action="lookup"]', 'disabled')).toBe(false);
            const stopped = await status(page), attempts = async () => (await snapshot(page)).packets.filter(item =>
                item.direction === 'sent' && item.data.value?.packet?.id === packet.id).length;
            const attemptsAtClose = await attempts();
            expect(await app.evaluate(() => __kwxNativeTest.releaseResponses())).toBeGreaterThan(0);
            await page.waitForTimeout(1700);
            expect(await attempts()).toBe(attemptsAtClose);
            expect(await shadowValue(page, 'section', 'hidden')).toBe(true);
            expect(await status(page)).toBe(stopped);
            expect(await entries(page)).not.toContain(account.title);
            await emptyFields(page);
            expect(await page.evaluate(() => window.credentialInputEvents)).toBe(events);
            expect(await fieldReads()).toBe(reads + (operation === 'fill' ? 1 : 0));
            expect(await entryReads()).toBe(lists + (operation === 'lookup' ? 1 : 0));
            expect(await physicalPort(page)).toEqual(port); expect(helpers.size).toBe(count);
            await sameApp(); await noHelpers();
            remaining();
        } finally { await app.evaluate(() => __kwxNativeTest.releaseResponses()); }
    });
}
async function cancelDroppedFill(page, account) {
    return bounded('Cancel receipt recovery', async remaining => {
        await clearFields(page); await lookup(page, account);
        const reads = await fieldReads(), port = await physicalPort(page), count = helpers.size;
        const ticket = await armDrop(page, 'reply', 'kwx-get-entry-fields');
        const events = await page.evaluate(() => window.credentialInputEvents);
        await action(page, 'entry-0');
        await expect.poll(async () => (await snapshot(app)).packets.slice(ticket.offset)
            .filter(item => item.direction === 'dropped').length, { timeout: remaining(), intervals: [25, 50, 100] }).toBe(1);
        expect(await status(page)).toContain('Reading account details');
        const dropped = await droppedPacket(ticket), id = dropped.data.value.packet.id;
        await action(page, 'close');
        const attempts = async () => (await snapshot(page)).packets.filter(item => item.direction === 'sent'
            && item.data.value?.packet?.id === id).length;
        const attemptsAtClose = await attempts();
        await page.waitForTimeout(1700);
        expect(await attempts()).toBe(attemptsAtClose);
        await emptyFields(page);
        expect(await page.evaluate(() => window.credentialInputEvents)).toBe(events);
        expect(await fieldReads()).toBe(reads + 1);
        expect(await physicalPort(page)).toEqual(port);
        expect(helpers.size).toBe(count);
        await sameApp(); await noHelpers();
    });
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
// Only references returned to the userscript are wrapped. Native events and ports
// still cross the browser boundary; the helper's own page-world close stays native.
function helperCloseFault({ marker, appOrigin, blocked }) {
    const state = { blocked, attempts: [], sources: [], messages: [] }, refs = [], proxies = new WeakMap();
    globalThis.__kwxHelperClose = state;
    state.snapshot = () => ({ blocked: state.blocked, attempts: state.attempts, sources: state.sources,
        messages: state.messages, references: refs.map(({ raw, url }) => ({ url, closed: raw.closed })) });
    if (location.origin === appOrigin) return;
    const nativeOpen = window.open;
    window.open = function (...args) {
        const raw = nativeOpen.apply(this, args);
        const url = new URL(String(args[0]), location.href);
        if (!raw || url.origin !== appOrigin || url.pathname !== '/connect-port/relay.html') return raw;
        if (proxies.has(raw)) return proxies.get(raw);
        const index = refs.length, methods = new Map();
        const close = () => {
            const attempt = { at: Date.now(), reference: index, blocked: state.blocked, closedBefore: raw.closed };
            state.attempts.push(attempt);
            if (!state.blocked) raw.close();
            attempt.closedAfter = raw.closed;
        };
        const proxy = new Proxy(raw, { get(target, key) {
            if (key === 'close') return close;
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            if (!methods.has(key)) methods.set(key, key === 'postMessage' ? (data, ...rest) => {
                if (data?.marker === marker) state.messages.push({ at: Date.now(), reference: index, data: structuredClone(data) });
                return value.call(target, data, ...rest);
            } : value.bind(target));
            return methods.get(key);
        } });
        refs.push({ raw, url: url.href }); proxies.set(raw, proxy);
        return proxy;
    };
    const nativeAdd = window.addEventListener, nativeRemove = window.removeEventListener, listeners = new WeakMap();
    window.addEventListener = function (type, listener, ...rest) {
        if (type !== 'message' || !listener) return nativeAdd.call(this, type, listener, ...rest);
        if (!listeners.has(listener)) listeners.set(listener, function (event) {
            const source = proxies.get(event.source);
            const adapted = source ? new Proxy(event, { get(target, key) {
                if (key === 'source') return source;
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            } }) : event;
            if (source && event.data?.marker === marker) state.sources.push({ at: Date.now(), trusted: adapted.isTrusted,
                origin: adapted.origin, kind: adapted.data.kind, sourceMatches: adapted.source === source,
                nativePorts: adapted.ports === event.ports });
            return typeof listener === 'function' ? listener.call(this, adapted) : listener.handleEvent(adapted);
        });
        return nativeAdd.call(this, type, listeners.get(listener), ...rest);
    };
    window.removeEventListener = function (type, listener, ...rest) {
        return nativeRemove.call(this, type, type === 'message' ? listeners.get(listener) || listener : listener, ...rest);
    };
}

// Capture public close controls before the production relay listener. A one-shot
// flag drops only the worker handoff notice to exercise the trusted opener path.
function observeHelper({ marker }) {
    if (location.pathname !== '/connect-port/relay.html') return;
    const dropHandoff = localStorage.getItem('__kwxDropWorkerHandoff') === '1';
    if (dropHandoff) localStorage.removeItem('__kwxDropWorkerHandoff');
    const record = (channel, event, sourceMatches, dropped = false) => {
        if (event.data?.marker !== marker) return;
        void globalThis.kwxHelperTrace({ url: location.href, at: Date.now(), channel, trusted: event.isTrusted,
            sourceMatches, origin: event.origin, ports: event.ports.length, dropped, data: structuredClone(event.data) });
    };
    addEventListener('message', event => record('opener', event, event.source === window.opener), true);
    navigator.serviceWorker.addEventListener('message', event => {
        const dropped = dropHandoff && event.data?.marker === marker && event.data.kind === 'handoff-complete';
        record('worker', event, event.source === navigator.serviceWorker.controller, dropped);
        if (dropped) event.stopImmediatePropagation();
    }, true);
}

function assertAccountAuthority(packets) {
    for (const wire of packets.filter(item => item.direction === 'sent' && item.data.kind === 'request'
        && item.data.value?.packet?.operation === 'wire')) {
        const samePort = item => item.port === wire.port && item.data.connectionId === wire.data.connectionId;
        const ready = packets.find(item => samePort(item) && item.direction === 'received' && item.data.kind === 'ready');
        const hello = packets.find(item => samePort(item) && item.direction === 'received'
            && item.data.value?.packet?.operation === 'hello' && item.data.value.packet.error === undefined);
        expect(ready, 'Account traffic requires signed ready').toBeTruthy();
        expect(validReadyProof(ready.data)).toBe(true);
        expect(hello, 'Account traffic requires a verified native hello reply').toBeTruthy();
        expect(validSignature(hello.data.value)).toBe(true);
        expect(ready.at).toBeLessThanOrEqual(hello.at);
        expect(hello.at).toBeLessThanOrEqual(wire.at);
    }
}

let workerOverride = LEGACY_WORKER, workerUpgradeGate, releaseWorkerUpgrade, upgradePage;
function legacyWorkerBody() {
    return `self.addEventListener('message', event => {
        event.source?.postMessage({marker: 'keewebx-connect-port-v1', kind: 'fixture-legacy-observed', operation: event.data?.kind});
    });\n${LEGACY_WORKER}`;
}
async function installLegacyWorker(origin) {
    if (!LEGACY_WORKER) return;
    expect(LEGACY_WORKER).not.toContain('relay-capabilities');
    expect(LEGACY_WORKER).not.toContain('handoff-complete');
    upgradePage = await context.newPage();
    await upgradePage.goto(origin + '/connect-port/upgrade-fixture.html');
    await upgradePage.evaluate(async () => {
        await navigator.serviceWorker.register('./worker.js', { scope: './', updateViaCache: 'none' });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise(resolve =>
            navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    await expect.poll(() => upgradePage.evaluate(() => navigator.serviceWorker.controller?.state), { timeout: 8000 }).toBe('activated');
    workerOverride = null;
    workerUpgradeGate = new Promise(resolve => { releaseWorkerUpgrade = resolve; });
}
async function finishLegacyWorker() {
    if (!LEGACY_WORKER) return;
    const legacyMessages = (report.helperMessages || []).filter(item => item.data.kind === 'fixture-legacy-observed');
    expect(legacyMessages.some(item => item.trusted && item.sourceMatches && item.data.operation === 'probe-relay')).toBe(true);
    expect(legacyMessages.some(item => item.data.operation === 'attach')).toBe(false);
    expect((report.helperMessages || []).some(item => item.trusted && item.sourceMatches
        && item.data.kind === 'relay-capabilities' && item.data.protocol === 'self-close-v1')).toBe(true);
    report.workerUpgrade = { historicalWorkerSha256: createHash('sha256').update(LEGACY_WORKER).digest('hex'),
        legacyControllerProbed: true, attachedToLegacyWorker: false, firstConnectionSucceeded: true };
    await upgradePage.close(); upgradePage = undefined;
}
async function closureNotice(page, before, kind, dropped = false) {
    const helper = [...helpers.values()][before], url = new URL(helper.url);
    const ready = (await snapshot(page)).packets.find(item => item.direction === 'received'
        && item.data.kind === 'ready' && item.at >= helper.openedAt);
    const expected = { marker: PORT_MARK, kind, nonce: url.searchParams.get('nonce'),
        connectionId: ready.data.connectionId, endpoint: url.searchParams.get('endpoint') };
    const matches = () => (report.helperMessages || []).filter(item => item.url === helper.url
        && item.data.kind === kind && item.dropped === dropped);
    await expect.poll(() => matches().length, { timeout: 2000 }).toBeGreaterThan(0);
    const notice = matches()[0];
    expect(notice.data).toEqual(expected);
    expect(notice.trusted && notice.sourceMatches).toBe(true);
    expect(notice.ports).toBe(0);
    expect(notice.channel).toBe(kind === 'handoff-complete' ? 'worker' : 'opener');
    if (notice.channel === 'opener') expect(notice.origin).toBe(url.searchParams.get('site'));
    helper.closureControl = kind; helper.closureControlDropped = dropped;
    return notice;
}

async function openerFallback() {
    return bounded('Opener self-close fallback', async remaining => {
        const website = await context.newPage(), before = helpers.size;
        await website.goto(ACCOUNTS[0].url); await ready(website); await emptyFields(website);
        await adapter(website, '__kwxHelperClose.blocked = true');
        await app.evaluate(() => localStorage.setItem('__kwxDropWorkerHandoff', '1'));
        const reads = await fieldReads(), lists = await entryReads();
        await adapter(app, '__kwxPortAdapter.holdHello = true');
        try {
            await startLookup(website);
            await expect.poll(async () => (await snapshot(app)).heldHello, { timeout: remaining() }).toBeGreaterThan(0);
            await closedHelper(website, before);
            await closureNotice(website, before, 'handoff-complete', true);
            await closureNotice(website, before, 'relay-complete');
            const { helperClose, packets } = await snapshot(website);
            expect(helperClose.attempts.length).toBeGreaterThan(0);
            expect(helperClose.attempts.every(item => item.blocked && !item.closedBefore && !item.closedAfter)).toBe(true);
            expect(packets.some(item => item.direction === 'received' && item.data.value?.packet?.operation === 'hello')).toBe(false);
            expect(await entryReads()).toBe(lists); expect(await fieldReads()).toBe(reads);
            await emptyFields(website);
            await adapter(app, '__kwxPortAdapter.releaseHello()');
            await matchingList(website, ACCOUNTS[0], reads, remaining);
            await fill(website, ACCOUNTS[0]);
            remaining();
            return { workerNoticeDropped: true, trustedOpenerSelfClosed: true, remoteCloseAttemptsBlocked: helperClose.attempts.length,
                signedReadyAndHelloRequiredBeforeAccountData: true };
        } finally {
            await adapter(app, '__kwxPortAdapter.releaseHello()');
            await app.evaluate(() => localStorage.removeItem('__kwxDropWorkerHandoff'));
            await archive(website);
            await website.close();
        }
    });
}

async function closedHelper(page, countBefore) {
    await noHelpers();
    expect(helpers.size).toBe(countBefore + 1);
    const helper = [...helpers.values()][countBefore], url = new URL(helper.url);
    expect(url.searchParams.getAll('site')).toEqual([new URL(page.url()).origin]);
    expect(url.searchParams.getAll('endpoint')).toEqual([APP]);
    expect(url.searchParams.getAll('nonce')).toHaveLength(1);
    expect(url.searchParams.get('nonce')).toMatch(/^[0-9a-f-]{36}$/i);
    const { packets, helperClose } = await snapshot(page);
    assertAccountAuthority(packets);
    expect(helperClose.references).toContainEqual({ url: helper.url, closed: true });
    expect(helperClose.sources.some(item => item.kind === 'relay-ready')).toBe(true);
    expect(helperClose.sources.every(item => item.trusted && item.sourceMatches && item.nativePorts
        && item.origin === url.origin)).toBe(true);
    if (helperClose.blocked) expect(helperClose.attempts.every(item => item.blocked
        && item.closedAfter === item.closedBefore)).toBe(true);
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
    expect(packets.some(item => item.direction === 'sent' && item.port === ready.port
        && item.data.kind === 'request' && item.data.connectionId === ready.data.connectionId
        && item.data.value?.packet?.operation === 'hello' && item.at >= ready.at)).toBe(true);
    expect(helper.automaticClosure).toBe(true);
    helper.signedReadyVerified = true;
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
function installAdapter({ appURL, prefix, portMarker, blockHelperClose }) {
    helperCloseFault({ marker: portMarker, appOrigin: new URL(appURL).origin, blocked: blockHelperClose });
    const isApp = location.href === appURL;
    const state = {
        boot: crypto.randomUUID(), href: location.href, role: isApp ? 'app' : 'site', blockGM: false,
        reads: 0, allowedReads: 0, blockedReads: 0, mailboxAttempts: [], packets: [], attachments: [], statuses: [], actions: [],
        holdHello: false, heldHello: [], releaseHello: undefined, send: undefined, dropNext: null
    };
    globalThis.__kwxPortAdapter = state;
    const NativeObserver = MutationObserver;
    globalThis.MutationObserver = class extends NativeObserver {
        constructor(callback) {
            super((records, observer) => {
                if (state.suppressRestoration && observer.restoration) return;
                callback(records, observer);
            });
        }
        observe(target, options) {
            this.restoration = isApp && target === document.body;
            return super.observe(target, options);
        }
    };
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (...args) {
        const root = attachShadow.apply(this, args);
        root.addEventListener('click', event => {
            const control = event.composedPath().find(node => node?.dataset?.action);
            if (control) state.actions.push({ action: control.dataset.action, trusted: event.isTrusted });
        }, true);
        new MutationObserver(() => {
            if (this.id !== 'keewebx-userscript-connect') return;
            const text = root.querySelector('[role="status"]')?.textContent;
            if (text && state.statuses.at(-1) !== text) state.statuses.push(text);
        }).observe(root, { childList: true, characterData: true, subtree: true });
        return root;
    };
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
    // Observe signed ready independently of routing-page closure.
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
        if (isApp && state.dropDiscoveryReplies > 0 && ['app-ready', 'app-state'].includes(data.kind)) {
            state.dropDiscoveryReplies--; state.droppedDiscoveryReplies = (state.droppedDiscoveryReplies || 0) + 1;
            record(this, 'dropped', data); return;
        }
        if (isApp && ['app-ready', 'app-state'].includes(data.kind) && state.holdDiscoveryUntil > Date.now()) {
            const port = this;
            state.delayedDiscoveryReplies = (state.delayedDiscoveryReplies || 0) + 1;
            record(port, 'delayed', data);
            setTimeout(() => {
                record(port, 'sent', data);
                nativePost.call(port, data, ...rest);
            }, state.holdDiscoveryUntil - Date.now());
            return;
        }
        if (!isApp && data.kind === 'request') lastRequest = { port: this, data };
        if (isApp && data.kind === 'reply' && data.value?.packet?.operation === 'hello' && state.holdHelloUntil > Date.now()) {
            const port = this;
            record(port, 'delayed', data);
            setTimeout(() => {
                record(port, 'sent', data);
                nativePost.call(port, data, ...rest);
            }, state.holdHelloUntil - Date.now());
            return;
        }
        if (isApp && state.holdHello && data.kind === 'reply' && data.value?.packet?.operation === 'hello') {
            state.heldHello.push({ port: this, data, rest });
            return;
        }
        if (state.dropNext?.kind === data.kind && data.value?.packet?.operation === 'wire'
            && data.value.packet.body?.action === state.dropNext.action) {
            state.dropNext = null;
            record(this, 'dropped', data);
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
    state.dropWire = (kind, action) => {
        if (state.dropNext || !['request', 'reply'].includes(kind)
            || !['kwx-get-entries', 'kwx-get-entry-fields'].includes(action)
            || (kind === 'reply') !== isApp) throw new Error('Invalid or already armed one-shot wire drop');
        state.dropNext = { kind, action };
    };
    state.snapshot = () => ({
        boot: state.boot, href: state.href, role: state.role, blockGM: state.blockGM,
        reads: state.reads, allowedReads: state.allowedReads, blockedReads: state.blockedReads,
        mailboxAttempts: state.mailboxAttempts, packets: state.packets, attachments: state.attachments,
        helperClose: __kwxHelperClose.snapshot(), heldHello: state.heldHello.length, dropNext: state.dropNext, statuses: state.statuses, actions: state.actions,
        droppedDiscoveryReplies: state.droppedDiscoveryReplies || 0,
        delayedDiscoveryReplies: state.delayedDiscoveryReplies || 0
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
            if (url.pathname === '/connect-port/upgrade-fixture.html') {
                response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end('<!doctype html><title>Worker upgrade fixture</title>'); return;
            }
            if (url.pathname === '/connect-port/worker.js') {
                if (workerOverride) { response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }).end(legacyWorkerBody()); return; }
                if (workerUpgradeGate) await workerUpgradeGate;
            }
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
        socket.on('error', () => socket.destroy());
    });
    proxyServer.listen(0, '127.0.0.1');
    await once(proxyServer, 'listening');
    return 'http://127.0.0.1:' + proxyServer.address().port;
}
async function setup(bundle, appBundle = bundle) {
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
    // Both versions execute in the same isolated-world GM adapter; no source is patched.
    const installer = appBundle === bundle ? bundle : `if (location.href === ${JSON.stringify(APP)}) {
        ${appBundle}
    } else {
        ${bundle}
    }`;
    writeFileSync(join(extension, 'content.js'), `(() => {
        ${helperCloseFault.toString()}
        const GM = (${installAdapter.toString()})(${JSON.stringify({ appURL: APP, prefix: PREFIX, portMarker: PORT_MARK, blockHelperClose: BLOCK_HELPER_CLOSE })});
        ${installer}
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
    await context.exposeBinding('kwxHelperTrace', (_source, detail) => {
        (report.helperMessages ||= []).push(detail);
        if (detail.data.kind === 'fixture-legacy-observed' && detail.data.operation === 'probe-relay') releaseWorkerUpgrade?.();
    });
    await context.addInitScript(observeHelper, { marker: PORT_MARK });
    await context.addInitScript(() => {
        if (location.protocol !== 'https:') return;
        const observed = { documentBoot: crypto.randomUUID(), wireRequests: {}, logicalRequests: {}, windowRequests: [], windowResponses: [],
            droppedResponses: [], dropNextResponse: null, holdAction: null, heldResponses: [], consentCount: 0, heldFields: [], holdFields: false };
        globalThis.__kwxNativeTest = observed;
        const requestIds = new Set();
        const nativePost = window.postMessage.bind(window);
        window.postMessage = (value, ...rest) => {
            if (value?.kwConnect === 'response' && value.action === observed.dropNextResponse) {
                observed.dropNextResponse = null;
                observed.droppedResponses.push({ at: Date.now(), data: structuredClone(value) }); return;
            }
            if (observed.holdFields && value?.kwConnect === 'response' && value.action === 'kwx-get-entry-fields') {
                observed.heldFields.push([value, rest]); return;
            }
            if (value?.kwConnect === 'response' && value.action === observed.holdAction) {
                observed.heldResponses.push([value, rest]); return;
            }
            return nativePost(value, ...rest);
        };
        observed.releaseResponses = () => {
            observed.holdAction = null;
            const pending = observed.heldResponses.splice(0);
            for (const [value, rest] of pending) nativePost(value, ...rest);
            return pending.length;
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
                observed.windowRequests.push({ at: Date.now(), data: structuredClone(event.data) });
                const id = event.data.kwRequest;
                if (typeof id !== 'string' || !requestIds.has(id)) {
                    if (typeof id === 'string') requestIds.add(id);
                    observed.logicalRequests[name] = (observed.logicalRequests[name] || 0) + 1;
                }
            } else if (event.source === window && event.origin === location.origin && event.data?.kwConnect === 'response') {
                observed.windowResponses.push({ at: Date.now(), data: structuredClone(event.data) });
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

acceptance: try {
    const bundle = readFileSync(SOURCE, 'utf8');
    const appBundle = APP_SOURCE === SOURCE ? bundle : readFileSync(APP_SOURCE, 'utf8');
    expectedSiteVersion = bundle.match(/^\/\/ @version\s+([^\s]+)\s*$/m)?.[1];
    expectedAppVersion = appBundle.match(/^\/\/ @version\s+([^\s]+)\s*$/m)?.[1];
    report.bundle = { bytes: Buffer.byteLength(bundle), sha256: createHash('sha256').update(bundle).digest('hex') };
    report.appBundle = { path: APP_SOURCE, version: expectedAppVersion, overridden: APP_SOURCE !== SOURCE,
        bytes: Buffer.byteLength(appBundle), sha256: createHash('sha256').update(appBundle).digest('hex') };
    await step('require the current production installer and built MessagePort assets', async () => {
        expect(expectedSiteVersion, 'Website installer must declare its version').toMatch(/^\d+\.\d+\.\d+$/);
        expect(bundle).toContain(PORT_MARK);
        expect(expectedAppVersion, 'App installer must declare its version').toMatch(/^\d+\.\d+\.\d+$/);
        expect(appBundle).toContain(PORT_MARK);
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
    await step('create a real encrypted KDBX with original stress accounts and an isolated choice origin', async () => {
        const source = `import * as kdbx from ${JSON.stringify(pathToFileURL(join(ROOT, 'modules/db/lib/index.ts')).href)};
            import {argon2} from ${JSON.stringify(pathToFileURL(join(ROOT, 'modules/db/test/test-support/argon2.ts')).href)};
            import {writeFileSync} from 'node:fs'; kdbx.CryptoEngine.setArgon2Impl(argon2);
            const db=kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(${JSON.stringify(DB_PASSWORD)})),'Disposable Connect');
            db.header.kdfParameters.set('M',kdbx.VarDictionary.ValueType.UInt64,kdbx.Int64.from(32768));
            db.header.kdfParameters.set('I',kdbx.VarDictionary.ValueType.UInt64,kdbx.Int64.from(2));
            for(const account of ${JSON.stringify(VAULT_ACCOUNTS)}){const entry=db.createEntry(db.getDefaultGroup());
                entry.fields.set('Title',account.title);entry.fields.set('URL',account.url);entry.fields.set('UserName',account.user);
                entry.fields.set('Password',kdbx.ProtectedValue.fromString(account.password));}
            writeFileSync(${JSON.stringify(join(OUT, 'fixture.kdbx'))},new Uint8Array(await db.save()));`;
        execFileSync(BUN, ['--eval', source], { cwd: ROOT, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    });
    await setup(bundle, appBundle);
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
        expect(approvedRoute.wireReceipt).toBe(1);
        const learned = await windowTraffic();
        expect(learned.responses.some(response => response.data.kwReceipt === 1 && learned.requests.some(request =>
            request.data.kwRequest === response.data.kwRequest && request.data.kwConnection === response.data.kwConnection))).toBe(true);
        expect(approvedRoute.endpoint).toBe(APP);
        originalApp = await documentState(app);
        if (BLOCK_APP_GM) await adapter(app, '__kwxPortAdapter.blockGM = true');
        await sameApp(); await noHelpers();
    });
    await step('worker handoff self-closes the first helper while hello is held; a cached retry survives a lost first reply', async () => {
        await installLegacyWorker(new URL(APP).origin);
        first = await newWebsite(ACCOUNTS[0]);
        const count = helpers.size, reads = await fieldReads(), lists = await entryReads();
        await adapter(first, '__kwxHelperClose.blocked = true');
        await adapter(app, '__kwxPortAdapter.holdHello = true');
        try {
            await startLookup(first);
            await expect.poll(async () => (await snapshot(app)).heldHello, { timeout: 25000 }).toBeGreaterThanOrEqual(1);
            await expect.poll(() => helpers.size).toBe(count + 1);
            const helper = [...helpers.keys()][count];
            await expect.poll(() => helper.isClosed(), { timeout: 2000, message: 'Worker handoff must self-close the helper while RPC hello is held' }).toBe(true);
            await closedHelper(first, count);
            await closureNotice(first, count, 'handoff-complete');
            await finishLegacyWorker();
            expect(await entryReads()).toBe(lists);
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
    await step('a delayed hello resumes automatically on the same signed port and ignores expired replies', async () => {
        const page = await newWebsite(ACCOUNTS[0]), count = helpers.size;
        const reads = await fieldReads(), lists = await entryReads(), started = Date.now();
        await adapter(app, '__kwxPortAdapter.holdHelloUntil = Date.now() + 10500');
        try {
            await startLookup(page);
            await expect.poll(() => helpers.size).toBe(count + 1);
            await closedHelper(page, count);
            await page.waitForTimeout(8500);
            expect(await status(page)).not.toMatch(/timed out|expired/i);
            expect(await entryReads()).toBe(lists); expect(await fieldReads()).toBe(reads);
            await matchingList(page, ACCOUNTS[0], reads);
            const helloRequests = (await snapshot(page)).packets.filter(item => item.direction === 'sent'
                && item.data.kind === 'request' && item.data.value?.packet?.operation === 'hello');
            expect(new Set(helloRequests.map(item => item.data.value.packet.id)).size).toBe(2);
            expect(new Set(helloRequests.map(item => item.data.connectionId)).size).toBe(1);
            await fill(page, ACCOUNTS[0]);
            expect(await fieldReads()).toBe(reads + 1); expect(await entryReads()).toBe(lists + 1);
            expect(helpers.size).toBe(count + 1);
            await physicalPort(page); await sameApp(); await noHelpers();
            return { elapsedMs: Date.now() - started, delayedReplyMs: 10500, freshHelloRequests: 2,
                physicalPorts: 1, temporaryPages: 1, logicalFieldReads: 1, expiredReplyIgnored: true };
        } finally {
            await adapter(app, '__kwxPortAdapter.holdHelloUntil = 0');
            await archive(page); await page.close();
        }
    });
    if (FOCUS_HELLO) { report.passed = true; report.focus = 'delayed-hello'; break acceptance; }
    await step('trusted opener self-closes the helper when worker handoff notice is lost and remote close is blocked', openerFallback);
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
    await step('after three successful fills, inner and outer reply loss recovers with one logical request per operation', async () => {
        for (let index = 0; index < 3; index++) {
            await clearFields(first); await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]);
        }
        const innerRecovery = await recoverInnerReply(first, ACCOUNTS[0]), recoveries = [];
        for (const wireAction of ['kwx-get-entries', 'kwx-get-entry-fields'])
            recoveries.push(await recoverOperation(first, ACCOUNTS[0], 'reply', wireAction));
        return { warmupFills: 3, innerRecovery, recoveries };
    });
    await step('lost first list and detail requests resend the same signed packet with one logical App request', async () => {
        const recoveries = [];
        for (const wireAction of ['kwx-get-entries', 'kwx-get-entry-fields'])
            recoveries.push(await recoverOperation(first, ACCOUNTS[0], 'request', wireAction));
        return { recoveries };
    });
    await step('launcher follows recognized login fields and settings before focus opens without network traffic', testLauncherVisibility);
    await step('24 alternating lookup and fill cycles recover periodic losses and UI cancellation on both physical ports', async () => {
        const count = helpers.size, ports = [await physicalPort(first), await physicalPort(second)];
        const reads = await fieldReads();
        let canceledRecoveries = 0;
        for (let index = 0; index < 24; index++) {
            const site = index % 2, page = [first, second][site], account = ACCOUNTS[site], mode = Math.floor(index / 2) % 6;
            if (mode === 4) { await cancelDroppedFill(page, account); canceledRecoveries++; }
            if (mode < 4) await recoverOperation(page, account, mode < 2 ? 'reply' : 'request',
                mode % 2 ? 'kwx-get-entry-fields' : 'kwx-get-entries');
            else { await clearFields(page); await lookup(page, account); await fill(page, account); }
            await config(page); await probe(page); await action(page, 'close');
            expect(await physicalPort(page)).toEqual(ports[site]); await sameApp(); await noHelpers();
        }
        await first.waitForTimeout(350);
        expect(await fieldReads()).toBe(reads + 24 + canceledRecoveries);
        expect(helpers.size).toBe(count);
        return { alternatingFills: 24, periodicDrops: 20, canceledRecoveries, logicalFieldRequests: 24 + canceledRecoveries,
            persistentPhysicalPorts: 2, idleHelpers: 0, aggregateLookupOrFillBudget: OPERATION_BUDGET };
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
    await step('toggle key closes and cancels pending lookup before late encrypted replies', () => cancelWithToggle(first, ACCOUNTS[0], 'lookup'));
    await step('toggle key closes and cancels pending fill before late encrypted replies', () => cancelWithToggle(first, ACCOUNTS[0], 'fill'));
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
    await step('native opt-in persists across reload and fills a single match; opt-out restores manual selection', testSinglePreference);
    await step('opt-in keeps multiple matches as a choice and narrow panels fit normal and keyboard viewports', testChoicePreference);
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
    await step('passkey unlock restores Connect when the DOM restoration observer misses unlock', async () => {
        await app.bringToFront();
        const session = await context.newCDPSession(app);
        await session.send('WebAuthn.enable');
        await session.send('WebAuthn.addVirtualAuthenticator', { options: {
            protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
            hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true
        } });
        await app.evaluate(() => {
            window.__keewebx_passkey_capability_override = { prf: 'supported', reason: 'Virtual authenticator test',
                platform: { os: 'macos', browser: 'chrome', osVersion: '15.0.0' } };
        });
        await app.getByRole('button', { name: 'Settings', exact: true }).filter({ visible: true }).click();
        await app.getByRole('tab', { name: 'Database', exact: true }).click();
        const section = app.getByRole('region', { name: 'Local passkey unlock', exact: true });
        await section.getByLabel('Current master password', { exact: true }).fill(DB_PASSWORD);
        await section.getByRole('button', { name: 'Enable local passkey', exact: true }).click();
        await section.getByRole('button', { name: 'Verify passkey', exact: true }).click();
        await expect(section.getByRole('status')).toContainText('Passkey unlock saved in this browser');
        await app.getByRole('button', { name: 'Back to vault', exact: true }).filter({ visible: true }).click();
        const port = await physicalPort(first), count = helpers.size;
        await app.getByRole('button', { name: 'Lock', exact: true }).filter({ visible: true }).click();
        await expect(app.getByRole('button', { name: 'Unlock with passkey', exact: true })).toBeVisible();
        await untilStatus(app, /locked.*unlock/i);
        // Deliberately lose only the DOM-based unlock signal. The App's access
        // notification must resume the existing grant and clear the locked scope.
        await adapter(app, '__kwxPortAdapter.suppressRestoration = true');
        try {
            await app.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
            await expect(app.locator('.entry-row').first()).toBeVisible();
            await untilStatus(app, /Authorized/);
            await clearFields(first); await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]);
            expect(await physicalPort(first)).toEqual(port);
            expect(helpers.size).toBe(count);
            await sameApp(); await noHelpers();
        } finally { await adapter(app, '__kwxPortAdapter.suppressRestoration = false'); }
    });
    await step('an App replying after the first discovery deadline resumes the same helper and fills once', async () => {
        const before = await snapshot(app), count = helpers.size;
        const page = await newWebsite(ACCOUNTS[0]);
        const started = Date.now();
        await adapter(app, '__kwxPortAdapter.holdDiscoveryUntil = Date.now() + 10500');
        try {
            await lookup(page, ACCOUNTS[0]);
            const elapsed = Date.now() - started;
            expect(elapsed).toBeGreaterThanOrEqual(10000);
            expect(elapsed).toBeLessThan(OPERATION_BUDGET);
            await closedHelper(page, count); await fill(page, ACCOUNTS[0]);
            const after = await snapshot(app), attempts = after.attachments.slice(before.attachments.length);
            expect(after.delayedDiscoveryReplies).toBeGreaterThan(before.delayedDiscoveryReplies);
            expect(attempts.filter(item => item.data.kind === 'find-app').length).toBeGreaterThanOrEqual(5);
            expect(attempts.filter(item => item.data.kind === 'attach-port')).toHaveLength(1);
            expect(helpers.size).toBe(count + 1);
            await sameApp(); await noHelpers();
            return { elapsedMs: elapsed, delayedReplyMs: 10500, sameTemporaryPage: true,
                websitePortTransferredOnce: true, originalAppReused: true };
        } finally {
            await adapter(app, '__kwxPortAdapter.holdDiscoveryUntil = 0');
            await archive(page); await page.close();
        }
    });
    await step('a lost App discovery reply recovers on a fresh channel before handing off once', async () => {
        const before = await snapshot(app), count = helpers.size;
        await adapter(app, '__kwxPortAdapter.dropDiscoveryReplies = 1');
        const page = await newWebsite(ACCOUNTS[0]);
        try {
            await lookup(page, ACCOUNTS[0]); await closedHelper(page, count); await fill(page, ACCOUNTS[0]);
            const after = await snapshot(app);
            expect(after.droppedDiscoveryReplies - before.droppedDiscoveryReplies).toBe(1);
            const attempts = after.attachments.slice(before.attachments.length);
            expect(attempts.filter(item => item.data.kind === 'find-app').length).toBeGreaterThanOrEqual(2);
            expect(attempts.filter(item => item.data.kind === 'attach-port')).toHaveLength(1);
            await sameApp(); await noHelpers();
        } finally { await archive(page); await page.close(); }
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
        for (const document of allDocuments.filter(document => document.role === 'site')) assertAccountAuthority(document.packets);
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
        const signedReadyVerified = [...helpers.values()].filter(helper => helper.signedReadyVerified).length;
        const readyProofs = traffic.filter(item => item.direction === 'received' && item.data.kind === 'ready');
        expect(readyProofs.length).toBeGreaterThanOrEqual(signedReadyVerified);
        expect(readyProofs.every(item => validReadyProof(item.data) && item.data.appBoot === approvedRoute.host
            && item.data.endpoint === APP && WEBSITE_ORIGINS.includes(item.data.siteOrigin))).toBe(true);
        expect(attachments.length).toBeGreaterThanOrEqual(signedReadyVerified);
        expect(attachments.every(item => item.trusted && item.worker === 'https://keewebx.app/connect-port/worker.js'
            && item.data.appBoot === approvedRoute.host && item.data.endpoint === APP)).toBe(true);
        expect(assetRequests.get('/connect-port/worker.js')).toBeGreaterThan(0);
        expect(await app.evaluate(() => navigator.serviceWorker.controller?.scriptURL || '')).not.toContain('/connect-port/worker.js');
        for (const document of allDocuments) expect(document.mailboxAttempts).toEqual([]);
        const audit = await nativeWorker.evaluate(() => globalThis.audit);
        expect(audit.length).toBeGreaterThan(0);
        expect(audit.some(item => item.key.includes('keewebx-connect-mailbox-v1:'))).toBe(false);
        const windowMessages = await windowTraffic();
        const serialized = JSON.stringify({ audit, traffic, windowMessages });
        for (const secret of PRIVATE_VALUES) expect(serialized).not.toContain(secret);
        await noHelpers();
        expect(signedReadyVerified).toBeGreaterThanOrEqual(10);
        report.transportAudit = { signedEnvelopes: packets.length, encryptedSensitiveEnvelopes: sensitive.length,
            signedReadyProofs: readyProofs.length, signedReadyVerified,
            nativeWorkerAttachments: attachments.length, mailboxFallbacks: 0, noPlaintext: true,
            logicalAppRequestsByAction: windowMessages.logicalRequests, physicalWindowPostsByAction: windowMessages.postAttempts };
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
    report.helperCloseFaults = [...documents.values()].map(document => ({ boot: document.boot, ...document.helperClose }));
    report.appNavigationRequests = appNavigationRequests;
    report.helpers = { opened: helpers.size, automaticallyClosed: [...helpers.values()].filter(helper => helper.automaticClosure).length,
        signedReadyVerified: [...helpers.values()].filter(helper => helper.signedReadyVerified).length,
        remaining: context ? context.pages().filter(page => helperURL(page.url())).length : 0, lifecycle: [...helpers.values()] };
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: join(OUT, 'report.json'), passed: report.passed }));
    await context?.close();
    for (const socket of sockets) socket.destroy();
    for (const server of [proxyServer, tlsServer]) if (server?.listening) await new Promise(resolve => server.close(resolve));
}
