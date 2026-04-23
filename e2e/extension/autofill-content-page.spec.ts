import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * Extension autofill debug — loads the built KeeWebX Connect extension
 * as an unpacked Chrome extension and directly exercises the content-page.js
 * `auto-fill` message handler on a minimal test form. This bypasses the
 * entire backend.getLogins + KeeWebX modal flow and isolates whether the
 * form-fill logic itself works.
 *
 * Why this exists: the 2026-04-09 second warroom reached a state where
 * KeeWebX's side of the protocol was proven 100% correct (entries
 * returned with real login/password values), but the user still saw the
 * login form stay empty after clicking through the picker. We need to
 * determine:
 *
 *   (a) Does content-page.js's autoFill() actually write to input.value
 *       when called with a valid message? → tests form-fill in isolation
 *
 *   (b) If (a) works, is the bug upstream in the commands.ts flow —
 *       URL mismatch at content-page.ts:27, tab-switch breaking
 *       activeElement, etc.?
 *
 * This spec is only the (a) test. It does not start KeeWebX, does not
 * need a running dev server, does not do crypto handshakes. It just
 * loads the extension, opens a trivial HTML form, focuses the username
 * input, and asks the service worker to dispatch auto-fill via
 * chrome.tabs.sendMessage. Then it reads back the form input values.
 *
 * If this test PASSES: content-page.js is correct, the real bug is in
 * the commands.ts flow (tab switch, URL match, or chrome.scripting
 * injection timing). That narrows the investigation dramatically.
 *
 * If this test FAILS: content-page.js has a bug in its autoFill logic
 * and we can fix it directly in our fork.
 */

const EXT_PATH = path.resolve(__dirname, '../../packages/extension/dist/chrome');

// Minimal login form served as a data URL. Two inputs, same form, no
// JS, no frameworks, no CSP, no redirects. If autoFill can't fill
// this, it can't fill anything.
const TEST_FORM_HTML = `
<!DOCTYPE html>
<html><head><title>Test Login</title></head><body>
<h1>Test Login Form</h1>
<form id="login">
  <input type="text" id="username" name="username" />
  <input type="password" id="password" name="password" />
  <button type="submit">Sign in</button>
</form>
<div id="status">idle</div>
</body></html>
`;

test.describe('Extension content-page autoFill (isolation test)', () => {
    test('content-page.js fills username + password on a vanilla form', async () => {
        // Verify the extension is built before launching
        expect(fs.existsSync(path.join(EXT_PATH, 'manifest.json')),
            `extension must be built first: cd packages/extension && bun run build-chrome`).toBe(true);
        expect(fs.existsSync(path.join(EXT_PATH, 'js/content-page.js'))).toBe(true);

        // Playwright extension loading requires persistent context + headed
        // (or the "new" headless mode). Using a disposable tmp profile.
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-ext-test-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${EXT_PATH}`,
                `--load-extension=${EXT_PATH}`
            ]
        });

        try {
            // Wait for the service worker to spin up. For MV3 extensions
            // Playwright exposes them via context.serviceWorkers() and a
            // 'serviceworker' event.
            let [sw] = context.serviceWorkers();
            if (!sw) {
                sw = await context.waitForEvent('serviceworker');
            }
            expect(sw, 'extension service worker must be loaded').toBeTruthy();

            // Get the extension id so we can cross-check from the test
            const extId = sw.url().split('/')[2];
            // eslint-disable-next-line no-console
            console.log('Extension ID:', extId);

            // Open the test form as an http-served page. data: URLs don't
            // get content scripts injected reliably, so we serve it via a
            // temp file:// url instead — content scripts work on file://
            // when the extension has <all_urls> host permission.
            const tmpHtmlPath = path.join(userDataDir, 'test-login.html');
            fs.writeFileSync(tmpHtmlPath, TEST_FORM_HTML);
            const formPage = await context.newPage();
            await formPage.goto('file://' + tmpHtmlPath);
            await formPage.waitForLoadState('networkidle');

            // Focus the username input — this matches the real user
            // workflow (KeeWeb Connect fills whatever input has focus)
            await formPage.focus('#username');
            const activeTag = await formPage.evaluate(
                () => (document.activeElement as HTMLElement | null)?.tagName
            );
            expect(activeTag, 'username input must be focused before dispatch').toBe('INPUT');

            // Get the form page's tab id via Chrome APIs in the service
            // worker (Playwright exposes this through evaluate in the SW)
            const formUrl = formPage.url();
            const dispatchResult = await sw.evaluate(async (targetUrl) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const chromeApi = (globalThis as any).chrome;
                const tabs = await chromeApi.tabs.query({ url: targetUrl });
                if (!tabs.length) {
                    return { error: 'no matching tab for url ' + targetUrl };
                }
                const tab = tabs[0];

                // Inject content-page.js (mimics what commands.ts does)
                await chromeApi.scripting.executeScript({
                    files: ['js/content-page.js'],
                    target: { tabId: tab.id, allFrames: true }
                });

                // Send the auto-fill message, same payload shape as
                // what runCommand() in commands.ts would have sent.
                // This is the ONLY simulated piece — in real usage the
                // URL and text/password come from backend.getLogins.
                return new Promise((resolve) => {
                    chromeApi.tabs.sendMessage(
                        tab.id,
                        {
                            action: 'auto-fill',
                            url: targetUrl,
                            text: 'gynet.gy@gmail.com',
                            password: 'TestPassword123!',
                            submit: false
                        },
                        { frameId: 0 },
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        (resp: any) => {
                            const lastError = chromeApi.runtime.lastError;
                            resolve({
                                ok: !lastError,
                                resp,
                                error: lastError?.message
                            });
                        }
                    );
                });
            }, formUrl);

            // eslint-disable-next-line no-console
            console.log('Dispatch result:', JSON.stringify(dispatchResult));

            // Give the content script a moment to process before reading
            await formPage.waitForTimeout(500);

            // Read the actual values in the form — this is the moment of
            // truth. If autoFill worked, username should contain the
            // gynet email and password the TestPassword123!
            const formValues = await formPage.evaluate(() => ({
                usernameValue: (document.getElementById('username') as HTMLInputElement).value,
                passwordValue: (document.getElementById('password') as HTMLInputElement).value,
                activeElementTag: (document.activeElement as HTMLElement | null)?.tagName,
                activeElementValue: (document.activeElement as HTMLInputElement | null)?.value
            }));
            // eslint-disable-next-line no-console
            console.log('Form values after dispatch:', JSON.stringify(formValues));

            expect(
                formValues.usernameValue,
                `username input should be filled. dispatchResult=${JSON.stringify(dispatchResult)}`
            ).toBe('gynet.gy@gmail.com');
            expect(
                formValues.passwordValue,
                `password input should be filled`
            ).toBe('TestPassword123!');
        } finally {
            await context.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });
});
