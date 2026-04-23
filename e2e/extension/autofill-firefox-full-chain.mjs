#!/usr/bin/env bun
/**
 * FULL-CHAIN extension autofill regression guard for Firefox.
 *
 * Why this lives here as a standalone Bun script instead of inside
 * Playwright: Playwright's bundled Firefox enforces xpi signature
 * verification even with `xpinstall.signatures.required=false`,
 * so we cannot load our unsigned development xpi via
 * `firefox.launchPersistentContext`. Selenium WebDriver + geckodriver
 * does support `driver.installAddon(xpi, true)` where the second arg
 * is the "temporary" flag, so we drive Firefox via that.
 *
 * The test mirrors `autofill-full-chain.spec.ts` (Chromium) one-for-one:
 *
 *   1. Launch Firefox 149 with the built `.xpi` installed as a
 *      Temporary Add-on
 *   2. Set `keeWebUrl` in extension storage to localhost:8085
 *   3. Open KeeWebX dev server, click Demo, wait for unlock
 *   4. Open github.com/login, focus #login_field, block form submit
 *   5. Trigger `chrome.action.onClicked.dispatch(tab)` from the
 *      extension background page (Firefox MV3 uses `background.scripts`,
 *      so the background page is a real DOM page accessible via
 *      driver.setContext('chrome') or by navigating Marionette)
 *   6. Click the "Allow" button on KeeWebX's permission modal
 *   7. Wait for #login_field to fill
 *   8. Assert both fields populated
 *
 * Run as:
 *   bun run e2e/extension/autofill-firefox-full-chain.mjs
 *
 * Exit code 0 = pass, non-zero = fail. CI calls this directly.
 *
 * Prerequisites:
 *   - geckodriver installed (`brew install geckodriver` on macOS,
 *     `apt-get install firefox-geckodriver` on Ubuntu)
 *   - selenium-webdriver in devDependencies (already added 2026-04-09)
 *   - Firefox 149+ at /Applications/Firefox.app on macOS,
 *     `firefox` in PATH on Linux
 *   - KeeWebX dev server running on http://localhost:8085 (start
 *     with `bun run --filter @keewebx/core dev` in another terminal,
 *     OR let the test fail with a clear error)
 *   - Built firefox xpi at packages/extension/web-ext-artifacts/
 *     keewebx_connect-1.0.3.zip (cd packages/extension && bun run
 *     build-firefox)
 */

import { Builder, By, until } from 'selenium-webdriver';
import firefoxMod from 'selenium-webdriver/firefox.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const XPI = path.resolve(
    REPO_ROOT,
    'packages/extension/web-ext-artifacts/keewebx_connect-1.0.3.zip'
);
const KEEWEBX_URL = process.env.KEEWEBX_URL || 'http://localhost:8085/';
const FF_BIN_MAC = '/Applications/Firefox.app/Contents/MacOS/firefox';

function fail(msg) {
    console.error('FAIL:', msg);
    process.exit(1);
}

function ok(msg) {
    console.log('  ✓', msg);
}

if (!fs.existsSync(XPI)) {
    fail(
        `firefox xpi missing at ${XPI}. Build with: ` +
            `cd packages/extension && bun run build-firefox`
    );
}

// Quick liveness check on the dev server before spending 10s on
// Firefox launch. Saves debugging confusion when the dev server is
// down.
try {
    const r = await fetch(KEEWEBX_URL, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) fail(`KeeWebX dev server at ${KEEWEBX_URL} returned ${r.status}`);
    ok(`KeeWebX dev server reachable at ${KEEWEBX_URL}`);
} catch (e) {
    fail(
        `KeeWebX dev server at ${KEEWEBX_URL} unreachable: ${e.message}. ` +
            `Start it with: bun run --filter @keewebx/core dev`
    );
}

const opts = new firefoxMod.Options();
if (fs.existsSync(FF_BIN_MAC)) {
    opts.setBinary(FF_BIN_MAC);
}
opts.setPreference('xpinstall.signatures.required', false);
opts.setPreference('extensions.logging.enabled', true);
opts.setPreference('browser.shell.checkDefaultBrowser', false);
// Headless mode for CI; comment out to debug visually:
if (process.env.HEADLESS !== '0') {
    opts.addArguments('--headless');
}

