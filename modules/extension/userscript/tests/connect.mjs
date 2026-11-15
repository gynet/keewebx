// Real-app browser smoke; GM storage is simulated and the bundle runs in the main world.
// Requires a built New UI server and local Bun/Playwright. No extension is loaded.
// node modules/extension/userscript/tests/connect.mjs
// Optional: KWX_APP_SERVER, KWX_BUN, KWX_CHROMIUM_EXECUTABLE, KWX_USERSCRIPT,
// KWX_REPO_ROOT, KWX_DB_ROOT, KWX_E2E_OUTPUT_DIR, KWX_E2E_REPORT, KWX_SCENARIO.
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(process.env.KWX_REPO_ROOT || fileURLToPath(new URL('../../../..', import.meta.url)));
const DB_ROOT = resolve(process.env.KWX_DB_ROOT || ROOT);
const BUN = process.env.KWX_BUN || (typeof Bun !== 'undefined' ? process.execPath : 'bun');
const APP_SERVER = process.env.KWX_APP_SERVER || 'http://127.0.0.1:8085';
const SOURCE = resolve(process.env.KWX_USERSCRIPT || join(ROOT, 'modules/extension/userscript/keewebx-connect.user.js'));
const OUT = process.env.KWX_E2E_OUTPUT_DIR ? resolve(process.env.KWX_E2E_OUTPUT_DIR) : mkdtempSync(join(tmpdir(), 'keewebx-connect-e2e-'));
mkdirSync(OUT, { recursive: true });
const DB_PASSWORD = 'Smoke-vault-disposable-2026';
const LOGIN_USER = 'native-smoke-user';
const LOGIN_PASSWORD = 'Disposable-native-login-2026!';
const RELAY_FIRST = { file: 'relay-first.kdbx', title: 'Other relay login', user: 'relay-other-user', password: 'Disposable-relay-other-2026!' };
const RELAY_CHOSEN = { file: 'relay-chosen.kdbx', title: 'Selected relay login', user: 'relay-selected-user', password: 'Disposable-relay-selected-2026!' };
const LOGIN_USERS = [LOGIN_USER, RELAY_FIRST.user, RELAY_CHOSEN.user];
const LOGIN_PASSWORDS = [LOGIN_PASSWORD, RELAY_FIRST.password, RELAY_CHOSEN.password];
const SITE = 'https://login.example.org/';
// A distinct HTTPS origin within the same site preserves Chromium's live opener route.
// Cross-site browsing-instance changes can drop delivery before the origin guard is exercised.
const SECOND_SITE = 'https://second-login.example.org/';
const APP = 'https://keewebx.app/app';
const report = { started: new Date().toISOString(), artifactDirectory: OUT, appServer: APP_SERVER,
    scope: 'Plain Chromium BrowserContext.addInitScript MAIN WORLD; shared simulated GM via exposeBinding; actual bundle and real app/protocol',
    gmMock: true, executionWorld: 'main', extensionLoaded: false,
    fullFlowVerified: false, siteInitiatedFirstOpenVerified: false, relatedNamedWindowReuseVerified: false,
    independentTabRelayVerified: false, relayNoPrematureFieldReadVerified: false,
    relayLateApprovalCannotStealVerified: false, relayLockedAppFailsClosedVerified: false,
    relayOriginBindingVerified: false, relayPendingConsentCancellationVerified: false,
    realManagerVerified: false, nativeIOSVerified: false, backgroundBehaviorVerified: false,
    steps: [], scenarios: [], errors: [], payloadLogCount: 0 };
let browser, context, app, site, relayHelper, relayOther, activeScenario, bundle;
const redact = value => LOGIN_PASSWORDS.reduce((text, secret) => text.replaceAll(secret, '[login password]'), String(value).replaceAll(DB_PASSWORD, '[vault password]'));
async function step(name, fn) {
    const prefix = activeScenario?.name || 'setup';
    console.log(JSON.stringify({ scenario: prefix, step: name, state: 'started' }));
    try {
        const detail = await fn() || {};
        const result = { scenario: prefix, name, state: 'passed', ...detail };
        report.steps.push(result);
        console.log(JSON.stringify(result));
        return detail;
    } catch (error) {
        if (activeScenario?.name === 'relay-origin-binding' && site && !site.isClosed()) {
            activeScenario.originProbe = await site.evaluate(() => {
                const probe = globalThis.__kwxConnectTest;
                return { hasHelperProxy: !!probe?.testHelper, barrierAcknowledged: probe?.barrierAcknowledged,
                    messages: probe?.originProbeMessages, requestIds: probe?.probeIds, replies: probe?.nativeReplies };
            }).catch(() => undefined);
        }
        report.steps.push({ scenario: prefix, name, state: 'failed', error: redact(error.message) });
        throw error;
    }
}

