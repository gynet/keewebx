#!/usr/bin/env bun
/**
 * Headless Firefox full-chain autofill regression guard.
 *
 * Installs the unsigned Firefox build as a temporary add-on, configures
 * its options page, loads the KeeWebX demo database, and invokes the
 * production invoke-action-click RPC against the real GitHub login form.
 * Both fields must be filled through runCommand and the encrypted vault
 * protocol; the harness only blocks submission, never supplies credentials.
 *
 * Prerequisites: geckodriver 0.36+, Firefox 149+, the built Firefox zip at
 * modules/extension/web-ext-artifacts/keewebx_connect-1.0.3.zip, and the
 * classic UI dev server (bun run --filter @keewebx/ui-classic dev).
 *
 * Run: bun run e2e/extension/autofill-firefox-full-chain.mjs
 * FIREFOX_BINARY overrides browser discovery on every platform.
 * FIREFOX_VERSION, when set, must match the launched browser version.
 * GECKODRIVER_BINARY optionally selects a specific geckodriver executable.
 * KEEWEBX_URL defaults to http://localhost:8085/.
 */

import { Builder, By, until } from 'selenium-webdriver';
import firefoxMod from 'selenium-webdriver/firefox.js';
import path from 'node:path';
import fs from 'node:fs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const XPI = path.resolve(
    REPO_ROOT,
    'modules/extension/web-ext-artifacts/keewebx_connect-1.0.3.zip'
);
const KEEWEBX_URL = process.env.KEEWEBX_URL || 'http://localhost:8085/';
const FF_BIN_MAC = '/Applications/Firefox.app/Contents/MacOS/firefox';

function fail(msg) {
    // Throw so failures after launch always reach driver.quit().
    throw new Error(msg);
}

function ok(msg) {
    console.log('  ✓', msg);
}