const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();

let exitCode = 0;
try {
    const ver = await driver
        .getCapabilities()
        .then((c) => c.get('browserVersion'));
    ok(`Firefox launched (v${ver})`);

    // Install extension as Temporary Add-on (geckodriver supports this
    // for unsigned xpis when xpinstall.signatures.required=false)
    await driver.installAddon(XPI, true);
    ok('Extension installed as temporary add-on');

    // Give the extension's background page a moment to spin up
    await new Promise((r) => setTimeout(r, 2000));

    // 1. Open KeeWebX dev server
    await driver.get(KEEWEBX_URL);
    const neowebHandle = await driver.getWindowHandle();
    await driver.wait(until.elementLocated(By.css('#open__icon-demo')), 15_000);
    await driver.findElement(By.css('#open__icon-demo')).click();
    await driver.wait(until.elementLocated(By.css('.list__item')), 20_000);
    ok('KeeWebX demo database loaded');

    // 2. Configure extension keeWebUrl via the extension's
    //    background. We need to access chrome.storage.local. The way
    //    to do this in Firefox WebDriver: switch to chrome context
    //    + execute privileged JS via Marionette.
    //
    //    Selenium-firefox's installAddon returns the addon ID; we
    //    use that to find the moz-extension://<uuid>/ origin.
    //    But we need the runtime UUID (random per install), not the
    //    gecko id. Easiest path: open the options page and execute
    //    chrome.storage.local.set from there. Options page has full
    //    extension API access.
    //
    //    Actually simplest: navigate to about:debugging, scrape the
    //    extension's "Internal UUID" from the DOM, build the
    //    moz-extension URL, navigate to options, execute storage set.
    const debuggingTab = await driver.switchTo().newWindow('tab');
    await driver.get('about:debugging#/runtime/this-firefox');
    await new Promise((r) => setTimeout(r, 1500));
    // Scrape internal UUID — the extension page lists each addon
    // with its "Internal UUID". Selector is fragile across Firefox
    // versions; we use a generic match for our gecko id then walk up.
    const internalUuid = await driver
        .executeScript(`
            // The about:debugging page is a privileged page; scrape
            // visible text for our addon name + Internal UUID.
            const root = document.body;
            const text = root.innerText || '';
            // Match: "Internal UUID\\n<uuid>" near "KeeWebX Connect"
            const m = text.match(/Internal UUID\\s*([0-9a-f-]{36})/i);
            return m ? m[1] : null;
        `)
        .catch(() => null);
    if (!internalUuid) {
        fail(
            'Could not scrape extension Internal UUID from about:debugging. ' +
                'Firefox UI may have changed; update the scraper selector.'
        );
    }
    ok(`Extension internal UUID: ${internalUuid}`);

    const optionsUrl = `moz-extension://${internalUuid}/pages/options.html`;
    await driver.get(optionsUrl);
    await new Promise((r) => setTimeout(r, 1000));
    // Execute on the options page (which is a moz-extension:// page
    // with full chrome.* API access)
    await driver.executeScript(`
        return new Promise((resolve) => {
            chrome.storage.local.set({keeWebUrl: '${KEEWEBX_URL}'}, () => resolve(true));
        });
    `);
    ok('keeWebUrl configured to localhost:8085');

    // 3. Switch back to KeeWebX tab (still has demo loaded)
    await driver.switchTo().window(neowebHandle);

    // 4. Open github.com/login in a new tab
    await driver.switchTo().newWindow('tab');
    await driver.get('https://github.com/login');
    const githubHandle = await driver.getWindowHandle();
    await driver.wait(until.elementLocated(By.id('login_field')), 15_000);
    await driver.findElement(By.id('login_field')).click();
    ok('github.com/login loaded, focus on login_field');

    // Block form submit so the form-fill values survive for verification
    await driver.executeScript(`
        const form = document.querySelector('form');
        if (form) {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                e.stopImmediatePropagation();
            }, {capture: true});
        }
    `);

    // 5. Trigger chrome.action.onClicked.dispatch from the extension
    //    background page. Firefox MV3 with our manifest patch uses
    //    background.scripts (not service_worker), so the background
    //    is a real DOM page accessible via the moz-extension:// URL,
    //    NOT via context.serviceWorkers().
    //
    //    Easiest path to background: navigate to a moz-extension://
    //    URL that has chrome.* API access (the options page works,
    //    but we're not on it anymore). Just open a NEW tab, navigate
    //    to about:debugging → click "Inspect" on the addon → that
    //    opens a devtools window for the bg page. Too clunky for a
    //    test.
    //
    //    Better: from any moz-extension:// page, we have chrome.tabs
    //    + chrome.scripting API. We can navigate to the options page
    //    again and dispatch from there, since options page shares the
    //    same extension's chrome.action.onClicked event registry.
    const githubTabId = await (async () => {
        // Switch to options page to get chrome.tabs API
        await driver.switchTo().newWindow('tab');
        await driver.get(optionsUrl);
        await new Promise((r) => setTimeout(r, 500));
        const tabs = await driver.executeScript(`
            return new Promise((resolve) => {
                chrome.tabs.query({}, (tabs) => {
                    resolve(tabs.map(t => ({id: t.id, url: t.url})));
                });
            });
        `);
        const t = tabs.find((tab) => tab.url?.startsWith('https://github.com/login'));
        if (!t) fail(`No github tab found in tabs: ${JSON.stringify(tabs)}`);
        return t.id;
    })();
    ok(`github tab id: ${githubTabId}`);

    // Now invoke runCommand via the `invoke-action-click` RPC exposed
    // by background/init.ts. Firefox 149 does not expose
    // chrome.action.onClicked.dispatch, so we use runtime.sendMessage
    // to reach the background listener. Same mechanism used by
    // autofill-full-chain.spec.ts for Chromium — portable.
    const dispatchResult = await driver.executeScript(`
        return new Promise((resolve) => {
            chrome.tabs.query({}, (tabs) => {
                const tab = tabs.find(t => t.url?.startsWith('https://github.com/login'));
                if (!tab) {
                    resolve({error: 'no github tab'});
                    return;
                }
                // Fire and forget — runCommand is async and will still
                // be running when sendMessage returns. Test polls the
                // github form for filled values.
                chrome.runtime.sendMessage({
                    action: 'invoke-action-click',
                    tabId: tab.id
                });
                resolve({dispatched: true, tabId: tab.id});
            });
        });
    `);
    console.log('  dispatch result:', JSON.stringify(dispatchResult));
    if (dispatchResult.error) {
        fail(`dispatch failed: ${dispatchResult.error}`);
    }
    ok('chrome.action.onClicked.dispatch fired');

    // 6. Switch to KeeWebX tab and click the permission modal "Allow"
    await driver.switchTo().window(neowebHandle);
    await new Promise((r) => setTimeout(r, 1500));
    try {
        const allowBtn = await driver.wait(
            until.elementLocated(By.css("button[data-result='yes']")),
            6_000
        );
        await allowBtn.click();
        ok('Permission modal Allow clicked');
    } catch {
        ok('Permission modal not present (may be cached) — continuing');
    }

    // 7. Wait for the github tab's #login_field to fill
    await driver.switchTo().window(githubHandle);
    await driver.wait(async () => {
        const v = await driver
            .findElement(By.id('login_field'))
            .getAttribute('value');
        return v && v.length > 0;
    }, 15_000);

    // 8. Assert both fields populated
    const loginValue = await driver
        .findElement(By.id('login_field'))
        .getAttribute('value');
    const passwordValue = await driver
        .findElement(By.id('password'))
        .getAttribute('value');
    console.log(`  login_field.value = ${JSON.stringify(loginValue)}`);
    console.log(`  password.value    = ${JSON.stringify(passwordValue)}`);
    if (!loginValue || loginValue.length === 0) {
        fail('login_field is empty after full-chain dispatch');
    }
    if (!passwordValue || passwordValue.length === 0) {
        fail('password is empty after full-chain dispatch');
    }
    ok('Both fields filled by full-chain extension flow');
    ok('PASS — Firefox full-chain autofill works end-to-end');
} catch (e) {
    console.error('TEST ERROR:', e.message);
    console.error(e.stack);
    exitCode = 1;
} finally {
    await driver.quit().catch(() => {});
}
process.exit(exitCode);
