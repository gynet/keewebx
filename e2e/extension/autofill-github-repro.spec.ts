import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * GitHub autofill reproduction test — the closest thing to the user's
 * actual failing workflow we can reproduce in Playwright without
 * installing the extension into the user's real browser.
 *
 * This test:
 *   1. Loads our fork of KeeWebX Connect as an unpacked extension
 *   2. Navigates to the REAL https://github.com/login page
 *   3. Focuses the username (login_field) input
 *   4. Dispatches an auto-fill message from the extension service worker
 *      to the github.com tab's content-page.js, with a known
 *      username/password pair — same message shape that commands.ts
 *      runCommand() builds after backend.getLogins() returns entries.
 *   5. Reads the form values back and asserts they were filled.
 *
 * The backend.getLogins() path is bypassed on purpose: we ALREADY know
 * from the 2026-04-09 warroom user log that get-logins returns valid
 * entries end-to-end. What we don't know is whether content-page.js's
 * autoFill() can actually write to github.com's login form inputs.
 * This test isolates that step.
 *
 * If this test passes: content-page.js works on github.com. The user's
 *   bug is somewhere else (URL mismatch, tab switch focus loss,
 *   content-page.js not injected — check those).
 *
 * If this test fails: we have a repro on master. We can iterate on
 *   content-page.ts in a tight loop (edit → rebuild → rerun) without
 *   bouncing work back to the user.
 */

const EXT_PATH = path.resolve(__dirname, '../../packages/extension/dist/chrome');

test.describe('Extension autofill on real github.com', () => {
    test('autoFill writes username + password to github.com/login form', async () => {
        expect(fs.existsSync(path.join(EXT_PATH, 'manifest.json')),
            `extension must be built: cd packages/extension && bun run build-chrome`).toBe(true);

        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-ext-gh-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${EXT_PATH}`,
                `--load-extension=${EXT_PATH}`
            ]
        });

        try {
            // Service worker spin-up
            let [sw] = context.serviceWorkers();
            if (!sw) {
                sw = await context.waitForEvent('serviceworker');
            }
            expect(sw).toBeTruthy();

            // Open real github.com/login in a real tab
            const githubPage = await context.newPage();
            const consoleLogs: string[] = [];
            githubPage.on('console', (msg) => {
                consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
            });
            githubPage.on('pageerror', (err) => {
                consoleLogs.push(`[pageerror] ${err.message}`);
            });

            await githubPage.goto('https://github.com/login', {
                waitUntil: 'domcontentloaded',
                timeout: 30_000
            });

            // GitHub's login inputs:
            //   - username/email:  <input id="login_field">
            //   - password:        <input id="password">
            // Both live inside <form action="/session">.
            await githubPage.waitForSelector('#login_field', { timeout: 10_000 });
            await githubPage.focus('#login_field');

            // Sanity check: the focused element is the login input.
            const focusedBefore = await githubPage.evaluate(() => ({
                tag: document.activeElement?.tagName,
                id: (document.activeElement as HTMLElement | null)?.id,
                locationHref: location.href
            }));
            expect(focusedBefore.tag).toBe('INPUT');
            expect(focusedBefore.id).toBe('login_field');
            // eslint-disable-next-line no-console
            console.log('Before dispatch:', JSON.stringify(focusedBefore));

            const realLocationHref = focusedBefore.locationHref;
            const TEST_USERNAME = 'gynet.gy@gmail.com';
            const TEST_PASSWORD = 'testpassword-no-real-use';

            // Find the tab id that matches github in the service worker
            // (need this to call chrome.scripting + sendMessage)
            const dispatchResult = await sw.evaluate(
                async ({ targetUrl, username, password }) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const chromeApi = (globalThis as any).chrome;
                    const tabs = await chromeApi.tabs.query({});
                    const tab = tabs.find(
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        (t: any) => t.url === targetUrl || t.url?.startsWith('https://github.com/login')
                    );
                    if (!tab) {
                        return { error: 'no github tab found', tabs: tabs.map(
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            (t: any) => t.url) };
                    }

                    // Inject content-page.js — same thing commands.ts does
                    try {
                        await chromeApi.scripting.executeScript({
                            files: ['js/content-page.js'],
                            target: { tabId: tab.id, allFrames: true }
                        });
                    } catch (e) {
                        return { error: 'scripting.executeScript failed: ' + (e as Error).message };
                    }

                    // Small delay to let content-page listener attach
                    await new Promise((r) => setTimeout(r, 200));

                    // Send the auto-fill message, same shape as the one
                    // runCommand() sends after backend.getLogins()
                    return new Promise<unknown>((resolve) => {
                        chromeApi.tabs.sendMessage(
                            tab.id,
                            {
                                action: 'auto-fill',
                                url: tab.url,
                                text: username,
                                password,
                                submit: false
                            },
                            { frameId: 0 },
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            (resp: any) => {
                                const lastError = chromeApi.runtime.lastError;
                                resolve({
                                    tabId: tab.id,
                                    tabUrl: tab.url,
                                    sendMessageOk: !lastError,
                                    sendMessageError: lastError?.message,
                                    resp
                                });
                            }
                        );
                    });
                },
                { targetUrl: realLocationHref, username: TEST_USERNAME, password: TEST_PASSWORD }
            );
            // eslint-disable-next-line no-console
            console.log('Dispatch result:', JSON.stringify(dispatchResult));

            // Give the content script time to run
            await githubPage.waitForTimeout(1500);

            // Read form values from the page
            const formState = await githubPage.evaluate(() => ({
                loginFieldValue: (document.getElementById('login_field') as HTMLInputElement).value,
                passwordValue: (document.getElementById('password') as HTMLInputElement).value,
                activeTag: document.activeElement?.tagName,
                activeId: (document.activeElement as HTMLElement | null)?.id
            }));
            // eslint-disable-next-line no-console
            console.log('Form state:', JSON.stringify(formState));
            // eslint-disable-next-line no-console
            console.log('Console logs from github tab:', consoleLogs.filter(
                (l) => l.includes('NKW-Connect') || l.includes('error')
            ).join('\n'));

            expect(
                formState.loginFieldValue,
                `username field should contain "${TEST_USERNAME}". ` +
                    `Dispatch result: ${JSON.stringify(dispatchResult)}. ` +
                    `Content-page logs: ${consoleLogs.filter((l) => l.includes('NKW-Connect')).join(' ; ')}`
            ).toBe(TEST_USERNAME);
            expect(
                formState.passwordValue,
                `password field should contain the test password`
            ).toBe(TEST_PASSWORD);
        } finally {
            await context.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });
});