const cdpByPage = new WeakMap();
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
    await expect(page.locator('#keewebx-userscript-connect')).toBeAttached({ timeout: 10000 });
    const session = await cdp(page);
    const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = hostIn(root);
    if (!host?.shadowRoots?.[0]) throw new Error('Closed-shadow Userscripts widget missing');
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
async function shadowClick(page, selector, index = 0) {
    await page.bringToFront();
    const { session, nodeId } = await shadowNode(page, selector, index);
    if (!nodeId) throw new Error(`Closed-shadow control missing: ${selector}`);
    await session.send('DOM.scrollIntoViewIfNeeded', { nodeId });
    const { model } = await session.send('DOM.getBoxModel', { nodeId });
    const q = model.content;
    await page.mouse.click((q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4);
}
const action = (page, name) => shadowClick(page, `[data-action="${name}"]`);
const status = page => shadowValue(page, '[role="status"]');
async function untilStatus(page, expression, timeout = 15000) {
    await expect.poll(() => status(page), { timeout, message: `Widget status must match ${expression}` }).toMatch(expression);
    return status(page);
}
async function entries(page) { return (await shadowValue(page, '[data-role="entries"]')) || ''; }

async function scenario(name, run) {
    activeScenario = { name, appNavigationRequests: 0, passed: false };
    report.scenarios.push(activeScenario);
    const state = activeScenario;
    const gm = new Map();
    app = site = relayHelper = relayOther = undefined;
    context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await context.exposeBinding('__kwxSmokeGM', (_source, operation, key, value) => {
        if (operation === 'get') return structuredClone(gm.get(key));
        if (operation === 'set') { gm.set(key, structuredClone(value)); return; }
        throw new Error('Unsupported simulated GM operation');
    });
    await context.addInitScript({ content: `(() => {
        const start = () => {
            if (location.protocol !== 'https:' || window.top !== window) return;
            // Observe action names only. Never retain a decrypted response or credential.
            const observations = { documentBoot: crypto.randomUUID(), wireRequests: {}, nativeReplies: [], holdBroadcast: false, heldBroadcasts: [] };
            globalThis.__kwxConnectTest = observations;
            addEventListener('message', event => {
                if (event.source === window && event.origin === location.origin && event.data?.kwConnect === 'request') {
                    const action = event.data.action;
                    if (typeof action === 'string') observations.wireRequests[action] = (observations.wireRequests[action] || 0) + 1;
                }
                if (event.data?.marker === 'keewebx-userscript-connect-v1' && event.data.direction === 'response') {
                    observations.nativeReplies.push({ id: event.data.id, operation: event.data.operation, success: !event.data.error });
                }
            });
            if (${name === 'relay-late-approval'}) {
                // Queue real BroadcastChannel posts from the unselected app during a trusted pair click.
                // Releasing them later exercises stale approval delivery without inventing protocol replies.
                const nativePost = BroadcastChannel.prototype.postMessage;
                BroadcastChannel.prototype.postMessage = function (message) {
                    if (observations.holdBroadcast) observations.heldBroadcasts.push({ channel: this, message });
                    else nativePost.call(this, message);
                };
                observations.releaseBroadcasts = () => {
                    observations.holdBroadcast = false;
                    const held = observations.heldBroadcasts.splice(0);
                    for (const item of held) nativePost.call(item.channel, item.message);
                    return held.length;
                };
            }
            const GM = {
                getValue: key => globalThis.__kwxSmokeGM('get', key),
                setValue: (key, value) => globalThis.__kwxSmokeGM('set', key, value)
            };
            ${bundle}
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    })();` });
    context.on('page', page => {
        page.on('console', message => {
            if (/Request payload|Response payload/.test(message.text())) report.payloadLogCount++;
            if (message.type() === 'error') report.errors.push({ scenario: name, kind: 'console', url: page.url(), message: redact(message.text()).slice(0, 800) });
        });
        page.on('pageerror', error => report.errors.push({ scenario: name, kind: 'pageerror', url: page.url(), message: redact(error.message).slice(0, 800) }));
    });
    await context.route('https://keewebx.app/**', async route => {
        const url = new URL(route.request().url());
        if (route.request().isNavigationRequest()) state.appNavigationRequests++;
        let path = url.pathname.replace(/^\/app(?=\/|$)/, '') || '/next.html';
        if (path === '/') path = '/next.html';
        const response = await context.request.get(`${APP_SERVER}${path}${url.search}`);
        await route.fulfill({ response });
    });
    const loginFixture = route => route.fulfill({
        contentType: 'text/html', body: `<!doctype html><title>Disposable native login</title>
        <style>body{font:18px system-ui;padding:80px}input{display:block;width:300px;height:40px;margin:12px}</style>
        <h1>Disposable login</h1><form><input id="username" autocomplete="username"><input id="login-password" type="password" autocomplete="current-password"><button>Sign in</button></form>
        <script>window.formSubmits=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.formSubmits++});</script>`
    });
    await context.route('https://login.example.org/**', loginFixture);
    await context.route('https://second-login.example.org/**', loginFixture);
    try {
        await run();
        state.passed = true;
    } catch (error) {
        for (const [label, page] of [['app', app], ['site', site], ['helper', relayHelper], ['other-app', relayOther]]) if (page && !page.isClosed()) {
            try {
                state[`${label}Status`] = await status(page);
                state[`${label}VisibleText`] = redact((await page.locator('body').innerText()).slice(0, 6000));
                await page.screenshot({ path: join(OUT, `${name}-${label}-blocker.png`) });
            } catch {}
        }
        throw error;
    } finally {
        const serialized = JSON.stringify(Object.fromEntries(gm));
        state.storageAudit = {
            backend: 'simulated shared GM via exposeBinding; not chrome.storage.local',
            keys: [...gm.keys()], onlySettingsAndIdentity: [...gm.keys()].every(key => /^keewebx-userscript-connect-(identity|settings)-v1$/.test(key)),
            noVaultPassword: !serialized.includes(DB_PASSWORD), noLoginPassword: LOGIN_PASSWORDS.every(secret => !serialized.includes(secret)), noLoginUsername: LOGIN_USERS.every(user => !serialized.includes(user))
        };
        await context.close();
        context = undefined;
    }
}

async function ready(page) {
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#keewebx-userscript-connect')).toBeAttached({ timeout: 15000 });
}
async function panel(page, tab) {
    if (await shadowValue(page, 'section', 'hidden')) await action(page, 'toggle');
    await action(page, tab === 'config' ? 'config-tab' : 'accounts-tab');
}
async function unlock(page = app, fixture = 'native-smoke.kdbx') {
    await expect(page.locator('#open-file-input, #kdbx-file-input').first()).toBeAttached({ timeout: 20000 });
    await page.locator('#open-file-input, #kdbx-file-input').first().setInputFiles(join(OUT, fixture));
    const fallback = page.getByRole('button', { name: 'Use password', exact: true });
    if (await fallback.isVisible()) await fallback.click();
    await page.locator('#password').fill(DB_PASSWORD);
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout: 20000 });
    return { entriesVisible: await page.locator('.entry-row').count() };
}
async function authorize() {
    await panel(app, 'config');
    expect(await shadowValue(app, '[data-action="authorize"]')).toBe('Authorize Connect');
    await action(app, 'authorize');
    return allowConsent();
}
async function allowConsent() {
    const dialog = app.getByRole('dialog', { name: 'Allow browser extension access', exact: true });
    await expect(dialog).toBeVisible({ timeout: 12000 });
    const listing = dialog.getByRole('checkbox', { name: 'Allow listing and searching entries', exact: true });
    if (await listing.count()) await listing.check();
    await dialog.getByRole('button', { name: 'Allow', exact: true }).click();
    return { widgetStatus: await untilStatus(app, /Authorized/, 15000) };
}
async function lookup() {
    await site.locator('#username').click();
    if (await shadowValue(site, 'section', 'hidden')) await action(site, 'toggle');
    else { await action(site, 'accounts-tab'); await action(site, 'lookup'); }
    await expect.poll(() => entries(site), { timeout: 18000 }).toContain('Native login');
    expect(await entries(site)).not.toContain('Wrong origin entry');
    expect(await status(site)).toMatch(/Found 1 matching account/);
    await expect(site.locator('#username')).toHaveValue('');
    await expect(site.locator('#login-password')).toHaveValue('');
    return { widgetStatus: await status(site), noFillBeforeSelection: true, wrongOriginEntryExcluded: true };
}
async function fill() {
    await action(site, 'entry-0');
    await expect(site.locator('#username')).toHaveValue(LOGIN_USER, { timeout: 12000 });
    await expect(site.locator('#login-password')).toHaveValue(LOGIN_PASSWORD);
    expect(await site.evaluate(() => window.formSubmits)).toBe(0);
    return { usernameMatches: true, passwordMatches: true, formSubmits: 0, widgetStatus: await status(site) };
}
async function probe() {
    if (await shadowValue(site, 'section', 'hidden')) await action(site, 'toggle');
    await expect.poll(() => shadowValue(site, '[data-action="lookup"]', 'disabled'), { timeout: 15000 }).toBe(false);
    await action(site, 'config-tab'); await action(site, 'probe');
    const text = await untilStatus(site, /Native postMessage/i, 12000);
    const boot = text.match(/; page ([a-f0-9-]+)\./i)?.[1];
    expect(boot).toBeTruthy();
    return { widgetStatus: text, appBoot: boot };
}

