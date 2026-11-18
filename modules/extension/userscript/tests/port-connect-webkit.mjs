// Focused production smoke: real App/KDBX/consent, with only GM adapted in a WebKit user world.
// With the current installer and dist assets available, run: node modules/extension/userscript/tests/port-connect-webkit.mjs
// KWX_BUN selects Bun; KWX_WEBKIT_OUTPUT selects the disposable artifact directory.
// KWX_WEBKIT_INSTALLER selects an existing installer for a negative control without changing production assets.
// KWX_BLOCK_HELPER_CLOSE=1 blocks only userscript-held helper.close() calls.
// KWX_LEGACY_WORKER=/tmp/worker-0.6.3.js exercises the first-connection worker upgrade.
// KWX_WEBKIT_APP_REOPEN=1 runs only real App and website close/reopen acceptance.
// KWX_WEBKIT_FRESH_OPERATIONS=1 focuses repeated probes, App visit/return, website reopen, and explicit reconnect.
// KWX_WEBKIT_DELAY_DISCOVERY_MS=24000 also delays App delivery and mailbox scans in that focused run.
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
const INSTALLER_PATH = resolve(process.env.KWX_WEBKIT_INSTALLER || join(ROOT, 'modules/extension/userscript/keewebx-connect.user.js'));
const SOURCE_VERSION = readFileSync(join(ROOT, 'modules/extension/userscript/src/version.ts'), 'utf8').match(/CONNECT_VERSION\s*=\s*'([^']+)'/)[1];
const VERSION = process.env.KWX_WEBKIT_INSTALLER
    ? readFileSync(INSTALLER_PATH, 'utf8').match(/^\/\/ @version\s+(\S+)\s*$/m)?.[1] : SOURCE_VERSION;
const OUT = resolve(process.env.KWX_WEBKIT_OUTPUT || mkdtempSync(join(tmpdir(), 'keewebx-port-webkit-')));
const PASSWORD = 'Disposable-port-vault-2026!';
const BLOCK_HELPER_CLOSE = process.env.KWX_BLOCK_HELPER_CLOSE === '1';
const FOCUS_APP_REOPEN = process.env.KWX_WEBKIT_APP_REOPEN === '1';
const FOCUS_FRESH_OPERATIONS = process.env.KWX_WEBKIT_FRESH_OPERATIONS === '1';
if (FOCUS_APP_REOPEN && FOCUS_FRESH_OPERATIONS) throw new Error('Select only one WebKit focus');
const DISCOVERY_DELAY_MS = Number(process.env.KWX_WEBKIT_DELAY_DISCOVERY_MS || 0);
if (DISCOVERY_DELAY_MS && (!FOCUS_APP_REOPEN || !Number.isFinite(DISCOVERY_DELAY_MS)
    || DISCOVERY_DELAY_MS < 17000 || DISCOVERY_DELAY_MS > 30000))
    throw new Error('Delayed discovery requires the App reopen focus and a delay between 17000 and 30000 ms');
// Optional upgrade run uses an unmodified historical worker supplied outside the repo.
const LEGACY_WORKER = process.env.KWX_LEGACY_WORKER ? readFileSync(process.env.KWX_LEGACY_WORKER, 'utf8') : null;
const OPERATION_BUDGET = 30000;
const SELECTION_STATUSES = ['Checking account access', 'Reading account details', 'Checking access before filling'];
const PREFERENCES_KEY = 'keewebx-userscript-connect-preferences-v1';
const AUTO_FILL_LABEL = 'Fill a single matching account automatically';
const CHOICE_ORIGIN = 'https://choice.example.test';
const ACCOUNTS = [
    { title: 'First fixture account', url: 'https://login.example.org/', user: 'first-fixture-user', password: 'Disposable-first-password!' },
    { title: 'Second fixture account', url: 'https://signin.example.net/', user: 'second-fixture-user', password: 'Disposable-second-password!' },
    { title: 'Unrelated fixture account', url: 'https://wrong.example.com/', user: 'unrelated-fixture-user', password: 'Disposable-unrelated-password!' }
];
const PORT_MARK = 'keewebx-connect-port-v1';
// Extra entries belong only to the late preference cases, never the stress origins.
const CHOICE_ACCOUNTS = [
    { title: 'Choice fixture one', url: CHOICE_ORIGIN + '/', user: 'choice-one-user', password: 'Disposable-choice-one-password!' },
    { title: 'Choice fixture two', url: CHOICE_ORIGIN + '/', user: 'choice-two-user', password: 'Disposable-choice-two-password!' }
];
const VAULT_ACCOUNTS = [...ACCOUNTS, ...CHOICE_ACCOUNTS];
const WEBSITE_ORIGINS = [...ACCOUNTS.slice(0, 2), CHOICE_ACCOUNTS[0]].map(account => new URL(account.url).origin);
const CASES = [
    'authorize original App once with encrypted KDBX and native consent',
    'helper stays open until signed App ready, then opener self-closes it while hello is held and a cached retry survives reply loss',
    'each trusted lookup and Test connection opens one fresh physical port to the same App',
    'an open settings panel overlapping login fields can start lookup through its visible controls',
    'after three successful fills, inner and outer reply loss recovers with one logical request per operation',
    'lost first list and detail requests resend the same signed packet with one logical App request',
    '24 alternating lookup and fill cycles recover periodic losses and UI cancellation on fresh operation ports',
    'toggle key closes and cancels pending lookup before late encrypted replies',
    'toggle key closes and cancels pending fill before late encrypted replies',
    'site A reload rebuilds transport to the original App',
    'trusted opener self-closes the helper after signed App readiness while remote close is blocked',
    'unfocused key tests connection without account reads; later lookup opens a fresh port and cancellation survives form changes',
    'native opt-in persists across reload and fills a single match; opt-out restores manual selection',
    'opt-in keeps multiple matches as a choice and narrow panels fit normal and keyboard viewports',
    'after both websites close a fresh site finds the original App despite dropped discovery-port replies'
];
const secrets = [PASSWORD, ...VAULT_ACCOUNTS.flatMap(item => [item.title, item.user, item.password])];
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[fixture value]'), String(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const report = { browser: 'webkit', headless: true, nativeIOSVerified: false, realUserscriptsManagerVerified: false,
    isolatedWorld: 'WebKit utility world', gmFixture: 'DOM events/main-world binding/Node Map', helperCrossCloseBlocked: BLOCK_HELPER_CLOSE,
    started: new Date().toISOString(), steps: [], errors: [] };
const values = new Map(), helpers = new Map(), sockets = new Set(), requests = new Map();
const websiteOperations = [], currentOperations = new WeakMap();
let browser, context, server, app, first, second, appOrigin, appURL, routeKey, approved, originalApp;
let appNavigations = 0;
let expectedAppNavigations = 1, expectedConsentCount = 1;
let preferenceHelperCount = 0;
mkdirSync(OUT, { recursive: true });

async function utility(page, expression) {
    const world = await page._connection.toImpl(page).mainFrame()._utilityContext();
    return world.evaluateExpression(expression, { isFunction: false });
}
const snapshot = page => utility(page, '__kwxWebKit.snapshot()');
const shadow = (page, selector, property = 'textContent') => utility(page,
    `__kwxWebKit.roots.get(document.getElementById('keewebx-userscript-connect'))?.querySelector(${JSON.stringify(selector)})?.[${JSON.stringify(property)}] ?? null`);
const status = page => shadow(page, '[role="status"]');
// Count logical App requests, not handler executions; retries remain in windowRequests.
const fieldReads = () => app.evaluate(() => globalThis.__kwxFixture.logicalRequests['kwx-get-entry-fields'] || 0);
const entryReads = () => app.evaluate(() => globalThis.__kwxFixture.logicalRequests['kwx-get-entries'] || 0);
const windowTraffic = () => app.evaluate(() => ({ requests: __kwxFixture.windowRequests,
    responses: __kwxFixture.windowResponses, dropped: __kwxFixture.droppedResponses,
    postAttempts: __kwxFixture.wireRequests, logicalRequests: __kwxFixture.logicalRequests }));