let driver;
let exitCode = 0;
try {
    if (!fs.existsSync(XPI)) {
        fail(
            `firefox xpi missing at ${XPI}. Build with: ` +
                `cd modules/extension && bun run build-firefox`
        );
    }

    const r = await fetch(KEEWEBX_URL, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) fail(`KeeWebX dev server at ${KEEWEBX_URL} returned ${r.status}`);
    ok(`KeeWebX dev server reachable at ${KEEWEBX_URL}`);

    const opts = new firefoxMod.Options();
    if (process.env.FIREFOX_BINARY) {
        opts.setBinary(process.env.FIREFOX_BINARY);
    } else if (process.platform === 'darwin' && fs.existsSync(FF_BIN_MAC)) {
        opts.setBinary(FF_BIN_MAC);
    }
    opts.setPreference('xpinstall.signatures.required', false);
    opts.setPreference('extensions.logging.enabled', true);
    opts.setPreference('browser.shell.checkDefaultBrowser', false);
    opts.addArguments('--headless');

    // Required since Firefox 138 for the privileged UUID lookup below.
    // https://firefox-source-docs.mozilla.org/testing/geckodriver/Flags.html
    const service = new firefoxMod.ServiceBuilder(process.env.GECKODRIVER_BINARY)
        .addArguments('--allow-system-access')
        .setEnvironment({ ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' });
    driver = await new Builder()
        .forBrowser('firefox')
        .setFirefoxOptions(opts)
        .setFirefoxService(service)
        .build();
    await driver.manage().setTimeouts({ pageLoad: 60_000, script: 20_000 });

    const ver = (await driver.getCapabilities()).get('browserVersion');
    ok(`Firefox launched (v${ver}, binary: ${process.env.FIREFOX_BINARY || 'auto'})`);
    if (process.env.FIREFOX_VERSION && ver !== process.env.FIREFOX_VERSION) {
        fail(`Expected Firefox ${process.env.FIREFOX_VERSION}, launched ${ver}`);
    }

    const addonId = await driver.installAddon(XPI, true);
    if (!addonId) fail('Temporary add-on installation returned no ID');
    ok(`Extension installed as temporary add-on: ${addonId}`);

    // Resolve this installed add-on's active policy, not a browser UI label
    // or a UUID belonging to another extension. Restore content context even
    // when lookup fails; all remaining operations use ordinary tab content.
    let internalUuid;
    try {
        await driver.setContext('chrome');
        internalUuid = await driver.wait(
            () => driver.executeScript(`
                const policy = WebExtensionPolicy.getByID(arguments[0]);
                return policy ? policy.mozExtensionHostname : null;
            `, addonId),
            10_000,
            `No active extension policy for installed add-on ${addonId}`
        );
    } finally {
        await driver.setContext('content');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(internalUuid)) {
        fail(`Invalid internal UUID for ${addonId}: ${internalUuid}`);
    }
    ok(`Extension internal UUID: ${internalUuid}`);

    const optionsUrl = `moz-extension://${internalUuid}/pages/options.html`;
    await driver.get(optionsUrl);
    const optionsHandle = await driver.getWindowHandle();
    await driver.wait(
        () => driver.executeScript(`
            return typeof chrome !== 'undefined' && chrome.runtime?.id === arguments[0];
        `, addonId),
        10_000,
        'Installed extension options API did not become ready'
    );
    // Pass the URL as data, and wait for persistence before opening the vault.
    await driver.executeScript(`
        return new Promise((resolve, reject) => {
            const url = arguments[0];
            chrome.storage.local.set({ keeWebUrl: url }, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                chrome.storage.local.get('keeWebUrl', (data) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else if (data.keeWebUrl !== url) {
                        reject(new Error('keeWebUrl was not persisted'));
                    } else {
                        resolve(true);
                    }
                });
            });
        });
    `, KEEWEBX_URL);
    ok(`keeWebUrl configured to ${KEEWEBX_URL}`);

    await driver.switchTo().newWindow('tab');
    await driver.get(KEEWEBX_URL);
    const keewebxHandle = await driver.getWindowHandle();
    await driver.wait(until.elementLocated(By.css('#open__icon-demo')), 60_000);
    await driver.findElement(By.css('#open__icon-demo')).click();
    await driver.wait(until.elementLocated(By.css('.list__item')), 60_000);
    ok('KeeWebX demo database loaded');

    await driver.switchTo().newWindow('tab');
    await driver.get('https://github.com/login');
    const githubHandle = await driver.getWindowHandle();
    await driver.wait(until.elementLocated(By.id('login_field')), 15_000);
    await driver.wait(until.elementLocated(By.id('password')), 15_000);
    await driver.findElement(By.id('login_field')).click();
    await driver.executeScript(`
        const login = document.getElementById('login_field');
        const password = document.getElementById('password');
        if (login.value || password.value) {
            throw new Error('GitHub fields must start empty before extension autofill');
        }
        const form = login.form;
        if (!form || password.form !== form) {
            throw new Error('GitHub login form not found');
        }
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
        }, { capture: true });
    `);
    ok('github.com/login loaded with empty fields; submission blocked');

    await driver.switchTo().window(optionsHandle);
    const githubTabId = await driver.executeScript(`
        return new Promise((resolve, reject) => {
            chrome.tabs.query({ url: 'https://github.com/login*' }, (tabs) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else if (tabs.length !== 1) {
                    reject(new Error('Expected exactly one GitHub login tab'));
                } else {
                    resolve(tabs[0].id);
                }
            });
        });
    `);
    if (!Number.isInteger(githubTabId)) fail('GitHub tab has no numeric ID');

    // Do not await the RPC here: runCommand waits for the permission modal.
    // Keep its eventual response on this options page and assert it below.
    await driver.executeScript(`
        window.__keewebxAutofillResult = null;
        chrome.runtime.sendMessage({
            action: 'invoke-action-click', tabId: arguments[0]
        }, (response) => {
            window.__keewebxAutofillResult = chrome.runtime.lastError
                ? { error: chrome.runtime.lastError.message }
                : (response || { error: 'No response from invoke-action-click' });
        });
    `, githubTabId);
    ok(`invoke-action-click dispatched for GitHub tab ${githubTabId}`);

    await driver.switchTo().window(keewebxHandle);
    const allowBtn = await driver.wait(
        until.elementLocated(By.css("button[data-result='yes']")),
        20_000,
        'Fresh Firefox profile must show the KeeWebX permission modal'
    );
    await driver.wait(until.elementIsVisible(allowBtn), 10_000);
    await allowBtn.click();
    ok('Permission modal Allow clicked');

    await driver.switchTo().window(optionsHandle);
    const dispatchResult = await driver.wait(
        () => driver.executeScript('return window.__keewebxAutofillResult;'),
        20_000,
        'invoke-action-click did not complete'
    );
    if (dispatchResult.ok !== true || dispatchResult.error) {
        fail(`invoke-action-click failed: ${JSON.stringify(dispatchResult)}`);
    }
    ok('invoke-action-click completed successfully');

    await driver.switchTo().window(githubHandle);
    await driver.wait(async () => {
        const loginValue = await driver.findElement(By.id('login_field')).getAttribute('value');
        const passwordValue = await driver.findElement(By.id('password')).getAttribute('value');
        return Boolean(loginValue && passwordValue);
    }, 15_000, 'Both GitHub fields must be filled by the full-chain extension flow');

    // Keep separate assertions so neither field can be silently omitted.
    const loginValue = await driver.findElement(By.id('login_field')).getAttribute('value');
    const passwordValue = await driver.findElement(By.id('password')).getAttribute('value');
    if (!loginValue) fail('login_field is empty after full-chain dispatch');
    if (!passwordValue) fail('password is empty after full-chain dispatch');
    ok('Both fields filled by full-chain extension flow');
    ok('PASS — Firefox full-chain autofill works end-to-end');
} catch (e) {
    console.error('TEST ERROR:', e.message);
    console.error(e.stack);
    exitCode = 1;
} finally {
    if (driver) {
        await driver.quit().catch((e) => {
            console.error('Firefox cleanup failed:', e.message);
            exitCode = 1;
        });
    }
}
process.exitCode = exitCode;