const fieldReads = page => page.evaluate(() => globalThis.__kwxConnectTest.wireRequests['kwx-get-entry-fields'] || 0);
const documentState = page => page.evaluate(() => ({
    href: location.href, timeOrigin: performance.timeOrigin, boot: globalThis.__kwxConnectTest.documentBoot
}));

async function expectPairCard(page) {
    await expect.poll(() => shadowValue(page, '.pairing-card', 'hidden'), { timeout: 12000 }).toBe(false);
    expect(await shadowValue(page, '#kwx-pairing-origin')).toBe(new URL(SITE).origin);
    expect(await shadowValue(page, '[data-action="pair"]')).toBe('Connect this tab');
    expect(await shadowValue(page, '[data-action="decline"]')).toBe('Decline');
}

async function relaySetup() {
    await step('open and unlock two independent original app tabs with distinct KDBX entries', async () => {
        relayOther = await context.newPage(); await relayOther.goto(APP); await ready(relayOther);
        await unlock(relayOther, RELAY_FIRST.file);
        app = await context.newPage(); await app.goto(APP); await ready(app);
        await unlock(app, RELAY_CHOSEN.file);
        expect(await relayOther.evaluate(() => window.opener === null)).toBe(true);
        expect(await app.evaluate(() => window.opener === null)).toBe(true);
        expect(await fieldReads(relayOther)).toBe(0); expect(await fieldReads(app)).toBe(0);
        return { independentOriginals: 2, distinctMatchingEntries: true, bothUnlocked: true };
    });
    const originals = {
        chosen: await documentState(app), other: await documentState(relayOther),
        navigationCount: activeScenario.appNavigationRequests
    };
    await step('missing site link opens lightweight same-origin helper and discovers original apps', async () => {
        site = await context.newPage(); await site.goto(SITE); await ready(site);
        expect(await site.evaluate(() => window.opener === null)).toBe(true);
        await site.locator('#username').click();
        const popup = site.waitForEvent('popup'); await action(site, 'toggle'); relayHelper = await popup;
        await relayHelper.waitForURL(url => url.origin === new URL(APP).origin && url.pathname === '/connect.html' && url.searchParams.get('kwx-connect-relay') === '1');
        await ready(relayHelper);
        await expectPairCard(app); await expectPairCard(relayOther);
        expect(context.pages()).toHaveLength(4);
        expect(await documentState(app)).toEqual(originals.chosen);
        expect(await documentState(relayOther)).toEqual(originals.other);
        await expect(relayHelper.locator('.vault, #open-file-input, #kdbx-file-input')).toHaveCount(0);
        return { helperUrl: relayHelper.url(), exactSiteOriginOnBothCards: true, originalDocumentsUnchanged: true, lightweightHelper: true };
    });
    return originals;
}