const consent = () => app.getByRole('dialog', { name: 'Allow browser extension access', exact: true });
const isHelper = url => url.startsWith(appOrigin + '/connect-port/relay.html');
async function action(page, name) {
    await page.bringToFront();
    const startsOperation = page !== app && (['lookup', 'probe', 'open'].includes(name)
        || name === 'toggle' && await shadow(page, 'section', 'hidden'));
    if (startsOperation) {
        const previous = currentOperations.get(page);
        if (previous && !previous.checked) await checkOperation(page);
        const state = await snapshot(page);
        const operation = { action: name, boot: state.boot, offset: state.packets.length, helpersBefore: helpers.size,
            previousPorts: state.packets.filter(item => item.direction === 'sent' && item.data.kind === 'request')
                .map(item => ({ port: item.port, connection: item.data.connectionId })), checked: false };
        currentOperations.set(page, operation); websiteOperations.push(operation);
    }
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
async function ready(page, { loginFields = true } = {}) {
    await expect(page.locator('#keewebx-userscript-connect')).toBeAttached({ timeout: 15000 });
    expect(await shadow(page, '[data-role="version"]')).toBe('Connect ' + VERSION);
    expect(await utility(page, "__kwxWebKit.roots.get(document.getElementById('keewebx-userscript-connect')).mode")).toBe('closed');
    expect(await page.evaluate(() => [typeof globalThis.__kwxWebKit, document.getElementById('keewebx-userscript-connect').shadowRoot])).toEqual(['undefined', null]);
    if (page !== app) {
        await expect.poll(() => shadow(page, '[data-action="lookup"]', 'disabled')).toBe(false);
        await expect.poll(() => shadow(page, '[data-action="probe"]', 'disabled')).toBe(false);
        await expect.poll(() => shadow(page, '[data-action="toggle"]', 'hidden')).toBe(!loginFields);
    }
}
async function sameApp() {
    expect(await app.evaluate(() => ({ href: location.href, timeOrigin: performance.timeOrigin }))).toEqual(originalApp);
    expect(appNavigations).toBe(expectedAppNavigations);
    expect(context.pages().filter(page => page !== upgradePage && page.url().startsWith(appOrigin) && !isHelper(page.url()))).toEqual([app]);
    await expect(app.locator('.vault')).toBeVisible();
    await expect(consent()).toHaveCount(0);
    expect(await app.evaluate(() => __kwxFixture.consentCount)).toBe(expectedConsentCount);
    expect(values.get(routeKey)).toEqual(approved);
}
async function noHelpers() {
    await expect.poll(() => context.pages().filter(page => isHelper(page.url())).length, { timeout: 10000 }).toBe(0);
    expect([...helpers.values()].every(helper => helper.closedAt !== null && helper.automaticClosure)).toBe(true);
}
async function restoreSavedApp(previousRoute) {
    await ready(app);
    await expect(app.locator('html')).toHaveAttribute('data-app-instance', 'primary');
    await expect(app.locator('.vault-row')).toHaveCount(1);
    await app.locator('.vault-row').click();
    const fallback = app.getByRole('button', { name: 'Use password', exact: true });
    if (await fallback.isVisible()) await fallback.click();
    await app.locator('#password').fill(PASSWORD); await app.locator('#unlock').click();
    await expect(app.locator('.entry-row').first()).toBeVisible();
    await expect.poll(() => status(app), { timeout: 15000 }).toContain('Authorized');
    await expect.poll(() => values.get(routeKey)?.host).not.toBe(previousRoute.host);
    approved = structuredClone(values.get(routeKey));
    expect(approved.publicKey).toBe(previousRoute.publicKey);
    expect(approved).toMatchObject({ endpoint: appURL, messagePort: 1, readyProof: 1, wireReceipt: 1 });
    const traffic = await windowTraffic();
    for (const name of ['ping', 'change-public-keys', 'kwx-pair', 'kwx-features'])
        expect(traffic.requests.some(request => request.data.action === name), 'Restore must execute real ' + name).toBe(true);
    expect((await snapshot(app)).actions.some(item => item.action === 'authorize')).toBe(false);
    originalApp = await app.evaluate(() => ({ href: location.href, timeOrigin: performance.timeOrigin }));
    expectedConsentCount = 0;
    await sameApp();
}
async function reopenAppThenWebsite() {
    await expect(app.locator('#sync-state')).toHaveText('Up to date');
    const previousRoute = structuredClone(approved), previousApp = structuredClone(originalApp);
    const previousSite = await first.evaluate(() => ({ href: location.href, timeOrigin: performance.timeOrigin }));
    await noHelpers();
    await app.bringToFront(); await app.close();
    app = await context.newPage(); expectedAppNavigations++;
    await app.goto(appURL); await restoreSavedApp(previousRoute);
    expect(originalApp.timeOrigin).not.toBe(previousApp.timeOrigin);
    expect(approved.owner).not.toBe(previousRoute.owner);
    // Match the reported ordering: restore the App first, then replace the website.
    await first.close();
    const count = helpers.size;
    first = await context.newPage(); await first.goto(ACCOUNTS[0].url); await ready(first);
    expect(await first.evaluate(() => performance.timeOrigin)).not.toBe(previousSite.timeOrigin);
    expect(helpers.size).toBe(count); await emptyFields(first);
    return count;
}
async function appCloseReopenAcceptance() {
    const count = await reopenAppThenWebsite();
    const lists = await entryReads(), reads = await fieldReads();
    await lookup(first, ACCOUNTS[0]); await closedHelper(first, count); await fill(first, ACCOUNTS[0]);
    for (let cycle = 0; cycle < 2; cycle++) {
        await testConnection(first);
        await clearFields(first); await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]);
    }
    expect(helpers.size).toBe(count + 7);
    // Reopening the panel with its previously focused login field also runs lookup.
    expect(await entryReads()).toBe(lists + 5); expect(await fieldReads()).toBe(reads + 3);
    const receiving = await snapshot(app), handoffs = receiving.attachments.filter(item => item.data.kind === 'attach-port');
    expect(handoffs).toHaveLength(7);
    expect(new Set(handoffs.map(item => item.data.connectionId)).size).toBe(7);
    expect(handoffs.every(item => item.trusted && item.worker === appOrigin + '/connect-port/worker.js'
        && item.data.appBoot === approved.host && item.data.endpoint === appURL)).toBe(true);
    const outgoing = (await snapshot(first)).packets.filter(item => item.direction === 'sent' && item.data.kind === 'request');
    expect(outgoing.length).toBeGreaterThan(0);
    expect(outgoing.every(item => item.data.value.packet.host === approved.host)).toBe(true);
    await sameApp(); await noHelpers();
    return { realAppClosed: true, persistedVaultReopened: true, savedGrantRestored: true, additionalConsentDialogs: 0,
        changedAppHost: true, changedAppOwner: true, websiteReopenedAfterUnlock: true,
        successfulFills: 3, repeatedConnectionTests: 2, helpersOpened: 7, distinctOperationPorts: 7,
        lookupSelectionFillRetainsSession: true,
        appNavigations, faultInjected: false };
}
async function freshOperationsAcceptance() {
    const count = helpers.size, reads = await fieldReads(), lists = await entryReads();
    const operationsBefore = websiteOperations.length, ports = [];
    let website;
    try {
        for (let visit = 0; visit < 2; visit++) {
            const before = helpers.size;
            website = await context.newPage(); await website.goto(ACCOUNTS[0].url); await ready(website);
            ports.push(await connectWithoutFieldFocus(website, before));
            for (let attempt = 0; attempt < 2; attempt++) {
                await testConnection(website); ports.push(await physicalPort(website));
            }
            await testConnection(website, 'open'); ports.push(await physicalPort(website));
            expect(helpers.size).toBe(before + 4);
            expect(await entryReads()).toBe(lists + visit); expect(await fieldReads()).toBe(reads + visit);
            const traffic = (await windowTraffic()).requests.length, packets = (await snapshot(website)).packets.length;
            await app.bringToFront(); await sameApp(); await website.bringToFront();
            await website.waitForTimeout(250);
            expect(helpers.size).toBe(before + 4);
            expect((await windowTraffic()).requests).toHaveLength(traffic);
            expect((await snapshot(website)).packets).toHaveLength(packets);
            await emptyFields(website); await lookup(website, ACCOUNTS[0]);
            const lookupPort = await physicalPort(website); ports.push(lookupPort);
            await fill(website, ACCOUNTS[0]);
            expect(await physicalPort(website)).toEqual(lookupPort);
            expect(helpers.size).toBe(before + 5);
            await website.close(); website = undefined;
            await sameApp(); await noHelpers();
        }
        expect(ports[5].boot).not.toBe(ports[0].boot);
        expect(new Set(ports.map(port => port.connection)).size).toBe(10);
        expect(new Set(ports.map(port => port.boot + ':' + port.port)).size).toBe(10);
        expect(helpers.size).toBe(count + 10);
        expect(websiteOperations.slice(operationsBefore)).toHaveLength(10);
        expect(websiteOperations.slice(operationsBefore).every(operation => operation.checked)).toBe(true);
        expect(await entryReads()).toBe(lists + 2); expect(await fieldReads()).toBe(reads + 2);
        return { repeatedConnectionTests: 4, explicitReconnects: 2, appVisitsAndReturns: 2, websiteClosedAndReopened: true,
            distinctOperationPorts: 10, helpersOpened: 10, successfulFills: 2, lookupSelectionFillRetainsSession: true,
            additionalConsentDialogs: 0, originalAppReused: true, accountReadsBeforeLookup: 0 };
    } finally { if (website && !website.isClosed()) await website.close(); }
}
async function delayedReopenedAppAcceptance() {
    const count = await reopenAppThenWebsite();
    expect(approved.mailbox).toBe(true);
    const lists = await entryReads(), reads = await fieldReads(), started = Date.now();
    await utility(app, '__kwxWebKit.holdDiscoveryDelivery(true)');
    try {
        await startLookup(first);
        await expect.poll(async () => (await snapshot(app)).heldDiscovery,
            { timeout: 10000 }).toBeGreaterThan(0);
        // This defers the real event callback, preserving its trusted source and ports.
        // App mailbox scans also see no requests until the simulated resume.
        await first.waitForTimeout(DISCOVERY_DELAY_MS);
        const waiting = await snapshot(first);
        report.delayedReopenedApp = { requestedDelayMs: DISCOVERY_DELAY_MS,
            statusBeforeResume: await status(first), websiteHiddenBeforeResume: await first.evaluate(() => document.hidden),
            websiteMailboxWritesBeforeResume: waiting.mailboxWrites,
            appHeldDiscoveries: (await snapshot(app)).heldDiscovery };
        expect(waiting.packets.some(item => item.direction === 'received' && item.data.kind === 'ready')).toBe(false);
        expect(waiting.mailboxWrites.some(item => item.type === 'request' && item.operation === 'hello')).toBe(true);
        expect(await fieldReads()).toBe(reads); expect(await entryReads()).toBe(lists);
        await emptyFields(first);
        report.delayedReopenedApp.releasedDiscoveryCallbacks = await utility(app, '__kwxWebKit.releaseDiscoveryDelivery()');
        await app.bringToFront();
        await first.bringToFront();
        await matching(first, ACCOUNTS[0], () => 20000); await fill(first, ACCOUNTS[0]);
        const appState = await snapshot(app), siteState = await snapshot(first);
        const hello = siteState.mailboxWrites.find(item => item.type === 'request' && item.operation === 'hello');
        expect(appState.mailboxWrites.some(item => item.type === 'reply' && item.id === hello.id)).toBe(true);
        expect(await fieldReads()).toBe(reads + 1); expect(await entryReads()).toBe(lists + 1);
        expect(helpers.size).toBe(count + 1); await noHelpers(); await sameApp();
        const elapsedMs = Date.now() - started;
        expect(elapsedMs).toBeLessThan(DISCOVERY_DELAY_MS + 30000);
        const detail = { elapsedMs, requestedDelayMs: DISCOVERY_DELAY_MS, mailboxRecovered: true,
            successfulFills: 1, additionalConsentDialogs: 0, appDeliveries: appState.discoveryDeliveries,
            appMailboxWrites: appState.mailboxWrites, websiteMailboxWrites: siteState.mailboxWrites,
            manualAppVisitModeled: true, nativeSuspensionModeled: false };
        Object.assign(report.delayedReopenedApp, detail);
        return detail;
    } finally {
        await utility(app, '__kwxWebKit.releaseDiscoveryDelivery()');
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
async function startLookup(page) {
    await page.bringToFront();
    await expect.poll(() => shadow(page, '[data-action="lookup"]', 'disabled'), {
        timeout: 15000, message: 'Wait for foreground authorization refresh before a trusted lookup tap'
    }).toBe(false);
    if (await shadow(page, 'section', 'hidden')) {
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
async function matching(page, account, remaining = () => OPERATION_BUDGET) {
    await expect.poll(() => shadow(page, '[data-role="entries"]'), { timeout: remaining() }).toContain(account.title);
    assertAccountAuthority((await snapshot(page)).packets);
    const listed = await shadow(page, '[data-role="entries"]');
    for (const other of ACCOUNTS.filter(item => item !== account)) expect(listed).not.toContain(other.title);
    expect(await status(page)).toContain('Found 1 matching account');
    await emptyFields(page);
}
async function lookup(page, account) {
    return bounded('Account lookup', async remaining => {
        const reads = await fieldReads();
        await startLookup(page); await matching(page, account, remaining);
        await checkOperation(page);
        expect(await fieldReads()).toBe(reads);
        remaining();
    });
}
async function fill(page, account) {
    return bounded('Selected account fill', async remaining => {
        await checkOperation(page);
        const reads = await fieldReads(), statusOffset = (await snapshot(page)).statuses.length;
        const port = await physicalPort(page), count = helpers.size, traffic = await windowTraffic();
        await action(page, 'entry-0');
        await expect(page.locator('#username')).toHaveValue(account.user, { timeout: remaining() });
        await expect(page.locator('#login-password')).toHaveValue(account.password, { timeout: remaining() });
        expect(await fieldReads()).toBe(reads + 1);
        expect(await page.evaluate(() => window.formSubmits)).toBe(0);
        const observed = (await snapshot(page)).statuses.slice(statusOffset);
        let previous = -1;
        for (const text of SELECTION_STATUSES) {
            const index = observed.findIndex((value, index) => index > previous && value.startsWith(text));
            expect(index, `Selection must show ${text} in order`).toBeGreaterThan(previous);
            previous = index;
        }
        expect(await physicalPort(page)).toEqual(port); expect(helpers.size).toBe(count);
        const after = await windowTraffic();
        for (const name of ['ping', 'change-public-keys', 'kwx-pair'])
            expect(after.logicalRequests[name], 'Selecting an account must retain its existing protocol session').toBe(traffic.logicalRequests[name]);
        await checkOperation(page);
        assertAccountAuthority((await snapshot(page)).packets);
        await sameApp(); await noHelpers();
        remaining();
    });
}

const readPreferences = async () => structuredClone(values.get(PREFERENCES_KEY));
const panelLayout = page => utility(page, '(' + panelGeometry.toString()
    + ")(__kwxWebKit.roots.get(document.getElementById('keewebx-userscript-connect')).querySelector('section'))");

// These cases use the real vault and receiver. Only their new website is routed.
async function preferenceSettings(page) {
    if (await shadow(page, 'section', 'hidden')) {
        await action(page, 'toggle');
        await expect.poll(() => shadow(page, '[data-action="lookup"]', 'disabled'), { timeout: 30000 }).toBe(false);
    }
    await action(page, 'config-tab');
}
async function connectWithoutFieldFocus(page, before) {
    const reads = await fieldReads(), lists = await entryReads(), requests = (await windowTraffic()).requests.length;
    expect(await page.evaluate(() => ['username', 'login-password'].includes(document.activeElement?.id))).toBe(false);
    await page.waitForTimeout(250);
    expect(helpers.size).toBe(before);
    expect((await snapshot(page)).packets).toEqual([]);
    expect((await windowTraffic()).requests).toHaveLength(requests);
    await action(page, 'toggle');
    await expect.poll(() => status(page), { timeout: OPERATION_BUDGET }).toContain('Connected to the authorized KeeWebX tab');
    const observed = await snapshot(page);
    expect(observed.actions).toContainEqual({ action: 'toggle', trusted: true });
    const operations = observed.packets.filter(item => item.direction === 'sent' && item.data.kind === 'request')
        .map(item => item.data.value?.packet?.operation);
    expect(operations).toContain('hello');
    expect(operations).toContain('probe');
    expect(operations).not.toContain('wire');
    expect(await fieldReads()).toBe(reads); expect(await entryReads()).toBe(lists);
    expect((await windowTraffic()).requests).toHaveLength(requests);
    await emptyFields(page); await closedHelper(page, before);
    return checkOperation(page);
}
async function preferenceCheckbox(page, expected) {
    const selector = '[data-action="auto-fill-single"]';
    await expect.poll(() => shadow(page, selector, 'disabled')).toBe(false);
    expect(await shadow(page, selector, 'tagName')).toBe('INPUT');
    expect(await shadow(page, selector, 'type')).toBe('checkbox');
    const id = await shadow(page, selector, 'id');
    expect(id).toBeTruthy();
    expect((await shadow(page, 'label[for=' + JSON.stringify(id) + ']')).trim()).toBe(AUTO_FILL_LABEL);
    expect(await shadow(page, selector, 'checked')).toBe(expected);
}
async function setAutoFillSingle(page, enabled) {
    await preferenceSettings(page);
    const selector = '[data-action="auto-fill-single"]';
    await expect.poll(() => shadow(page, selector, 'disabled')).toBe(false);
    if (await shadow(page, selector, 'checked') !== enabled) {
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
    try {
        expect((await readPreferences())?.autoFillSingle ?? false).toBe(false);
        await page.goto(CHOICE_ORIGIN + '/no-login'); await ready(page, { loginFields: false });
        await page.locator('#search').click(); await page.waitForTimeout(250);
        expect(await shadow(page, '[data-action="toggle"]', 'hidden')).toBe(true);
        await page.locator('#fixture-login').evaluate(form => { form.hidden = false; });
        await expect.poll(() => shadow(page, '[data-action="toggle"]', 'hidden')).toBe(false);
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
        const port = await connectWithoutFieldFocus(page, count);
        await preferenceSettings(page); await preferenceCheckbox(page, false);
        expect(helpers.size).toBe(count + 1);
        expect((await windowTraffic()).requests).toHaveLength(requests);
        const reads = await fieldReads(), lists = await entryReads();
        await action(page, 'accounts-tab'); await action(page, 'lookup');
        await expect.poll(() => status(page), { timeout: OPERATION_BUDGET }).toContain('Found 2 matching account');
        expect(await fieldReads()).toBe(reads); expect(await entryReads()).toBe(lists + 1);
        expect(await checkOperation(page)).not.toEqual(port); expect(helpers.size).toBe(count + 2);
        await emptyFields(page);
        await action(page, 'close');
        // The earlier lookup used detected fields, so the key still has no selected field.
        await utility(app, '__kwxWebKit.hold("probe")');
        try {
            await action(page, 'toggle');
            await expect.poll(async () => (await snapshot(app)).held, { timeout: OPERATION_BUDGET }).toBeGreaterThan(0);
            await checkOperation(page);
            await action(page, 'toggle');
            expect(await shadow(page, 'section', 'hidden')).toBe(true);
            const stopped = await status(page);
            await utility(app, '__kwxWebKit.release()');
            await page.waitForTimeout(1700);
            expect(await status(page)).toBe(stopped);
            expect(await shadow(page, 'section', 'hidden')).toBe(true);
            expect(await fieldReads()).toBe(reads); expect(await entryReads()).toBe(lists + 1);
            await emptyFields(page);
        } finally { await utility(app, '__kwxWebKit.release()'); }
        await action(page, 'toggle');
        await expect.poll(() => status(page), { timeout: OPERATION_BUDGET }).toContain('Connected to the authorized KeeWebX tab');
        await checkOperation(page); expect(helpers.size).toBe(count + 4);
        await action(page, 'close');
        await page.locator('#fixture-login').evaluate(form => { form.hidden = true; });
        await expect.poll(() => shadow(page, '[data-action="toggle"]', 'hidden')).toBe(true);
        const packetsAtHide = (await snapshot(page)).packets.length;
        await page.waitForTimeout(250);
        expect((await snapshot(page)).packets).toHaveLength(packetsAtHide);
        expect(await fieldReads()).toBe(reads); expect(await entryReads()).toBe(lists + 1);
        await sameApp(); await noHelpers();
        return { hiddenWithoutLogin: true, followsFormVisibility: true, requestsBeforeTrustedKey: 0,
            keyOpensVerifiedHelper: true, keyAccountRequests: 0, lookupUsesFreshPort: true, helpersOpened: 4,
            canceledKeyProbeStaysStopped: true, formHideAddsRequests: 0, defaultAutoFillSingle: false };
    } finally { await page.close(); }
}
async function testSinglePreference() {
    const page = await context.newPage(), account = ACCOUNTS[0], count = helpers.size;
    try {
        await page.goto(account.url); await ready(page); await emptyFields(page);
        const requests = (await windowTraffic()).requests.length;
        await connectWithoutFieldFocus(page, count);
        await preferenceSettings(page); await preferenceCheckbox(page, false);
        await setAutoFillSingle(page, true);
        await page.reload(); await ready(page);
        const port = await connectWithoutFieldFocus(page, count + 1);
        await preferenceSettings(page); await preferenceCheckbox(page, true);
        await page.waitForTimeout(250);
        expect(helpers.size).toBe(count + 2);
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
        expect(await shadow(page, 'section')).not.toContain(account.password);
        expect(await checkOperation(page)).not.toEqual(port);
        await closedHelper(page, count + 2);
        await page.reload(); await ready(page);
        await setAutoFillSingle(page, false);
        await clearFields(page); await lookup(page, account); await emptyFields(page);
        await closedHelper(page, count + 4);
        await fill(page, account);
        expect(helpers.size).toBe(count + 5);
        await sameApp(); await noHelpers();
        return { persistedInPrivateGM: true, automaticAccountClicks: 0, automaticFieldRequests: 1,
            automaticListRequests: 1, unfocusedKeyDoesNotAutoFill: true, submissions: 0, optOutRestoresManualChoice: true };
    } finally { await page.close(); }
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
        await expect.poll(() => shadow(page, '[data-role="entries"]'), { timeout: OPERATION_BUDGET }).toContain(CHOICE_ACCOUNTS[1].title);
        const listed = await shadow(page, '[data-role="entries"]');
        for (const account of CHOICE_ACCOUNTS) expect(listed).toContain(account.title);
        for (const account of ACCOUNTS) expect(listed).not.toContain(account.title);
        expect(await shadow(page, '[data-action="entry-0"]')).toBeTruthy();
        expect(await shadow(page, '[data-action="entry-1"]')).toBeTruthy();
        expect(await shadow(page, '[data-action="entry-2"]')).toBeNull();
        expect(await status(page)).toContain('Found 2 matching account');
        await expect.poll(() => shadow(page, '[data-action="lookup"]', 'disabled')).toBe(false);
        await page.waitForTimeout(250);
        await emptyFields(page);
        expect(await fieldReads()).toBe(reads);
        expect(await entryReads()).toBe(lists + 1);
        expect((await snapshot(page)).actions.slice(offset).filter(item => item.action.startsWith('entry-'))).toEqual([]);
        assertAccountAuthority((await snapshot(page)).packets);
        await closedHelper(page, count + 1); await checkOperation(page);
        const firstEntry = await shadow(page, '[data-action="entry-0"]');
        const selected = CHOICE_ACCOUNTS.find(account => firstEntry.includes(account.title));
        expect(selected).toBeTruthy();
        await fill(page, selected);
        await page.reload(); await ready(page);
        await setAutoFillSingle(page, false);
        await closedHelper(page, count + 2); await checkOperation(page);
        expect(helpers.size).toBe(count + 3);
        await sameApp(); await noHelpers();
        return { matchingAccounts: 2, automaticFieldRequests: 0, manualSelectionStillFills: true,
            preferenceRestored: false, captures, keyboardViewport: 'resized desktop viewport' };
    } finally { await page.close(); }
}
async function armDrop(page, kind, wireAction) {
    const target = kind === 'reply' ? app : page, offset = (await snapshot(target)).packets.length;
    const beforeWindow = await windowTraffic();
    await utility(target, `__kwxWebKit.dropWire(${JSON.stringify(kind)}, ${JSON.stringify(wireAction)})`);
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
    expect(await physicalPort(page)).not.toEqual(before.port);
    expect(helpers.size).toBe(before.helpers + 1);
    await sameApp(); await noHelpers();
    return { ...recovery, logicalFieldRequests: 1, logicalAccountListRequests: 1,
        freshOperationPort: true, lookupSelectionFillRetainsSession: true, helpersOpened: 1 };
}
async function recoverInnerReply(page, account) {
    await clearFields(page); await lookup(page, account);
    const reads = await fieldReads(), port = await physicalPort(page), count = helpers.size, before = await windowTraffic();
    expect(before.responses.some(response => response.data.kwReceipt === 1 && before.requests.some(request =>
        request.data.kwRequest === response.data.kwRequest && request.data.kwConnection === response.data.kwConnection))).toBe(true);
    await app.evaluate(() => { __kwxFixture.dropNextResponse = 'kwx-get-entry-fields'; });
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
    expect(await app.evaluate(() => __kwxFixture.dropNextResponse)).toBe(null);
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
        await app.evaluate(wireAction => { __kwxFixture.holdAction = wireAction; }, wireAction);
        try {
            if (operation === 'fill') await action(page, 'entry-0'); else await startLookup(page);
            await expect.poll(() => app.evaluate(() => __kwxFixture.heldResponses.length),
                { timeout: remaining(), intervals: [25, 50, 100] }).toBeGreaterThan(0);
            await emptyFields(page);
            const packet = (await snapshot(page)).packets.filter(item => item.direction === 'sent'
                && item.data.value?.packet?.body?.action === wireAction).at(-1).data.value.packet;
            await action(page, 'toggle');
            expect(await shadow(page, 'section', 'hidden')).toBe(true);
            expect(await shadow(page, '[data-action="lookup"]', 'disabled')).toBe(false);
            const stopped = await status(page), attempts = async () => (await snapshot(page)).packets.filter(item =>
                item.direction === 'sent' && item.data.value?.packet?.id === packet.id).length;
            const attemptsAtClose = await attempts();
            expect(await app.evaluate(() => __kwxFixture.releaseResponses())).toBeGreaterThan(0);
            await page.waitForTimeout(1700);
            expect(await attempts()).toBe(attemptsAtClose);
            expect(await shadow(page, 'section', 'hidden')).toBe(true);
            expect(await status(page)).toBe(stopped);
            expect(await shadow(page, '[data-role="entries"]')).not.toContain(account.title);
            await emptyFields(page);
            expect(await page.evaluate(() => window.credentialInputEvents)).toBe(events);
            expect(await fieldReads()).toBe(reads + (operation === 'fill' ? 1 : 0));
            expect(await entryReads()).toBe(lists + (operation === 'lookup' ? 1 : 0));
            if (operation === 'fill') {
                expect(await physicalPort(page)).toEqual(port); expect(helpers.size).toBe(count);
            } else {
                expect(await checkOperation(page)).not.toEqual(port); expect(helpers.size).toBe(count + 1);
            }
            await sameApp(); await noHelpers();
            remaining();
        } finally { await app.evaluate(() => __kwxFixture.releaseResponses()); }
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
async function testConnection(page, control = 'probe') {
    if (await shadow(page, 'section', 'hidden')) {
        await action(page, 'toggle');
        await expect.poll(() => shadow(page, '[data-action="lookup"]', 'disabled'), { timeout: 30000 }).toBe(false);
    }
    await action(page, 'config-tab');
    const reads = await fieldReads(), lists = await entryReads(), requests = (await windowTraffic()).requests.length;
    await action(page, control);
    await expect.poll(() => status(page), { timeout: 15000 }).toContain('Connected to the authorized KeeWebX tab');
    await checkOperation(page);
    const operation = currentOperations.get(page), state = await snapshot(page);
    const sent = state.packets.slice(operation.offset).filter(item => item.direction === 'sent' && item.data.kind === 'request');
    expect(sent.some(item => item.data.value?.packet?.operation === 'hello')).toBe(true);
    expect(sent.some(item => item.data.value?.packet?.operation === 'probe')).toBe(true);
    expect(sent.some(item => item.data.value?.packet?.operation === 'wire')).toBe(false);
    expect(await fieldReads()).toBe(reads); expect(await entryReads()).toBe(lists);
    expect((await windowTraffic()).requests).toHaveLength(requests);
    await sameApp();
}
async function physicalPort(page) {
    const state = await snapshot(page), sent = state.packets.filter(item => item.direction === 'sent' && item.data.kind === 'request');
    expect(sent.length).toBeGreaterThan(0);
    const latest = sent.at(-1);
    // Every physical port has exactly one connection ID, including historical operations.
    for (const connection of new Set(sent.map(item => item.data.connectionId)))
        expect(new Set(sent.filter(item => item.data.connectionId === connection).map(item => item.port)).size).toBe(1);
    for (const port of new Set(sent.map(item => item.port)))
        expect(new Set(sent.filter(item => item.port === port).map(item => item.data.connectionId)).size).toBe(1);
    return { boot: state.boot, port: latest.port, connection: latest.data.connectionId };
}
async function checkOperation(page) {
    const operation = currentOperations.get(page);
    expect(operation, 'A direct handoff requires a trusted website operation').toBeTruthy();
    const state = await snapshot(page), packets = state.packets.slice(operation.offset);
    expect(state.boot).toBe(operation.boot);
    const sent = packets.filter(item => item.direction === 'sent' && item.data.kind === 'request');
    expect(sent.length).toBeGreaterThan(0);
    const ports = [...new Set(sent.map(item => item.port))], connections = [...new Set(sent.map(item => item.data.connectionId))];
    expect(ports, 'One physical port throughout lookup, selection, fill, and retries').toHaveLength(1);
    expect(connections, 'One direct session per trusted operation').toHaveLength(1);
    const wire = sent.filter(item => item.data.value?.packet?.operation === 'wire');
    if (wire.length) {
        const scopes = [...new Set(wire.map(item => item.data.value.packet.scope))];
        expect(scopes, 'Lookup and selection retain one authenticated RPC scope').toHaveLength(1);
        expect(typeof scopes[0]).toBe('string'); expect(scopes[0]).not.toBe('');
    }
    expect(operation.previousPorts.map(item => item.port), 'A trusted operation must open a fresh physical port').not.toContain(ports[0]);
    expect(operation.previousPorts.map(item => item.connection), 'A trusted operation must use a fresh connection ID').not.toContain(connections[0]);
    await closedHelper(page, operation.helpersBefore);
    operation.port = ports[0]; operation.connection = connections[0]; operation.checked = true;
    return physicalPort(page);
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

// Capture public close controls before the production relay listener.
function observeHelper({ marker }) {
    if (location.pathname !== '/connect-port/relay.html') return;
    const record = (channel, event, sourceMatches) => {
        if (event.data?.marker !== marker) return;
        void globalThis.kwxHelperTrace({ url: location.href, at: Date.now(), channel, trusted: event.isTrusted,
            sourceMatches, origin: event.origin, ports: event.ports.length, data: structuredClone(event.data) });
    };
    addEventListener('message', event => record('opener', event, event.source === window.opener), true);
    navigator.serviceWorker.addEventListener('message', event => record('worker', event,
        event.source === navigator.serviceWorker.controller), true);
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
async function closureNotice(page, before) {
    const kind = 'relay-complete';
    const helper = [...helpers.values()][before], url = new URL(helper.url);
    const ready = (await snapshot(page)).packets.find(item => item.direction === 'received'
        && item.data.kind === 'ready' && item.at >= helper.openedAt);
    const expected = { marker: PORT_MARK, kind, nonce: url.searchParams.get('nonce'),
        connectionId: ready.data.connectionId, endpoint: url.searchParams.get('endpoint') };
    const matches = () => (report.helperMessages || []).filter(item => item.url === helper.url
        && item.data.kind === kind);
    await expect.poll(() => matches().length, { timeout: 2000 }).toBeGreaterThan(0);
    const notice = matches()[0];
    expect(notice.data).toEqual(expected);
    expect(notice.trusted && notice.sourceMatches).toBe(true);
    expect(notice.ports).toBe(0);
    expect(notice.channel).toBe('opener');
    expect(notice.origin).toBe(url.searchParams.get('site'));
    expect(validReadyProof(ready.data)).toBe(true);
    expect(notice.at).toBeGreaterThanOrEqual(ready.at);
    expect(helper.closedAt).toBeGreaterThanOrEqual(ready.at);
    helper.closureControl = kind;
    return notice;
}

async function openerSelfClose() {
    return bounded('Opener self-close after signed App readiness', async remaining => {
        const website = await context.newPage(), before = helpers.size;
        await website.goto(ACCOUNTS[0].url); await ready(website); await emptyFields(website);
        await utility(website, '__kwxHelperClose.blocked = true');
        const reads = await fieldReads(), lists = await entryReads();
        await utility(app, '__kwxWebKit.hold()');
        try {
            await startLookup(website);
            await expect.poll(async () => (await snapshot(app)).held, { timeout: remaining() }).toBeGreaterThan(0);
            await closedHelper(website, before);
            await closureNotice(website, before);
            const { helperClose, packets } = await snapshot(website);
            expect(helperClose.attempts.length).toBeGreaterThan(0);
            expect(helperClose.attempts.every(item => item.blocked && !item.closedBefore && !item.closedAfter)).toBe(true);
            expect(packets.some(item => item.direction === 'received' && item.data.value?.packet?.operation === 'hello')).toBe(false);
            expect(await entryReads()).toBe(lists); expect(await fieldReads()).toBe(reads);
            await emptyFields(website);
            await utility(app, '__kwxWebKit.release()');
            await matching(website, ACCOUNTS[0], remaining);
            await fill(website, ACCOUNTS[0]);
            remaining();
            return { trustedOpenerSelfClosed: true, remoteCloseAttemptsBlocked: helperClose.attempts.length,
                signedReadyAndHelloRequiredBeforeAccountData: true };
        } finally {
            await utility(app, '__kwxWebKit.release()');

            await website.close();
        }
    });
}

async function closedHelper(page, before) {
    await noHelpers(); expect(helpers.size).toBe(before + 1);
    const helper = [...helpers.values()][before], url = new URL(helper.url);
    expect(url.searchParams.getAll('site')).toEqual([new URL(page.url()).origin]);
    expect(url.searchParams.getAll('endpoint')).toEqual([appURL]);
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
    expect(ready.data.appBoot).toBe(approved.host);
    expect(ready.data.endpoint).toBe(appURL);
    expect(ready.data.siteOrigin).toBe(new URL(page.url()).origin);
    expect(ready.data.connectionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(validReadyProof(ready.data)).toBe(true);
    expect(packets.some(item => item.direction === 'sent' && item.port === ready.port
        && item.data.kind === 'request' && item.data.connectionId === ready.data.connectionId
        && item.data.value?.packet?.operation === 'hello' && item.at >= ready.at)).toBe(true);
    expect(helper.automaticClosure).toBe(true);
    helper.signedReadyVerified = true;
}
async function step(name, fn) {
    const started = Date.now();
    try {
        const detail = await fn();
        report.steps.push({ name, passed: true, milliseconds: Date.now() - started, ...detail });
        console.log('PASS ' + name);
    } catch (error) { report.steps.push({ name, passed: false }); throw error; }
}

// Wrappers live only in the utility world; explicit one-shot drops model lost traffic.
function adapter(marker, appOrigin, blockHelperClose, allowMailbox) {
    helperCloseFault({ marker, appOrigin, blocked: blockHelperClose });
    const roots = new WeakMap(), ports = new WeakMap();
    const state = { boot: crypto.randomUUID(), packets: [], attachments: [], holdAppReady: false, heldReady: [],
        holdOperation: null, held: [], dropNext: null, dropDiscoveryPorts: false, statuses: [], actions: [],
        holdDiscovery: false, heldDiscovery: [], discoveryDeliveries: [], mailboxWrites: [] };
    globalThis.__kwxWebKit = { roots, snapshot: () => ({ boot: state.boot, packets: state.packets, attachments: state.attachments,
        helperClose: __kwxHelperClose.snapshot(), heldReady: state.heldReady.length,
        held: state.held.length, dropNext: state.dropNext, statuses: state.statuses, actions: state.actions,
        heldDiscovery: state.heldDiscovery.length, discoveryDeliveries: state.discoveryDeliveries, mailboxWrites: state.mailboxWrites }),
        holdDiscoveryDelivery: enabled => { state.holdDiscovery = enabled; },
        releaseDiscoveryDelivery: () => {
            state.holdDiscovery = false;
            const pending = state.heldDiscovery.splice(0);
            for (const deliver of pending) deliver();
            return pending.length;
        },
        dropDiscoveryPorts: enabled => { state.dropDiscoveryPorts = enabled; },
        holdReady: () => { state.holdAppReady = true; }, releaseReady: () => {
            state.holdAppReady = false;
            const pending = state.heldReady.splice(0);
            for (const [port, data, rest] of pending) { record(port, 'sent', data); nativePost.call(port, data, ...rest); }
            return pending.length;
        },
        dropWire: (kind, action) => {
            if (state.dropNext || !['request', 'reply'].includes(kind)
                || !['kwx-get-entries', 'kwx-get-entry-fields'].includes(action)) throw new Error('Invalid or already armed one-shot wire drop');
            state.dropNext = { kind, action };
        },
        hold: (operation = 'hello') => { state.holdOperation = operation; }, release: (dropFirst = false) => {
            state.holdOperation = null;
            const pending = state.held.splice(0);
            const released = dropFirst ? pending.slice(1) : pending;
            for (const [port, data, rest] of released) { record(port, 'sent', data); nativePost.call(port, data, ...rest); }
            return released.length;
        } };
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (...args) {
        const root = attach.apply(this, args); roots.set(this, root);
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
    let sequence = 0, tab = null;
    const record = (port, direction, data) => {
        if (data?.marker === marker) state.packets.push({ at: Date.now(), port: ports.get(port), direction, data: structuredClone(data) });
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
    const nativePost = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (data, ...rest) {
        if (data?.marker === marker) {
            observe(this);
            if (state.dropDiscoveryPorts && ['app-ready', 'app-state'].includes(data.kind)) {
                record(this, 'dropped', data); return;
            }
            if (state.holdAppReady && location.origin === appOrigin && data.kind === 'ready') {
                state.heldReady.push([this, data, rest]); record(this, 'held', data); return;
            }
            if (state.holdOperation && data.kind === 'reply' && data.value?.packet?.operation === state.holdOperation) { state.held.push([this, data, rest]); return; }
            if (state.dropNext?.kind === data.kind && data.value?.packet?.operation === 'wire'
                && data.value.packet.body?.action === state.dropNext.action) {
                state.dropNext = null;
                record(this, 'dropped', data);
                return;
            }
            record(this, 'sent', data);
        }
        return nativePost.call(this, data, ...rest);
    };
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.marker !== marker) return;
        for (const port of event.ports) observe(port);
        state.attachments.push({ trusted: event.isTrusted, worker: event.source?.scriptURL, data: structuredClone(event.data) });
    });
    if (allowMailbox && location.origin === appOrigin) {
        const container = navigator.serviceWorker, add = container.addEventListener.bind(container), remove = container.removeEventListener.bind(container);
        const listeners = new Map();
        container.addEventListener = (type, listener, ...rest) => {
            if (type !== 'message' || !listener) return add(type, listener, ...rest);
            if (!listeners.has(listener)) listeners.set(listener, event => {
                const receivedAt = Date.now();
                const deliver = () => {
                    if (!listeners.has(listener)) return;
                    if (event.data?.marker === marker && ['find-app', 'attach-port'].includes(event.data.kind))
                        state.discoveryDeliveries.push({ kind: event.data.kind, traceId: event.data.traceId,
                            receivedAt, deliveredAt: Date.now(), trusted: event.isTrusted, portCount: event.ports.length });
                    if (typeof listener === 'function') listener.call(container, event); else listener.handleEvent(event);
                };
                if (state.holdDiscovery && event.data?.marker === marker && ['find-app', 'attach-port'].includes(event.data.kind))
                    state.heldDiscovery.push(deliver);
                else deliver();
            });
            return add(type, listeners.get(listener), ...rest);
        };
        container.removeEventListener = (type, listener, ...rest) => {
            const wrapped = type === 'message' ? listeners.get(listener) : undefined;
            if (wrapped) listeners.delete(listener);
            return remove(type, wrapped || listener, ...rest);
        };
    }
    const call = (action, key, value) => new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        document.addEventListener('kwx-gm-' + id, event => {
            const data = JSON.parse(event.detail); if (data.error) reject(new Error(data.error)); else resolve(data.value);
        }, { once: true });
        document.dispatchEvent(new CustomEvent('kwx-gm-request', { detail: JSON.stringify({ id, action, key, value }) }));
    });
    return { info: { scriptHandler: 'Userscripts', script: { filename: 'Connect.user.js' } },
        ...(allowMailbox ? { listValues: () => state.holdDiscovery ? Promise.resolve([]) : call('list', '') } : {}),
        getValue: async (key, fallback) => state.holdDiscovery && key === 'keewebx-connect-mailbox-wake-v1'
            ? fallback : (await call('get', key)) ?? fallback,
        setValue: (key, value) => {
            if (key.startsWith('keewebx-connect-mailbox-v1:') && value?.packet) {
                const { id, type, operation, host, deadline } = value.packet;
                state.mailboxWrites.push({ at: Date.now(), id, type, operation, host, deadline });
            }
            return call('set', key, value);
        }, deleteValue: key => call('delete', key),
        getTab: async () => structuredClone(tab), saveTab: async value => { tab = structuredClone(value); } };
}

try {
    const installer = readFileSync(INSTALLER_PATH, 'utf8');
    expect(installer.match(/^\/\/ @version\s+(\S+)\s*$/m)?.[1]).toBe(VERSION);
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
        for(const account of ${JSON.stringify(VAULT_ACCOUNTS)}){const entry=db.createEntry(db.getDefaultGroup());
            for(const [key,value] of Object.entries({Title:account.title,URL:account.url,UserName:account.user}))entry.fields.set(key,value);
            entry.fields.set('Password',kdbx.ProtectedValue.fromString(account.password));}
        writeFileSync(${JSON.stringify(fixture)},new Uint8Array(await db.save()));
    `], { cwd: ROOT, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    report.kdbx = { generated: true, encrypted: true, sha256: sha256(readFileSync(fixture)) };
    const pem = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '-', '-out', '-',
        '-days', '1', '-subj', '/CN=localhost'], { stdio: ['ignore', 'pipe', 'ignore'] });
    server = createServer({ key: pem, cert: pem }, async (request, response) => {
        const pathname = new URL(request.url, 'https://localhost').pathname;
        requests.set(pathname, (requests.get(pathname) || 0) + 1);
        if (pathname === '/connect-port/upgrade-fixture.html') {
            response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end('<!doctype html><title>Worker upgrade fixture</title>'); return;
        }
        if (pathname === '/connect-port/worker.js' && workerOverride) {
            response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }).end(legacyWorkerBody()); return;
        }
        if (pathname === '/connect-port/worker.js' && workerUpgradeGate) await workerUpgradeGate;
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
    report.installer = { path: INSTALLER_PATH, version: VERSION, sourceVersion: SOURCE_VERSION,
        bytes: Buffer.byteLength(installer), sha256: sha256(installer), executedSha256: sha256(bundle), onlyChange: 'replaceAll(https://keewebx.app, appOrigin)' };
    browser = await webkit.launch({ headless: true }); report.browserVersion = browser.version();
    context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    await context.exposeBinding('kwxHelperTrace', (_source, detail) => {
        (report.helperMessages ||= []).push(detail);
        if (detail.data.kind === 'fixture-legacy-observed' && detail.data.operation === 'probe-relay') releaseWorkerUpgrade?.();
    });
    await context.addInitScript(observeHelper, { marker: PORT_MARK });
    await context.exposeBinding('kwxFixtureGM', (_source, action, key, value) => {
        if (action === 'list') return [...values.keys()];
        if (key.startsWith('keewebx-connect-mailbox-v1:') && !DISCOVERY_DELAY_MS) throw new Error('Unexpected legacy mailbox access');
        if (action === 'set') values.set(key, structuredClone(value));
        else if (action === 'delete') values.delete(key);
        else return structuredClone(values.get(key));
    });
    await context.addInitScript(() => {
        document.addEventListener('kwx-gm-request', async event => {
            const { id, action, key, value } = JSON.parse(event.detail);
            let result;
            try { result = { value: await globalThis.kwxFixtureGM(action, key, value) }; }
            catch (error) { result = { error: String(error) }; }
            document.dispatchEvent(new CustomEvent('kwx-gm-' + id, { detail: JSON.stringify(result) }));
        });
        const observed = { consentCount: 0, wireRequests: {}, logicalRequests: {}, windowRequests: [], windowResponses: [],
            droppedResponses: [], dropNextResponse: null, holdAction: null, heldResponses: [] };
        globalThis.__kwxFixture = observed;
        const requestIds = new Set(), nativePost = window.postMessage.bind(window);
        window.postMessage = (value, ...rest) => {
            if (value?.kwConnect === 'response' && value.action === observed.dropNextResponse) {
                observed.dropNextResponse = null;
                observed.droppedResponses.push({ at: Date.now(), data: structuredClone(value) }); return;
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
            { url: page.url(), openedAt: Date.now(), closedAt: null, automaticClosure: false, signedReadyVerified: false }); };
        track(); page.on('framenavigated', track);
        page.on('close', () => {
            const helper = helpers.get(page);
            if (helper) { helper.closedAt = Date.now(); helper.automaticClosure = true; }
        });
        page.on('pageerror', error => report.errors.push(redact(error.message)));
        page.on('domcontentloaded', () => {
            if (![appOrigin, ...WEBSITE_ORIGINS].includes(new URL(page.url()).origin) || isHelper(page.url())) return;
            void utility(page, `(() => { ${helperCloseFault.toString()} const GM = (${adapter.toString()})(${JSON.stringify(PORT_MARK)}, ${JSON.stringify(appOrigin)}, ${BLOCK_HELPER_CLOSE}, ${Boolean(DISCOVERY_DELAY_MS)}); ${bundle}\n})();`)
                .catch(error => report.errors.push(redact(error.stack)));
        });
    });
    for (const account of ACCOUNTS.slice(0, 2)) await context.route(account.url + '**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Disposable login</title>
        <style>body{font:18px system-ui;padding:80px}input{display:block;width:300px;height:40px;margin:12px}</style>
        <h1>Login</h1><form><input id="username" autocomplete="username"><input id="login-password" type="password" autocomplete="current-password"><button>Sign in</button></form>
        <script>window.formSubmits=0;window.credentialInputEvents=0;
        document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.formSubmits++});
        for(const input of document.querySelectorAll('input'))input.addEventListener('input',()=>{if(input.value)window.credentialInputEvents++});</script>` }));

    acceptance: {
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
        expect(approved.wireReceipt).toBe(1);
        const learned = await windowTraffic();
        expect(learned.responses.some(response => response.data.kwReceipt === 1 && learned.requests.some(request =>
            request.data.kwRequest === response.data.kwRequest && request.data.kwConnection === response.data.kwConnection))).toBe(true);
        originalApp = await app.evaluate(() => ({ href: location.href, timeOrigin: performance.timeOrigin }));
        await sameApp(); await noHelpers();
    });
    if (FOCUS_APP_REOPEN) {
        await step('the first website establishes and fills before the App is closed', async () => {
            first = await context.newPage(); await first.goto(ACCOUNTS[0].url); await ready(first);
            const count = helpers.size;
            await lookup(first, ACCOUNTS[0]); await closedHelper(first, count); await fill(first, ACCOUNTS[0]);
        });
        await step('closing and reopening the App restores its saved vault and grant before a fresh website reconnects', appCloseReopenAcceptance);
        if (DISCOVERY_DELAY_MS) await step('a reopened App resumes delayed discovery and the same website request through the signed mailbox', delayedReopenedAppAcceptance);
        expect(report.errors).toEqual([]); report.passed = true; report.focus = 'app-close-reopen'; break acceptance;
    }
    if (FOCUS_FRESH_OPERATIONS) {
        await step('repeated probes and reconnect use fresh ports before lookup after App visit and website reopen', freshOperationsAcceptance);
        expect(report.errors).toEqual([]); report.passed = true; report.focus = 'fresh-operations'; break acceptance;
    }
    await step('closing repeated App authorization restores the saved grant without another consent prompt', async () => {
        await app.bringToFront();
        await app.evaluate(() => { __kwxFixture.holdAction = 'kwx-features'; });
        try {
            await action(app, 'authorize');
            await expect.poll(() => app.evaluate(() => __kwxFixture.heldResponses.length)).toBeGreaterThan(0);
            await action(app, 'close');
            expect(await shadow(app, 'section', 'hidden')).toBe(true);
            expect(await app.evaluate(() => __kwxFixture.releaseResponses())).toBeGreaterThan(0);
            await expect.poll(() => values.get(routeKey)?.authorizationRevision,
                { timeout: 10000 }).toBeGreaterThan(approved.authorizationRevision);
            const recovered = structuredClone(values.get(routeKey));
            expect(recovered.host).toBe(approved.host);
            expect(recovered.publicKey).toBe(approved.publicKey);
            approved = recovered;
            await expect.poll(() => status(app)).toContain('Authorized');
            await sameApp();
        } finally { await app.evaluate(() => __kwxFixture.releaseResponses()); }
    });
    await step(CASES[1], async () => {
        await installLegacyWorker(appOrigin);
        first = await context.newPage(); await first.goto(ACCOUNTS[0].url); await ready(first);
        expect(helpers.size).toBe(0); await emptyFields(first);
        const lists = await entryReads(), reads = await fieldReads();
        await utility(first, '__kwxHelperClose.blocked = true');
        await utility(app, '__kwxWebKit.holdReady(); __kwxWebKit.hold()');
        try {
            await startLookup(first);
            await expect.poll(async () => (await snapshot(app)).heldReady, { timeout: 25000 }).toBe(1);
            await expect.poll(() => helpers.size).toBe(1);
            const helper = [...helpers.keys()][0];
            await first.waitForTimeout(1000);
            expect(helper.isClosed(), 'Helper must remain open while the actual App ready packet is held').toBe(false);
            const waiting = await snapshot(first);
            expect(waiting.packets.some(item => item.direction === 'received' && item.data.kind === 'ready')).toBe(false);
            expect(waiting.packets.some(item => item.direction === 'sent' && item.data.kind === 'request')).toBe(false);
            expect(waiting.helperClose.messages.some(item => item.data.kind === 'relay-complete')).toBe(false);
            expect(await entryReads()).toBe(lists); expect(await fieldReads()).toBe(reads);
            expect(await utility(app, '__kwxWebKit.releaseReady()')).toBe(1);
            await expect.poll(async () => (await snapshot(app)).held || (/invalid|blocked|could not/i.test(await status(first)) ? -1 : 0), { timeout: 25000 }).not.toBe(0);
            if ((await snapshot(app)).held < 1) throw new Error('Signed hello was not reached: ' + await status(first));
            await expect.poll(() => helpers.size).toBe(1);
            await expect.poll(() => helper.isClosed(), { timeout: 2000, message: 'Verified App ready must let the trusted opener self-close the helper while RPC hello is held' }).toBe(true);
            await closedHelper(first, 0);
            await closureNotice(first, 0);
            await finishLegacyWorker();
            expect(await entryReads()).toBe(lists); expect(await fieldReads()).toBe(reads);
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
            return { helperStayedOpenUntilSignedReady: true, heldAppReadyPackets: 1,
                helloRepliesHeld, droppedFirstHelloReply: true, identicalHelloRetries: true, physicalPortReused: true };
        } finally { await utility(app, '__kwxWebKit.releaseReady(); __kwxWebKit.release()'); }
    });
    await step(CASES[2], async () => {
        second = await context.newPage(); await second.goto(ACCOUNTS[1].url); await ready(second); expect(helpers.size).toBe(1);
        await lookup(second, ACCOUNTS[1]); await closedHelper(second, 1); await fill(second, ACCOUNTS[1]);
        report.appHiddenDuringSiteB = await app.evaluate(() => document.hidden);
        report.siteB = await physicalPort(second); expect(report.siteB.connection).not.toBe(report.siteA.connection);
        await first.locator('#username').fill(''); await first.locator('#login-password').fill('');
        await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]);
        expect(await physicalPort(first)).not.toEqual(report.siteA); expect(helpers.size).toBe(3);
        const attached = (await snapshot(app)).attachments.filter(item => item.data.kind === 'attach-port');
        expect(new Set(attached.map(item => item.data.connectionId)).size).toBe(3);
        const count = helpers.size;
        for (const page of [first, second]) {
            for (let attempt = 0; attempt < 2; attempt++) {
                const port = await physicalPort(page);
                await testConnection(page);
                expect(await physicalPort(page)).not.toEqual(port);
                await sameApp(); await noHelpers();
            }
        }
        // Opening each hidden panel also starts one lookup before its explicit probe.
        expect(helpers.size).toBe(count + 6);
        report.repeatedConnectionTests = { checks: 4, panelOpeningLookups: 2, distinctOperationPorts: 6, idleHelpers: 0 };
    });
    await step(CASES[3], async () => {
        const originalViewport = first.viewportSize();
        try {
            await first.bringToFront();
            await first.setViewportSize({ width: 1280, height: 480 });
            await preferenceSettings(first);
            await clearFields(first);
            const overlay = await panelLayout(first), field = await first.locator('#username').boundingBox();
            expect(field).not.toBeNull();
            const covered = field.x + field.width / 2 >= overlay.panel.x
                && field.x + field.width / 2 <= overlay.panel.x + overlay.panel.width
                && field.y + field.height / 2 >= overlay.panel.y
                && field.y + field.height / 2 <= overlay.panel.y + overlay.panel.height;
            expect(covered, 'The regression must start with an actually covered input').toBe(true);
            const reads = await fieldReads();
            await lookup(first, ACCOUNTS[0]);
            expect(await fieldReads()).toBe(reads);
            await fill(first, ACCOUNTS[0]);
            return { inputCoveredBySettings: true, nativePanelActions: true, originalAppReused: true };
        } finally { await first.setViewportSize(originalViewport); }
    });
    await step(CASES[4], async () => {
        for (let index = 0; index < 3; index++) {
            await clearFields(first); await lookup(first, ACCOUNTS[0]); await fill(first, ACCOUNTS[0]);
        }
        const innerRecovery = await recoverInnerReply(first, ACCOUNTS[0]), recoveries = [];
        for (const wireAction of ['kwx-get-entries', 'kwx-get-entry-fields'])
            recoveries.push(await recoverOperation(first, ACCOUNTS[0], 'reply', wireAction));
        return { warmupFills: 3, innerRecovery, recoveries };
    });
    await step(CASES[5], async () => {
        const recoveries = [];
        for (const wireAction of ['kwx-get-entries', 'kwx-get-entry-fields'])
            recoveries.push(await recoverOperation(first, ACCOUNTS[0], 'request', wireAction));
        return { recoveries };
    });
    await step(CASES[6], async () => {
        const count = helpers.size, reads = await fieldReads();
        let canceledRecoveries = 0;
        for (let index = 0; index < 24; index++) {
            const site = index % 2, page = [first, second][site], account = ACCOUNTS[site], mode = Math.floor(index / 2) % 6;
            if (mode === 4) { await cancelDroppedFill(page, account); canceledRecoveries++; }
            if (mode < 4) await recoverOperation(page, account, mode < 2 ? 'reply' : 'request',
                mode % 2 ? 'kwx-get-entry-fields' : 'kwx-get-entries');
            else { await clearFields(page); await lookup(page, account); await fill(page, account); }
            const lookupPort = await physicalPort(page);
            await testConnection(page); await action(page, 'close');
            expect(await physicalPort(page)).not.toEqual(lookupPort); await sameApp(); await noHelpers();
        }
        expect(await fieldReads()).toBe(reads + 24 + canceledRecoveries);
        expect(helpers.size).toBe(count + 24 * 3 + canceledRecoveries);
        return { alternatingFills: 24, periodicDrops: 20, canceledRecoveries, logicalFieldRequests: 24 + canceledRecoveries,
            distinctOperationPorts: 24 * 3 + canceledRecoveries, idleHelpers: 0, aggregateLookupOrFillBudget: OPERATION_BUDGET };
    });
    await step(CASES[7], () => cancelWithToggle(first, ACCOUNTS[0], 'lookup'));
    await step(CASES[8], () => cancelWithToggle(first, ACCOUNTS[0], 'fill'));
    await step(CASES[9], async () => {
        const count = helpers.size, secondPort = await physicalPort(second);
        await first.reload(); await ready(first); expect(helpers.size).toBe(count);
        await lookup(first, ACCOUNTS[0]); await closedHelper(first, count); await fill(first, ACCOUNTS[0]);
        report.siteAReload = await physicalPort(first);
        expect(report.siteAReload.boot).not.toBe(report.siteA.boot); expect(report.siteAReload.connection).not.toBe(report.siteA.connection);
        expect(await physicalPort(second)).toEqual(secondPort);
    });
    await step(CASES[10], openerSelfClose);
    const beforePreferences = helpers.size;
    await step(CASES[11], testLauncherVisibility);
    await step(CASES[12], testSinglePreference);
    await step(CASES[13], testChoicePreference);
    preferenceHelperCount = helpers.size - beforePreferences;
    expect(preferenceHelperCount).toBe(12);
    await step(CASES[14], async () => {
        await noHelpers(); await first.close(); await second.close(); first = second = undefined;
        expect(context.pages()).toEqual([app]); await sameApp();
        const before = helpers.size;
        first = await context.newPage(); await first.goto(ACCOUNTS[0].url); await ready(first);
        expect(helpers.size).toBe(before); await emptyFields(first);
        await utility(app, '__kwxWebKit.dropDiscoveryPorts(true)');
        try {
            await lookup(first, ACCOUNTS[0]); await closedHelper(first, before); await fill(first, ACCOUNTS[0]);
        } finally { await utility(app, '__kwxWebKit.dropDiscoveryPorts(false)'); }
        report.siteAFresh = await physicalPort(first);
        expect(report.siteAFresh.boot).not.toBe(report.siteAReload.boot);
        expect(report.siteAFresh.connection).not.toBe(report.siteAReload.connection);
        expect(report.siteAFresh.connection).not.toBe(report.siteB.connection);
        expect(context.pages()).toHaveLength(2); await sameApp(); await noHelpers();
        const observed = await snapshot(app), attachments = observed.attachments.filter(item => item.data.kind === 'attach-port');
        const droppedDiscoveryPortReplies = observed.packets.filter(item => item.direction === 'dropped' && item.data.kind === 'app-ready').length;
        expect(droppedDiscoveryPortReplies).toBeGreaterThan(0);
        expect(attachments).toHaveLength(websiteOperations.length);
        expect(helpers.size).toBe(websiteOperations.length);
        expect(websiteOperations.every(operation => operation.checked)).toBe(true);
        expect(new Set(attachments.map(item => item.data.connectionId)).size).toBe(websiteOperations.length);
        expect(attachments.every(item => item.trusted && item.worker === appOrigin + '/connect-port/worker.js'
            && item.data.appBoot === approved.host && item.data.endpoint === appURL)).toBe(true);
        const envelopes = observed.packets.filter(item => item.data.value?.packet).map(item => item.data.value);
        expect(envelopes.length).toBeGreaterThan(0); expect(envelopes.every(validSignature)).toBe(true);
        const sensitive = envelopes.filter(item => ['kwx-pair', 'kwx-features', 'kwx-get-entries', 'kwx-get-entry-fields'].includes(item.packet.body?.action));
        expect(sensitive.length).toBeGreaterThan(0);
        expect(sensitive.every(item => typeof item.packet.body.message === 'string' && typeof item.packet.body.nonce === 'string')).toBe(true);
        const readyProofs = observed.packets.filter(item => item.direction === 'sent' && item.data.kind === 'ready');
        const signedReadyVerified = [...helpers.values()].filter(helper => helper.signedReadyVerified).length;
        expect(readyProofs).toHaveLength(websiteOperations.length); expect(signedReadyVerified).toBe(websiteOperations.length);
        expect(readyProofs.every(item => validReadyProof(item.data) && item.data.appBoot === approved.host
            && item.data.endpoint === appURL && WEBSITE_ORIGINS.includes(item.data.siteOrigin))).toBe(true);
        const windowMessages = await windowTraffic();
        for (const secret of secrets) expect(JSON.stringify({ packets: observed.packets, windowMessages })).not.toContain(secret);
        expect(requests.get('/connect-port/worker.js')).toBeGreaterThan(0);
        report.transport = { droppedDiscoveryPortReplies, nativeWorkerAttachments: attachments.length, signedEnvelopes: envelopes.length, encryptedSensitiveEnvelopes: sensitive.length,
            signedReadyProofs: readyProofs.length, signedReadyVerified,
            workerRequestsViaHTTPS: requests.get('/connect-port/worker.js'), legacyMailboxUsed: false,
            logicalAppRequestsByAction: windowMessages.logicalRequests, physicalWindowPostsByAction: windowMessages.postAttempts };
    });
    await step('repeated probes and reconnect use fresh ports before lookup after App visit and website reopen', freshOperationsAcceptance);
    await step('closing and reopening the App restores its saved vault and grant before a fresh website reconnects', appCloseReopenAcceptance);
    expect(report.errors).toEqual([]); report.passed = true;
    }
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
        signedReadyVerified: [...helpers.values()].filter(helper => helper.signedReadyVerified).length,
        remaining: context?.pages().filter(page => isHelper(page.url())).length || 0, lifecycle: [...helpers.values()] };
    report.websiteOperations = websiteOperations.map(({ previousPorts, offset, ...operation }) => operation);
    report.finished = new Date().toISOString(); report.output = OUT;
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    await browser?.close();
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
}
