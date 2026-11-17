/**
 * Acceptance of the exact built New UI; never builds or starts a server.
 * node modules/ui/tests/app-instance-browser.mjs [--baseline] [--browser=chromium,firefox,webkit]
 * KW_E2E_APP_ORIGIN defaults to http://127.0.0.1:39232; KW_SINGLE_APP_OUTPUT selects evidence.
 * Fresh contexts isolate cases; all competing pages in a case share one context.
 * Web Locks, service workers, storage and App startup are real, never substituted.
 * Native iOS is outside desktop WebKit coverage. Full Connect fill is a separate suite.
 */
import { chromium, firefox, webkit, expect as baseExpect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const expect = baseExpect.configure({ timeout: 12_000 });
const baseline = process.argv.includes('--baseline');
const origin = process.env.KW_E2E_APP_ORIGIN || 'http://127.0.0.1:39232';
const appUrl = new URL(process.env.KW_SINGLE_APP_PATH || '/next.html', origin).href;
const lockName = `keewebx-app-instance-v1:${new URL('.', appUrl).pathname}:${process.env.KW_SINGLE_APP_NAMESPACE || ''}`;
const output = resolve(process.env.KW_SINGLE_APP_OUTPUT || `.cache/single-app/${baseline ? 'before' : 'after'}`);
const selected = (process.argv.find(value => value.startsWith('--browser='))?.split('=')[1] || 'chromium,firefox,webkit').split(',');
const caseFilter = process.argv.find(value => value.startsWith('--case='))?.slice('--case='.length);
const engines = { chromium, firefox, webkit };
for (const name of selected) if (!engines[name]) throw new Error(`Unknown browser: ${name}`);
await mkdir(output, { recursive: true });

async function fingerprint() {
    const files = {};
    for (const file of ['next.html', 'js/next.js', 'css/next.css', 'connect-port/worker.js']) {
        const response = await fetch(new URL(file, new URL('.', appUrl)));
        if (!response.ok) throw new Error(`Built ${file} unavailable: HTTP ${response.status}`);
        files[file] = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    }
    return files;
}
const report = {
    mode: baseline ? 'baseline' : 'acceptance', appUrl, lockName,
    capturedAt: new Date().toISOString(), sha256: await fingerprint(),
    limitations: ['Desktop WebKit does not verify native iOS.', 'Full Connect pairing and fill use the separate Connect suite.'],
    results: []
};
await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');

async function instrument(context) {
    context.setDefaultTimeout(12_000);
    context.setDefaultNavigationTimeout(30_000);
    await context.addInitScript(() => {
        const evidence = window.__singleAppEvidence = { windowOpenCalls: 0, roles: [], states: [], activationAtClick: [] };
        const open = window.open;
        window.open = function (...args) {
            evidence.windowOpenCalls++;
            return Reflect.apply(open, this, args);
        };
        new MutationObserver(() => {
            const role = document.getElementById('root')?.getAttribute('data-app-instance');
            if (role && evidence.roles.at(-1) !== role) evidence.roles.push(role);
        }).observe(document, { subtree: true, attributes: true, childList: true, attributeFilter: ['data-app-instance'] });
        window.addEventListener('message', event => {
            if (event.source === window && event.data?.kwConnect === 'state') evidence.states.push(event.data.action);
        });
        window.addEventListener('click', () => evidence.activationAtClick.push({
            active: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive
        }), true);
    });
}
async function open(context, url = appUrl) {
    const page = await context.newPage();
    await page.goto(url);
    return page;
}
async function primary(page) {
    await expect(page.locator('#root')).toHaveAttribute('data-app-instance', 'primary');
    await expect(page.locator('#open-demo')).toBeVisible();
    await expect(page.locator('#open-file-input')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'KeeWebX is already open', exact: true })).toHaveCount(0);
}
async function secondary(page) {
    await expect(page.locator('#root')).toHaveAttribute('data-app-instance', 'secondary');
    await expect(page.getByRole('heading', { name: 'KeeWebX is already open', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return to KeeWebX', exact: true })).toBeVisible();
    await expect(page.locator('#open-demo, #open-file-input, #password, #unlock, .entry-row, input[type="password"], input[type="file"]')).toHaveCount(0);
    await expect(page.getByRole('button')).toHaveCount(1);
    expect(await page.evaluate(() => window.__singleAppEvidence.states)).toEqual([]);
}
async function lockSnapshot(page) {
    return page.evaluate(async name => {
        const { held, pending } = await navigator.locks.query();
        return { held: held.filter(lock => lock.name === name), pending: pending.filter(lock => lock.name === name) };
    }, lockName);
}
async function locks(page, waiting) {
    await expect.poll(async () => {
        const state = await lockSnapshot(page);
        return { held: state.held.length, pending: state.pending.length, modes: state.held.map(lock => lock.mode) };
    }).toEqual({ held: 1, pending: waiting, modes: ['exclusive'] });
    return lockSnapshot(page);
}
async function demo(page) {
    await page.locator('#open-demo').click();
    await expect(page.locator('.entry-row').first()).toBeVisible();
    await page.locator('.entry-row').first().click();
    await expect(page.locator('#entry-title')).toBeVisible();
    return page.locator('#entry-title').innerText();
}
async function unchangedDemo(page, title) {
    await expect(page.locator('#root')).toHaveAttribute('data-app-instance', 'primary');
    await expect(page.locator('#entry-title')).toHaveText(title);
    await expect(page.locator('#open-demo')).toHaveCount(0);
}
async function noWindowOpen(context, expectedPages) {
    expect(context.pages()).toHaveLength(expectedPages);
    for (const page of context.pages()) expect(await page.evaluate(() => window.__singleAppEvidence.windowOpenCalls)).toBe(0);
}
async function realVisibility(page) {
    await page.waitForLoadState('domcontentloaded');
    // A separate CDP session cannot undo Playwright's own focus emulation.
    // Match port-connect.mjs: explicitly require the installed driver interface.
    const session = page._connection.toImpl(page).delegate._mainFrameSession._client;
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}
async function workerOwner(context) {
    const worker = context.serviceWorkers().find(worker => worker.url().includes('/connect-port/worker.js'));
    expect(worker, 'The real built focus worker is running').toBeTruthy();
    return worker.evaluate(async name => {
        const state = await self.navigator.locks.query();
        const held = state.held.filter(lock => lock.name === name);
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const direct = held[0]?.clientId ? await self.clients.get(held[0].clientId) : undefined;
        const prefix = name + ':client:';
        const locatorLocks = state.held.filter(lock => lock.name.startsWith(prefix) && lock.mode === 'exclusive' && lock.clientId === held[0]?.clientId);
        const mapped = clients.filter(client => locatorLocks.some(lock => decodeURIComponent(lock.name.slice(prefix.length)) === client.id));
        const owner = direct || (mapped.length === 1 ? mapped[0] : undefined);
        return { held, locatorLocks, directClientId: direct?.id || null,
            client: owner ? { id: owner.id, url: owner.url, focused: owner.focused, visibilityState: owner.visibilityState } : null,
            windowClients: clients.map(client => ({ id: client.id, url: client.url, focused: client.focused, visibilityState: client.visibilityState })) };
    }, lockName);
}

const cases = {
    async 'baseline'(context, result, dir) {
        const first = await open(context);
        await expect(first.locator('#open-demo')).toBeVisible();
        const second = await open(context);
        await expect(second.locator('#open-demo')).toBeVisible();
        result.normalApps = await Promise.all([first, second].map(page => page.locator('#open-demo:visible').count()));
        result.locks = await lockSnapshot(first);
        result.alreadyOpenNotices = await second.getByRole('heading', { name: 'KeeWebX is already open', exact: true }).count();
        expect(result.normalApps).toEqual([1, 1]);
        expect(result.locks.held).toHaveLength(0);
        expect(result.alreadyOpenNotices).toBe(0);
        await second.setViewportSize({ width: 320, height: 568 });
        await second.screenshot({ path: resolve(dir, 'second-before.png'), fullPage: true });
    },

    async 'three-pages-demo-fifo'(context, result, dir) {
        result.visibility = 'Default Playwright pages; Chromium emulates all tabs visible to exercise two eligible FIFO waiters.';
        const first = await open(context);
        await primary(first);
        const title = await demo(first);
        const second = await open(context);
        await secondary(second);
        await locks(second, 1);
        const third = await open(context);
        await secondary(third);
        result.beforeClose = await locks(third, 2);
        await unchangedDemo(first, title);
        for (const colorScheme of ['light', 'dark']) {
            await second.setViewportSize({ width: 320, height: 568 });
            await second.emulateMedia({ colorScheme });
            await expect(second.locator('html')).toHaveAttribute('data-kx-theme', colorScheme);
            expect(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            const button = second.getByRole('button', { name: 'Return to KeeWebX', exact: true });
            const box = await button.boundingBox();
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(320);
            await button.focus();
            await expect(button).toBeFocused();
            await second.screenshot({ path: resolve(dir, `secondary-320-${colorScheme}.png`), fullPage: true });
        }
        await second.bringToFront();
        await first.close();
        await primary(second);
        await secondary(third);
        result.afterFirstClose = await locks(third, 1);
        expect(result.afterFirstClose.held[0].clientId).not.toBe(result.beforeClose.held[0].clientId);
        await third.bringToFront();
        await second.close();
        await primary(third);
        result.afterSecondClose = await locks(third, 0);
        await noWindowOpen(context, 1);
    },

    async 'primary-reload'(context, result) {
        const first = await open(context);
        await primary(first);
        const second = await open(context);
        await secondary(second);
        const third = await open(context);
        await secondary(third);
        result.beforeReload = await locks(third, 2);
        await second.bringToFront();
        await first.reload();
        // The older queued secondary precedes the reloaded document's new request.
        await primary(second);
        await secondary(third);
        await secondary(first);
        result.afterReload = await locks(third, 2);
        expect(result.afterReload.held[0].clientId).not.toBe(result.beforeReload.held[0].clientId);
        for (const [owner, successor] of [[second, third], [third, first]]) {
            await successor.bringToFront();
            await owner.reload();
            await primary(successor);
            for (const waiter of [first, second, third].filter(page => page !== successor)) await secondary(waiter);
            await locks(owner, 2);
        }
        await noWindowOpen(context, 3);
    },

    async 'single-page-reload'(context, result) {
        const page = await open(context);
        await primary(page);
        result.beforeReload = await locks(page, 0);
        for (let repeat = 0; repeat < 3; repeat++) {
            await page.reload();
            await primary(page);
            await locks(page, 0);
        }
        await demo(page);
        await noWindowOpen(context, 1);
    },

    async 'hidden-silent-primary'(context, result) {
        const first = await context.newPage();
        // Silence optional inter-document liveness traffic, while preserving native locks.
        await first.addInitScript(() => {
            const Channel = window.BroadcastChannel;
            if (Channel) window.BroadcastChannel = class extends Channel { postMessage() {} };
            window.addEventListener('message', event => {
                if (event.data?.marker === 'keewebx-app-instance-v1') event.stopImmediatePropagation();
            }, true);
        });
        await first.clock.install();
        await first.goto(appUrl);
        await primary(first);
        const title = await demo(first);
        const second = await context.newPage();
        await second.clock.install();
        await second.goto(appUrl);
        await secondary(second);
        await second.bringToFront();
        result.nativeVisibility = await first.evaluate(() => ({ state: document.visibilityState, hidden: document.hidden }));
        // Headless engines do not consistently hide background tabs. Exercise the
        // hidden/persisted lifecycle signals explicitly and label that limitation.
        await first.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            document.dispatchEvent(new Event('visibilitychange'));
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        });
        // Use the browser's clock; the launcher and document may have different
        // wall clocks, and pauseAt cannot move an installed clock backwards.
        await first.clock.pauseAt(new Date(await first.evaluate(() => Date.now()) + 1000));
        result.beforeSilence = await locks(second, 1);
        await second.clock.fastForward(180_000);
        // Also observe real elapsed time, independently of the secondary's clock.
        for (let sample = 0; sample < 20; sample++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            await secondary(second);
            await locks(second, 1);
        }
        await unchangedDemo(first, title);
        result.afterSilence = await locks(second, 1);
        expect(result.afterSilence.held[0].clientId).toBe(result.beforeSilence.held[0].clientId);
        await first.close();
        await primary(second);
        await locks(second, 0);
    },

    async 'secondary-page-lifecycle'(context, result) {
        const first = await open(context);
        await primary(first);
        const second = await open(context);
        await secondary(second);
        await locks(first, 1);
        await second.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
        await locks(first, 0);
        await second.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
        await secondary(second);
        result.requeued = await locks(first, 1);
        await first.close();
        await primary(second);
        await locks(second, 0);
    },

    async 'return-existing-primary'(context, result, dir) {
        const first = await open(context);
        await primary(first);
        const title = await demo(first);
        if (result.browser === 'chromium') await realVisibility(first);
        const second = await open(context);
        if (result.browser === 'chromium') await realVisibility(second);
        await secondary(second);
        await expect.poll(() => second.evaluate(async () =>
            (await navigator.serviceWorker.getRegistrations()).some(registration =>
                registration.active?.scriptURL.includes('/connect-port/worker.js')))).toBe(true);
        await second.bringToFront();
        result.focusBefore = await first.evaluate(() => document.hasFocus());
        if (result.browser === 'chromium') {
            await expect.poll(() => first.evaluate(() => document.hidden)).toBe(true);
            await expect.poll(async () => {
                result.workerBefore = await workerOwner(context);
                return !!result.workerBefore.client;
            }, { message: 'The primary must hold a browser-verified locator for the real WindowClient' }).toBe(true);
            expect(result.workerBefore.held).toHaveLength(1);
            // Capture the mismatch before clicking, but still exercise the real
            // button so the report distinguishes refusal from actual focusing.
        }
        const focusWorker = result.browser === 'chromium' && context.serviceWorkers().find(worker => worker.url().includes('/connect-port/worker.js'));
        if (focusWorker) {
            // Record the native call and return its original promise unchanged.
            // A browser refusal only passes with the independently verified owner
            // above, visible manual guidance and zero window.open calls below.
            await focusWorker.evaluate(() => {
                self.__singleAppNativeFocus = [];
                const focus = WindowClient.prototype.focus;
                WindowClient.prototype.focus = function (...args) {
                    const call = { clientId: this.id };
                    self.__singleAppNativeFocus.push(call);
                    const pending = Reflect.apply(focus, this, args);
                    void pending.then(client => {
                        call.focused = client.focused;
                    }, error => {
                        call.error = { name: error.name, message: error.message };
                    });
                    return pending;
                };
            });
        }
        await second.getByRole('button', { name: 'Return to KeeWebX', exact: true }).click();
        const manual = second.getByRole('status').filter({ hasText: /switch.*(?:tab|window)|manually/i });
        await expect.poll(async () => await first.evaluate(() => document.hasFocus()) || await manual.isVisible()).toBe(true);
        result.focusAfter = await first.evaluate(() => document.hasFocus());
        result.manualFallback = await manual.isVisible();
        if (focusWorker) result.nativeFocusCalls = await focusWorker.evaluate(() => self.__singleAppNativeFocus);
        result.outcome = !result.focusBefore && result.focusAfter ? 'focus-transfer-observed' : 'manual-fallback';
        if (result.browser === 'chromium') {
            result.workerAfter = await workerOwner(context);
            expect(result.focusBefore).toBe(false);
            expect(result.workerBefore.client, 'The browser-held owner locator must resolve the main lock owner to an existing WindowClient').toBeTruthy();
            if (!result.workerBefore.directClientId) {
                const locator = result.workerBefore.locatorLocks.find(lock => lock.name === `${lockName}:client:${encodeURIComponent(result.workerBefore.client.id)}`);
                expect(locator?.clientId).toBe(result.workerBefore.held[0].clientId);
            }
            expect(result.workerBefore.client?.url).toBe(first.url());
            expect(result.workerBefore.client?.focused).toBe(false);
            expect(result.workerAfter.client?.id).toBe(result.workerBefore.client.id);
            expect(result.workerAfter.held[0]?.clientId).toBe(result.workerBefore.held[0].clientId);
            const nativeRefusal = result.nativeFocusCalls.some(call => call.clientId === result.workerBefore.client.id &&
                call.error?.name === 'InvalidAccessError' && /not allowed to focus a window/i.test(call.error.message));
            const nativeSuccess = result.nativeFocusCalls.some(call => call.clientId === result.workerBefore.client.id && call.focused === true);
            expect(result.focusAfter && nativeSuccess || nativeRefusal && result.manualFallback,
                'Return must focus the verified owner or expose the native browser refusal with manual guidance').toBe(true);
            result.outcome = result.focusAfter && nativeSuccess ? 'focus-transfer-observed' : 'native-focus-refused-manual-fallback';
            if (!result.focusAfter) await first.bringToFront();
            await expect.poll(() => second.evaluate(() => document.hidden)).toBe(true);
        }
        // An already focused primary cannot establish a successful focus transfer.
        expect(!result.focusBefore && result.focusAfter || result.manualFallback).toBe(true);
        await unchangedDemo(first, title);
        await secondary(second);
        await locks(second, result.browser === 'chromium' ? 0 : 1);
        await noWindowOpen(context, 2);
        await second.screenshot({ path: resolve(dir, 'return-result.png'), fullPage: true });
        if (result.browser === 'chromium') {
            await first.reload();
            await realVisibility(first);
            await primary(first);
            await secondary(second);
            result.afterReturnReload = await locks(first, 0);
            expect(await second.evaluate(() => window.__singleAppEvidence.roles)).not.toContain('primary');
        }
    },

    async 'real-visibility-background-reload'(context, result) {
        // Chromium only: actual background tabs, no synthetic visibility events.
        const first = await open(context);
        await realVisibility(first);
        await primary(first);
        const title = await demo(first);
        const second = await open(context);
        await realVisibility(second);
        await secondary(second);
        await second.bringToFront();
        await expect.poll(() => first.evaluate(() => document.hidden)).toBe(true);
        await expect.poll(() => second.evaluate(() => document.hidden)).toBe(false);
        result.hiddenPrimary = await locks(second, 1);
        await unchangedDemo(first, title);
        // A foreground primary leaves a background secondary outside the queue.
        await first.bringToFront();
        await expect.poll(() => second.evaluate(() => document.hidden)).toBe(true);
        result.hiddenSecondary = await locks(first, 0);
        await second.bringToFront();
        await locks(second, 1);
        await first.bringToFront();
        await expect.poll(() => first.evaluate(() => document.hasFocus() && !document.hidden)).toBe(true);
        await expect.poll(() => second.evaluate(() => document.hidden)).toBe(true);
        await locks(first, 0);
        await first.reload();
        await realVisibility(first);
        await primary(first);
        await secondary(second);
        result.afterForegroundReload = await locks(first, 0);
        // The original reload recovers without any secondary App starting.
        expect(await second.evaluate(() => window.__singleAppEvidence.roles)).not.toContain('primary');
        await noWindowOpen(context, 2);
    },

    async 'return-manual-fallback'(context, result, dir) {
        const first = await open(context);
        await primary(first);
        const second = await open(context);
        await secondary(second);
        await second.getByRole('button', { name: 'Return to KeeWebX', exact: true }).click();
        const manual = second.getByRole('status').filter({ hasText: /switch.*(?:tab|window)|manually/i });
        await expect(manual).toBeVisible();
        result.manualText = await manual.innerText();
        await secondary(second);
        await primary(first);
        await locks(second, 1);
        await noWindowOpen(context, 2);
        await second.screenshot({ path: resolve(dir, 'manual-fallback.png'), fullPage: true });
    },

    async 'classic-and-embedded-scope'(context, result) {
        const first = await open(context);
        await primary(first);
        const second = await open(context);
        await secondary(second);
        const classic = await open(context, new URL('classic.html', appUrl).href);
        const insecure = classic.getByText('I understand the risks, continue', { exact: true });
        if (await insecure.isVisible()) await insecure.click();
        await expect(classic.locator('#open__icon-demo')).toBeAttached();
        if (!await classic.locator('#open__icon-demo').isVisible()) await classic.locator('#open__icon-more').click();
        await classic.locator('#open__icon-demo').click();
        await expect(classic.locator('.list__item').first()).toBeVisible();
        await primary(first);
        await secondary(second);
        await locks(second, 1);
        result.classicDemo = 'usable alongside primary and secondary';
        // A real subframe must skip the standalone top-level gate. The App's
        // existing frame policy is explicitly enabled in this disposable context.
        await first.evaluate(() => {
            const settings = JSON.parse(localStorage.getItem('appSettings') || '{}');
            localStorage.setItem('appSettings', JSON.stringify({ ...settings, allowIframes: true }));
            const frame = document.createElement('iframe');
            frame.id = 'embedded-acceptance';
            frame.src = location.href;
            document.body.append(frame);
        });
        const frame = first.frameLocator('#embedded-acceptance');
        await expect(frame.locator('#open-demo')).toBeVisible();
        await frame.locator('#open-demo').click();
        await expect(frame.locator('.entry-row').first()).toBeVisible();
        await expect(frame.getByRole('heading', { name: 'KeeWebX is already open', exact: true })).toHaveCount(0);
        result.subframeDemo = 'usable without a competing standalone lock';
        await locks(second, 1);
        await noWindowOpen(context, 3);
    }
};

for (const name of selected) {
    let browser;
    try {
        // Full Chromium has real background tabs; headless shell leaves every
        // page visible even after disabling Playwright's focus emulation.
        browser = await engines[name].launch({ headless: true, timeout: 30_000,
            ...(name === 'chromium' ? { channel: 'chromium' } : {}) });
        for (const [title, run] of Object.entries(cases)) {
            if ((title === 'baseline') !== baseline || caseFilter && !title.includes(caseFilter)) continue;
            if (title.startsWith('real-visibility-') && name !== 'chromium') continue;
            const dir = resolve(output, name, title);
            await mkdir(dir, { recursive: true });
            const result = { browser: name, version: browser.version(), case: title, status: 'running' };
            report.results.push(result);
            console.log(`${name}: ${title}`);
            const context = await browser.newContext({
                viewport: { width: 1280, height: 800 }, colorScheme: 'light',
                serviceWorkers: title === 'return-manual-fallback' ? 'block' : 'allow'
            });
            const errors = [];
            context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
            await instrument(context);
            await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
            try {
                await run(context, result, dir);
                expect(errors, 'No unhandled App errors').toEqual([]);
                result.status = 'passed';
            } catch (error) {
                result.status = 'failed';
                result.error = String(error.stack || error);
                result.pageErrors = errors;
                result.pages = [];
                for (const [index, page] of context.pages().entries()) {
                    result.pages.push({
                        url: page.url(),
                        role: await page.locator('#root').getAttribute('data-app-instance').catch(() => null),
                        evidence: await page.evaluate(() => window.__singleAppEvidence).catch(() => null),
                        text: await page.locator('body').innerText().catch(() => '')
                    });
                    await page.screenshot({ path: resolve(dir, `failure-${index}.png`), fullPage: true }).catch(() => {});
                }
                console.error(`${name}: ${title}: ${error.message}`);
            } finally {
                await context.tracing.stop({ path: resolve(dir, 'trace.zip') });
                await context.close();
                await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
            }
        }
    } catch (error) {
        report.results.push({ browser: name, case: 'browser-launch', status: 'failed', error: String(error.stack || error) });
    } finally {
        await browser?.close();
    }
}

// This fixture packages byte-identical dist assets under a disposable extension
// origin. Only its manifest/probe are fixtures; App startup and runtime handlers
// are production code. It does not build or alter the distributed extension.
if (!baseline && selected.includes('chromium') && (!caseFilter || 'extension-origin-embedded'.includes(caseFilter))) {
    const dir = resolve(output, 'chromium', 'extension-origin-embedded');
    await mkdir(dir, { recursive: true });
    const result = { browser: 'chromium', case: 'extension-origin-embedded', status: 'running' };
    report.results.push(result);
    const fixture = await mkdtemp(resolve(tmpdir(), 'keewebx-instance-extension-'));
    let context;
    try {
        const built = resolve(process.env.KW_SINGLE_APP_DIST || fileURLToPath(new URL('../../../dist', import.meta.url)));
        const extension = resolve(fixture, 'extension');
        await mkdir(extension);
        await cp(built, resolve(extension, 'app'), { recursive: true });
        const copiedHash = createHash('sha256').update(await readFile(resolve(extension, 'app/js/next.js'))).digest('hex');
        expect(copiedHash, 'Embedded extension uses the exact served New UI bundle').toBe(report.sha256['js/next.js']);
        await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({
            manifest_version: 3, name: 'Built UI acceptance probe', version: '1.0.0',
            background: { service_worker: 'probe.js' },
            content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }
        }));
        await writeFile(resolve(extension, 'probe.js'), 'chrome.runtime.onInstalled.addListener(() => {});\n');
        await writeFile(resolve(extension, 'probe.html'), '<!doctype html><title>Embedded runtime probe</title>');
        context = await chromium.launchPersistentContext(resolve(fixture, 'profile'), {
            channel: 'chromium', headless: true, timeout: 30_000,
            args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
        });
        await instrument(context);
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 12_000 });
        const id = new URL(worker.url()).host;
        const app = await open(context, `chrome-extension://${id}/app/next.html?embedded=offscreen`);
        await expect(app.locator('#open-demo')).toBeVisible();
        await expect(app.locator('#root')).not.toHaveAttribute('data-app-instance', /checking|primary|secondary|error/);
        const probe = await open(context, `chrome-extension://${id}/probe.html`);
        result.ping = await probe.evaluate(() => chrome.runtime.sendMessage({ vault: 'ping', vaultContext: 'offscreen' }));
        expect(result.ping).toEqual({ ok: true, result: { ready: true } });
        result.statusResponse = await probe.evaluate(() => chrome.runtime.sendMessage({ vault: 'status', vaultContext: 'offscreen' }));
        expect(result.statusResponse.ok).toBe(true);
        expect(result.statusResponse.result.open).toBe(false);
        result.scope = 'Exact web bundle starts under an extension origin and answers real embedded ping/status. Extension Demo decryption requires the packaged Argon2 worker supplied by the separate extension build.';
        result.instanceLocks = await app.evaluate(async () => (await navigator.locks.query()).held.filter(lock => lock.name.startsWith('keewebx-app-instance-v1:')));
        expect(result.instanceLocks).toEqual([]);
        await app.screenshot({ path: resolve(dir, 'embedded-startup.png'), fullPage: true });
        result.status = 'passed';
    } catch (error) {
        result.status = 'failed';
        result.error = String(error.stack || error);
        console.error(`chromium: extension-origin-embedded: ${error.message}`);
    } finally {
        if (context) {
            await context.tracing.stop({ path: resolve(dir, 'trace.zip') });
            await context.close();
        }
        await rm(fixture, { recursive: true, force: true });
    }
}
report.finalSha256 = await fingerprint();
if (JSON.stringify(report.sha256) !== JSON.stringify(report.finalSha256)) {
    report.results.push({ case: 'immutable-build', status: 'failed', error: 'Served build changed during acceptance; rerun against the completed build.' });
}
if (!report.results.length) throw new Error('No cases selected');
await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`${report.results.filter(result => result.status === 'passed').length}/${report.results.length} passed; evidence: ${output}`);
if (report.results.some(result => result.status !== 'passed')) process.exitCode = 1;