async function relayLookup() {
    await site.locator('#username').click();
    if (await shadowValue(site, 'section', 'hidden')) await action(site, 'toggle');
    else { await action(site, 'accounts-tab'); await action(site, 'lookup'); }
    await expect.poll(() => entries(site), { timeout: 18000 }).toContain(RELAY_CHOSEN.title);
    expect(await entries(site)).not.toContain(RELAY_FIRST.title);
    expect(await entries(site)).not.toContain(RELAY_FIRST.user);
    expect(await status(site)).toMatch(/Found 1 matching account/);
    await expect(site.locator('#username')).toHaveValue(''); await expect(site.locator('#login-password')).toHaveValue('');
    return { onlyChosenAppEntryListed: true, noFillBeforeChoice: true };
}

async function relayFill() {
    await action(site, 'entry-0');
    await expect(site.locator('#username')).toHaveValue(RELAY_CHOSEN.user, { timeout: 12000 });
    await expect(site.locator('#login-password')).toHaveValue(RELAY_CHOSEN.password);
    expect(await site.evaluate(() => window.formSubmits)).toBe(0);
    expect(await fieldReads(relayOther)).toBe(0);
    return { chosenUsernameMatches: true, chosenPasswordMatches: true, otherAppFieldsNeverRead: true, formSubmits: 0 };
}

async function assertOriginalsPreserved(originals) {
    expect(await documentState(app)).toEqual(originals.chosen);
    expect(await documentState(relayOther)).toEqual(originals.other);
    await expect(app.locator('.entry-row').first()).toBeVisible();
    await expect(relayOther.locator('.entry-row').first()).toBeVisible();
    expect(activeScenario.appNavigationRequests).toBe(originals.navigationCount + 1);
    expect(new URL(relayHelper.url()).pathname).toBe('/connect.html');
    return { originalDocumentsAndUnlockPreserved: true, helperRemainsProxy: true };
}

async function relayAcceptance() {
    const originals = await relaySetup();
    await step('user connects only the chosen original app tab', async () => {
        await action(app, 'pair');
        return { chosenOnly: true };
    });
    await step('chosen original app reuses actual Connect authorization and native Allow', allowConsent);
    await step('encrypted relay lists only the chosen app without field reads', async () => {
        const result = await relayLookup();
        expect(await fieldReads(app)).toBe(0); expect(await fieldReads(relayOther)).toBe(0);
        report.relayNoPrematureFieldReadVerified = true;
        return { ...result, fieldReadRequestsBeforeExplicitChoice: 0 };
    });
    await step('explicit relay account choice fills only chosen credentials without submit', relayFill);
    await step('relay leaves both original app documents unlocked and unchanged', () => assertOriginalsPreserved(originals));
    report.independentTabRelayVerified = true;
    await step('locking the selected original fails closed and never falls back to another app', async () => {
        await site.locator('#username').fill(''); await site.locator('#login-password').fill('');
        await relayLookup();
        const chosenReadsBeforeLock = await fieldReads(app);
        await app.bringToFront();
        await app.getByRole('button', { name: 'Lock', exact: true }).click();
        await expect(app.locator('#password')).toBeVisible({ timeout: 15000 });
        await site.bringToFront();
        if (await shadowValue(site, '[data-action="entry-0"]')) await action(site, 'entry-0');
        await untilStatus(site, /lock|unlock|suspended|changed|find accounts again/i, 12000);
        await expect(site.locator('#username')).toHaveValue(''); await expect(site.locator('#login-password')).toHaveValue('');
        expect(await site.evaluate(() => window.formSubmits)).toBe(0);
        expect(await fieldReads(relayOther)).toBe(0);
        await expect(relayOther.locator('.entry-row').first()).toBeVisible();
        expect(await documentState(app)).toEqual(originals.chosen); expect(await documentState(relayOther)).toEqual(originals.other);
        report.relayLockedAppFailsClosedVerified = true;
        return { noFillAfterLock: true, otherAppNotUsed: true, chosenReadsBeforeLock, originalDocumentsUnchanged: true };
    });
}

async function lateRelayApproval() {
    const originals = await relaySetup();
    await step('hold a real approval from the other app until after the chosen app is connected', async () => {
        await relayOther.evaluate(() => { globalThis.__kwxConnectTest.holdBroadcast = true; });
        await action(relayOther, 'pair');
        await expect.poll(() => relayOther.evaluate(() => globalThis.__kwxConnectTest.heldBroadcasts.length)).toBeGreaterThan(0);
        await action(app, 'pair');
        return { realTrustedApprovalQueued: true, deliveryDelayedOnlyInTest: true };
    });
    await step('authorize and list the chosen app before delayed approval delivery', async () => {
        await allowConsent(); await relayLookup();
        expect(await fieldReads(app)).toBe(0); expect(await fieldReads(relayOther)).toBe(0);
        return { chosenOnly: true, noFieldReadsBeforeChoice: true };
    });
    await step('late approval cannot steal the chosen relay session', async () => {
        const released = await relayOther.evaluate(() => globalThis.__kwxConnectTest.releaseBroadcasts());
        expect(released).toBeGreaterThan(0);
        await site.bringToFront();
        // A real probe waits for a round trip after the late frames, then the same chosen app must list and fill.
        await probe();
        await relayLookup();
        expect(await fieldReads(app)).toBe(0); expect(await fieldReads(relayOther)).toBe(0);
        await relayFill();
        await assertOriginalsPreserved(originals);
        report.relayLateApprovalCannotStealVerified = true;
        return { delayedApprovalsReleased: released, selectedAppUnchanged: true, otherAppFieldsNeverRead: true };
    });
}

async function relayOriginBinding() {
    const originals = await relaySetup();
    await step('authorize the first website and establish a valid encrypted relay list', async () => {
        await action(app, 'pair'); await allowConsent(); await relayLookup();
        expect(await fieldReads(app)).toBe(0); expect(await fieldReads(relayOther)).toBe(0);
        return { originalOrigin: new URL(SITE).origin, approvedRelayWorks: true, noFieldsRead: true };
    });
    await step('same website WindowProxy at a second origin cannot cancel or bootstrap the old approval', async () => {
        const helperBefore = await documentState(relayHelper);
        // A test-only FIFO barrier acknowledges delivery after both real native RPC attempts.
        // It does not intercept, answer, or alter any production protocol message.
        await relayHelper.evaluate(secondOrigin => {
            addEventListener('message', event => {
                if (event.isTrusted && event.source === window.opener && event.origin === secondOrigin && event.data?.marker === 'kwx-e2e-rpc-barrier') {
                    event.source.postMessage({ marker: 'kwx-e2e-rpc-barrier-ack', nonce: event.data.nonce, sameWindowProxy: true }, event.origin);
                }
            });
        }, new URL(SECOND_SITE).origin);
        await site.goto(SECOND_SITE); await ready(site);
        await site.evaluate(appOrigin => {
            const observations = globalThis.__kwxConnectTest;
            observations.originProbeMessages = [];
            addEventListener('message', event => {
                if (String(event.data?.marker).startsWith('kwx-e2e-')) observations.originProbeMessages.push({ marker: event.data.marker, origin: event.origin, trusted: event.isTrusted });
                if (event.isTrusted && event.origin === appOrigin && event.data?.marker === 'kwx-e2e-helper-reference') observations.testHelper = event.source;
            });
            const button = document.createElement('button'); button.id = 'try-previous-helper'; button.textContent = 'Try previous Connect link';
            button.onclick = event => {
                if (!event.isTrusted) return;
                const helper = observations.testHelper;
                if (!helper) throw new Error('The existing related helper was not found');
                const nonce = crypto.randomUUID();
                observations.probeIds = [];
                addEventListener('message', event => {
                    if (event.isTrusted && event.source === helper && event.origin === appOrigin && event.data?.marker === 'kwx-e2e-rpc-barrier-ack' && event.data.nonce === nonce) {
                        observations.barrierAcknowledged = event.data.sameWindowProxy === true;
                    }
                });
                const document = crypto.randomUUID();
                for (const operation of ['cancel', 'hello']) {
                    const id = crypto.randomUUID(), sentAt = Date.now(); observations.probeIds.push(id);
                    helper.postMessage({ marker: 'keewebx-userscript-connect-v1', direction: 'request', operation,
                        id, document, sentAt, deadline: sentAt + 5000 }, appOrigin);
                }
                helper.postMessage({ marker: 'kwx-e2e-rpc-barrier', nonce }, appOrigin);
            };
            document.body.append(button);
        }, new URL(APP).origin);
        // Reacquire the actual old helper proxy from a native MessageEvent.source. Named-window
        // lookup after a cross-origin navigation may instead create an unrelated blank window.
        activeScenario.helperReference = await relayHelper.evaluate(origin => {
            const opener = window.opener;
            opener?.postMessage({ marker: 'kwx-e2e-helper-reference' }, origin);
            return { hasOpener: !!opener, openerClosed: opener?.closed, targetOrigin: origin, helperOrigin: location.origin };
        }, new URL(SECOND_SITE).origin);
        await expect.poll(() => site.evaluate(() => !!globalThis.__kwxConnectTest.testHelper), { message: 'Receive actual helper WindowProxy after cross-origin navigation' }).toBe(true);
        await site.locator('#try-previous-helper').click();
        await expect.poll(() => site.evaluate(() => !!globalThis.__kwxConnectTest.barrierAcknowledged), { message: 'Receive FIFO barrier from the actual helper' }).toBe(true);
        const replies = await site.evaluate(() => {
            const observations = globalThis.__kwxConnectTest;
            return observations.nativeReplies.filter(reply => observations.probeIds.includes(reply.id));
        });
        expect(replies.filter(reply => reply.success)).toEqual([]);
        expect(await fieldReads(app)).toBe(0); expect(await fieldReads(relayOther)).toBe(0);
        expect(await shadowValue(site, '[data-action="entry-0"]')).toBeNull();
        await expect(site.locator('#username')).toHaveValue(''); await expect(site.locator('#login-password')).toHaveValue('');
        expect(await site.evaluate(() => window.formSubmits)).toBe(0);
        expect(context.pages()).toHaveLength(4); expect(await documentState(relayHelper)).toEqual(helperBefore);
        await assertOriginalsPreserved(originals);
        report.relayOriginBindingVerified = true;
        return { sameWindowProxy: true, secondOrigin: new URL(SECOND_SITE).origin, cancelRejected: true, helloRejected: true, fieldReads: 0, noFill: true };
    });
}

const consentDialog = () => app.getByRole('dialog', { name: 'Allow browser extension access', exact: true });
async function staleAllowDoesNotGrant(handle) {
    const detached = await handle.evaluate(button => { const detached = !button.isConnected; button.click(); return detached; });
    expect(detached).toBe(true);
    await handle.dispose();
    expect(await fieldReads(app)).toBe(0); expect(await fieldReads(relayOther)).toBe(0);
}

async function relayConsentCancellation() {
    await relaySetup();
    await step('open real native Allow prompt for the selected app without approving it', async () => {
        await action(app, 'pair'); await expect(consentDialog()).toBeVisible({ timeout: 12000 });
        return { nativeConsentPending: true, fieldsRead: await fieldReads(app) };
    });
    await step('restarting helper dismisses native consent and invalidates a late Allow', async () => {
        const allow = await consentDialog().getByRole('button', { name: 'Allow', exact: true }).elementHandle();
        expect(allow).toBeTruthy();
        await action(relayHelper, 'revoke');
        await expect(consentDialog()).toHaveCount(0, { timeout: 12000 });
        await staleAllowDoesNotGrant(allow);
        await expectPairCard(app);
        await expect.poll(() => shadowValue(app, '[data-action="pair"]', 'disabled')).toBe(false);
        await action(app, 'pair'); await expect(consentDialog()).toBeVisible({ timeout: 12000 });
        return { oldPromptDismissed: true, staleAllowAttempted: true, freshConsentRequired: true };
    });
    await step('closing helper also dismisses native consent without persisting a late Allow', async () => {
        const allow = await consentDialog().getByRole('button', { name: 'Allow', exact: true }).elementHandle();
        expect(allow).toBeTruthy();
        await relayHelper.close();
        await expect(consentDialog()).toHaveCount(0, { timeout: 12000 });
        await staleAllowDoesNotGrant(allow);
        await site.locator('#username').click();
        if (!(await shadowValue(site, 'section', 'hidden'))) await action(site, 'close');
        const popup = site.waitForEvent('popup'); await action(site, 'toggle'); relayHelper = await popup; await ready(relayHelper);
        await expectPairCard(app);
        await expect.poll(() => shadowValue(app, '[data-action="pair"]', 'disabled')).toBe(false);
        await action(app, 'pair'); await expect(consentDialog()).toBeVisible({ timeout: 12000 });
        return { oldPromptDismissed: true, staleAllowAttempted: true, freshConsentRequired: true };
    });
    await step('only fresh explicit native Allow enables relay lookup and selected fill', async () => {
        await allowConsent(); await relayLookup();
        expect(await fieldReads(app)).toBe(0); expect(await fieldReads(relayOther)).toBe(0);
        await relayFill(); report.relayPendingConsentCancellationVerified = true;
        return { freshExplicitConsentWorks: true, noPrematureFieldReads: true, formSubmits: 0 };
    });
}

try {
    bundle = readFileSync(SOURCE, 'utf8');
    report.bundle = { source: SOURCE, bytes: Buffer.byteLength(bundle), sha256: createHash('sha256').update(bundle).digest('hex') };
    writeFileSync(join(OUT, 'bundle.user.js'), bundle);
    await step('create real encrypted KDBX fixture', async () => {
        const fixturePath = join(OUT, 'native-smoke.kdbx');
        const source = `
            import * as kdbx from ${JSON.stringify(pathToFileURL(join(DB_ROOT, 'modules/db/lib/index.ts')).href)};
            import { argon2 } from ${JSON.stringify(pathToFileURL(join(DB_ROOT, 'modules/db/test/test-support/argon2.ts')).href)};
            import { writeFileSync } from 'node:fs';
            kdbx.CryptoEngine.setArgon2Impl(argon2);
            const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(${JSON.stringify(DB_PASSWORD)})), 'Native smoke');
            db.header.kdfParameters.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
            db.header.kdfParameters.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
            for (const [title, url, user] of [['Native login', ${JSON.stringify(SITE)}, ${JSON.stringify(LOGIN_USER)}], ['Wrong origin entry', 'https://wrong.example.net/', 'wrong-user']]) {
                const entry = db.createEntry(db.getDefaultGroup());
                entry.fields.set('Title', title); entry.fields.set('URL', url); entry.fields.set('UserName', user);
                entry.fields.set('Password', kdbx.ProtectedValue.fromString(${JSON.stringify(LOGIN_PASSWORD)}));
            }
            writeFileSync(${JSON.stringify(fixturePath)}, new Uint8Array(await db.save()));
            for (const fixture of ${JSON.stringify([RELAY_FIRST, RELAY_CHOSEN])}) {
                const relayDb = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(${JSON.stringify(DB_PASSWORD)})), fixture.title);
                relayDb.header.kdfParameters.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
                relayDb.header.kdfParameters.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
                const entry = relayDb.createEntry(relayDb.getDefaultGroup());
                entry.fields.set('Title', fixture.title); entry.fields.set('URL', ${JSON.stringify(SITE)});
                entry.fields.set('UserName', fixture.user); entry.fields.set('Password', kdbx.ProtectedValue.fromString(fixture.password));
                writeFileSync(${JSON.stringify(OUT)} + '/' + fixture.file, new Uint8Array(await relayDb.save()));
            }
        `;
        execFileSync(BUN, ['--eval', source], { cwd: ROOT, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
        return { fixture: fixturePath, entryCount: 2, independentRelayFixtures: 2 };
    });
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
        ...(process.env.KWX_CHROMIUM_EXECUTABLE ? { executablePath: process.env.KWX_CHROMIUM_EXECUTABLE } : {}) });
    const choice = process.env.KWX_SCENARIO || 'all';
    if (!['all', 'app-first', 'site-first', 'relay', 'relay-late-approval', 'regressions', 'relay-origin-binding', 'relay-consent-cancel'].includes(choice)) throw new Error('Unknown KWX_SCENARIO');
    if (choice === 'all' || choice === 'app-first') await scenario('app-first', async () => {
        await step('launch public New UI with closed-shadow widget', async () => {
            app = await context.newPage(); await app.goto(`${APP}?kwx-connect=1`); await ready(app);
            expect(await app.evaluate(() => document.querySelector('#keewebx-userscript-connect').shadowRoot)).toBeNull();
            return { widgetStatus: await status(app), closedShadow: true };
        });
        await step('load and unlock real KDBX through New UI', unlock);
        await step('authorize through real native app consent', authorize);
        await step('open associated login popup from app widget', async () => {
            await shadowClick(app, 'input', 1); await app.keyboard.press('Control+A'); await app.keyboard.insertText(SITE);
            const popup = app.waitForEvent('popup'); await action(app, 'open'); site = await popup; await ready(site);
            expect(await site.evaluate(() => !!window.opener)).toBe(true);
            return { url: site.url(), hasRealOpener: true };
        });
        await step('lookup excludes wrong origin and does not fill before selection', lookup);
        await step('explicit account click fills without submission', fill);
        await step('native postMessage probe', probe);
        await step('navigation invalidates a listed account without filling', async () => {
            await site.locator('#username').fill(''); await site.locator('#login-password').fill('');
            await lookup();
            await site.evaluate(() => { location.hash = 'changed-document-state'; });
            await untilStatus(site, /page (?:has )?changed/i, 5000);
            expect(await shadowValue(site, '[data-action="entry-0"]')).toBeNull();
            await expect(site.locator('#username')).toHaveValue(''); await expect(site.locator('#login-password')).toHaveValue('');
            return { listCleared: true, noFillAfterNavigation: true };
        });
    });
    if (choice === 'all' || choice === 'site-first') await scenario('site-first', async () => {
        await step('site widget opens missing app in a related named popup', async () => {
            site = await context.newPage(); await site.goto(SITE); await ready(site);
            expect(context.pages()).toHaveLength(1);
            expect(await site.evaluate(() => window.opener === null)).toBe(true);
            await site.locator('#username').click();
            const popup = site.waitForEvent('popup'); await action(site, 'toggle'); app = await popup;
            // With no independent app discovered, the lightweight helper keeps its window and navigates to the app.
            await app.waitForURL(`${APP}?kwx-connect=1`, { timeout: 15000 }); await ready(app);
            expect(app.url()).toBe(`${APP}?kwx-connect=1`);
            expect(await app.evaluate(() => window.name)).toBe('KeeWebXUserscriptConnect');
            expect(await app.evaluate(() => !!window.opener)).toBe(true);
            return { appUrl: app.url(), openedByActualWidget: true, hasRealOpener: true };
        });
        await step('unlock site-opened KDBX through real UI', unlock);
        await step('authorize site-opened app through real native consent', authorize);
        await step('return to original site using the actual widget', async () => {
            await action(app, 'return'); await site.bringToFront();
            expect(context.pages()).toHaveLength(2);
            return { relatedSitePreserved: true };
        });
        await step('site-first encrypted lookup', lookup);
        await step('site-first explicit fill without submission', fill);
        report.siteInitiatedFirstOpenVerified = true;
        const firstProbe = await step('capture app boot before named-window reuse', probe);
        const before = await app.evaluate(() => ({ timeOrigin: performance.timeOrigin, href: location.href, name: window.name }));
        const navigationCount = activeScenario.appNavigationRequests;
        await step('fresh site document rediscovers named app without reload or unlock', async () => {
            await site.reload(); await ready(site);
            expect(await site.evaluate(() => window.opener === null)).toBe(true);
            await site.locator('#username').click(); await action(site, 'toggle');
            await untilStatus(site, /KeeWebX opened/, 8000);
            expect(context.pages()).toHaveLength(2);
            expect(context.pages().find(page => page.url().startsWith(APP))).toBe(app);
            expect(activeScenario.appNavigationRequests).toBe(navigationCount);
            expect(await app.evaluate(() => ({ timeOrigin: performance.timeOrigin, href: location.href, name: window.name }))).toEqual(before);
            await expect(app.locator('.entry-row').first()).toBeVisible();
            return { sameAppPage: true, sameTimeOrigin: true, unchangedAppNavigationCount: navigationCount, vaultStillUnlocked: true };
        });
        await step('reused app permits encrypted lookup without another authorization', async () => {
            const result = await lookup();
            await expect(app.getByRole('dialog', { name: 'Allow browser extension access', exact: true })).toHaveCount(0);
            return { ...result, noAdditionalAuthorization: true };
        });
        await step('reused unlocked app fills the fresh site without submission', fill);
        await step('named-window reuse preserves actual broker boot', async () => {
            const nextProbe = await probe();
            expect(nextProbe.appBoot).toBe(firstProbe.appBoot);
            expect(activeScenario.appNavigationRequests).toBe(navigationCount);
            expect(await app.evaluate(() => performance.timeOrigin)).toBe(before.timeOrigin);
            report.relatedNamedWindowReuseVerified = true;
            return { ...nextProbe, sameAppBoot: true, noAppReload: true };
        });
    });
    if (choice === 'all' || choice === 'relay') await scenario('independent-relay', relayAcceptance);
    if (choice === 'all' || choice === 'relay-late-approval') await scenario('relay-late-approval', lateRelayApproval);
    if (['all', 'regressions', 'relay-origin-binding'].includes(choice)) await scenario('relay-origin-binding', relayOriginBinding);
    if (['all', 'regressions', 'relay-consent-cancel'].includes(choice)) await scenario('relay-consent-cancel', relayConsentCancellation);
    report.fullFlowVerified = report.scenarios.length > 0 && report.scenarios.every(item => item.passed);
    report.ok = report.fullFlowVerified;
} catch (error) {
    report.ok = false; report.blocker = redact(error.message);
    report.blockerStack = redact(error.stack);
} finally {
    if (context) await context.close();
    if (browser) await browser.close();
    if (report.payloadLogCount || report.errors.length || report.scenarios.some(item => !item.storageAudit?.onlySettingsAndIdentity || !item.storageAudit.noVaultPassword || !item.storageAudit.noLoginPassword || !item.storageAudit.noLoginUsername)) report.ok = false;
    report.finished = new Date().toISOString();
    const reportPath = process.env.KWX_E2E_REPORT ? resolve(process.env.KWX_E2E_REPORT) : join(OUT, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, blocker: report.blocker, bundle: report.bundle,
        fullFlowVerified: report.fullFlowVerified, siteInitiatedFirstOpenVerified: report.siteInitiatedFirstOpenVerified,
        relatedNamedWindowReuseVerified: report.relatedNamedWindowReuseVerified,
        independentTabRelayVerified: report.independentTabRelayVerified,
        relayNoPrematureFieldReadVerified: report.relayNoPrematureFieldReadVerified,
        relayLateApprovalCannotStealVerified: report.relayLateApprovalCannotStealVerified,
        relayLockedAppFailsClosedVerified: report.relayLockedAppFailsClosedVerified,
        relayOriginBindingVerified: report.relayOriginBindingVerified,
        relayPendingConsentCancellationVerified: report.relayPendingConsentCancellationVerified,
        errors: report.errors, payloadLogCount: report.payloadLogCount, report: reportPath }, null, 2));
    process.exitCode = report.ok ? 0 : 1;
}
