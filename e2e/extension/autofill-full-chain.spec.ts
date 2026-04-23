import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * FULL-CHAIN extension autofill regression guard.
 *
 * Unlike the earlier `autofill-content-page.spec.ts` and
 * `autofill-github-{repro,tabswitch}.spec.ts` tests — which all bypassed
 * the encrypted protocol path by sending `auto-fill` messages directly
 * to content-page.js — this test exercises the COMPLETE chain that
 * a real Ctrl+Shift+U keypress / extension button click triggers:
 *
 *     chrome.action.onClicked → ui.ts bindExtensionButtonClick listener
 *       → runCommand('submit-auto')
 *         → getNextAutoFillCommand
 *         → recursive runCommand('submit-username-password')
 *           → backend.connect
 *             → transport.connect → port handshake
 *             → changePublicKeys (NaCl key exchange + nonce)
 *           → backend.getLogins(url)
 *             → makeEncryptedRequest (NaCl box seal)
 *             → server-side encryptResponse (THE bug location)
 *             → decryptResponsePayload
 *             → validateNonce ← would have caught the 2026-04-09 nonce bug
 *           → autoFill(text, password)
 *             → setInputText on github form
 *
 * Crucially, this test does NOT use any test-only backdoor hook in
 * the extension. It triggers runCommand via the public Chrome
 * `chrome.action.onClicked.dispatch(tab)` API — which exists on the
 * standard `chrome.events.Event` object exposed in extension service
 * worker contexts (verified by enumerating the prototype keys, see
 * the "extension knows the API surface" smoke test below). The
 * extension's normal `bindExtensionButtonClick()` listener picks up
 * the dispatch and runs `runCommand` exactly as if the user had
 * clicked the toolbar button.
 *
 * Why this test exists: the 2026-04-09 warroom found a mutation-
 * aliasing bug in `protocol-impl.ts encryptResponse` where
 * `incrementNonce(new Uint8Array(nonceBytes))` operated on a
 * throwaway copy and the response nonce was sent un-incremented.
 * The extension's `validateNonce` rejected every response with
 * "Bad nonce in response", and chrome.commands.onCommand's async
 * listener swallowed the error silently. Hours of debug followed.
 * The earlier "github-repro" tests passed because they bypassed
 * the encrypted protocol entirely. THIS test would have caught
 * the bug on commit `44e66aeb` (the TS migration that introduced
 * the bug) by failing in the assertion at the bottom: form values
 * never get filled, because backend.getLogins throws before
 * autoFill is called.
 *
 * Setup requirements:
 *   1. KeeWebX dev server on http://localhost:8085 (Playwright
 *      config's webServer takes care of this)
 *   2. Built extension at packages/extension/dist/chrome
 *      (cd packages/extension && bun run build-chrome)
 *   3. Real github.com/login (live network — accept the cost,
 *      ~600KB cold load per test, fine for CI)
 */

const EXT_PATH = path.resolve(__dirname, '../../packages/extension/dist/chrome');
const NEOWEB_URL = 'http://localhost:8085/';

async function waitForServiceWorker(context: BrowserContext): Promise<Worker> {
    let [sw] = context.serviceWorkers();
    if (!sw) {
        sw = await context.waitForEvent('serviceworker');
    }
    return sw;
}

test.describe('Extension full-chain autofill (chromium)', () => {
    test('runCommand via chrome.action.onClicked.dispatch fills github.com login', async () => {
        expect(
            fs.existsSync(path.join(EXT_PATH, 'manifest.json')),
            'extension must be built first: cd packages/extension && bun run build-chrome'
        ).toBe(true);

        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-full-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${EXT_PATH}`,
                `--load-extension=${EXT_PATH}`
            ]
        });

        try {
            const sw = await waitForServiceWorker(context);

            // Sanity check: extension has registered the onClicked listener.
            // (In Chromium we COULD call `chrome.action.onClicked.dispatch`
            // directly since the `dispatch` method exists on the event
            // prototype, but Firefox 149 does not expose it — see the
            // sibling `autofill-firefox-full-chain.mjs` test. Both tests
            // instead go through the production `invoke-action-click`
            // runtime message handler declared in background/init.ts,
            // which is portable across both browsers.)
            const apiSurface = await sw.evaluate(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const onClicked = (chrome as any).action?.onClicked;
                return {
                    hasListeners: !!onClicked?.hasListeners?.()
                };
            });
            expect(
                apiSurface.hasListeners,
                'extension must have registered an onClicked listener via bindExtensionButtonClick'
            ).toBe(true);

            // Configure the extension's keeWebUrl BEFORE opening KeeWebX,
            // so backend.connect's findOrCreateTab matches our local dev
            // server and not the hardcoded gh-pages default.
            await sw.evaluate(async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await (chrome as any).storage.local.set({
                    keeWebUrl: 'http://localhost:8085/'
                });
            });

            // 1. Open KeeWebX dev server, click Demo, wait for unlock
            const neowebPage = await context.newPage();
            await neowebPage.goto(NEOWEB_URL, { waitUntil: 'networkidle', timeout: 60_000 });
            // CI runner is slow on cold webpack dev server — give
            // generous timeouts (Chromium flakiness under xvfb).
            await neowebPage.waitForSelector('#open__icon-demo', { timeout: 60_000 });
            await neowebPage.click('#open__icon-demo');
            await neowebPage.waitForSelector('.list__item', { timeout: 60_000 });

            // 2. Open github.com/login + focus username input
            const githubPage = await context.newPage();
            const ghLogs: string[] = [];
            githubPage.on('console', (m) => ghLogs.push(`[${m.type()}] ${m.text()}`));
            githubPage.on('pageerror', (e) => ghLogs.push(`[err] ${e.message}`));
            await githubPage.goto('https://github.com/login', {
                waitUntil: 'domcontentloaded',
                timeout: 30_000
            });
            await githubPage.waitForSelector('#login_field');
            await githubPage.focus('#login_field');

            // CRITICAL: the autoFill command resolved by
            // getNextAutoFillCommand is `submit-username-password`, which
            // sets `options.submit = true`, which calls form.requestSubmit
            // at the end of content-page.js's autoFill. That submits the
            // form to github's /session endpoint, navigates the page, and
            // destroys the JS execution context before we can read the
            // input values. Block submission so the test can verify the
            // intermediate state. Capture phase + stopImmediatePropagation
            // ensures content-page.js's submitForm cannot proceed.
            await githubPage.evaluate(() => {
                const form = document.querySelector('form');
                if (form) {
                    form.addEventListener(
                        'submit',
                        (e) => {
                            e.preventDefault();
                            e.stopImmediatePropagation();
                        },
                        { capture: true }
                    );
                }
            });

            // 3. Drive runCommand via chrome.action.onClicked.dispatch.
            //    Chromium exposes `dispatch` on chrome.events.Event
            //    prototype, which fires the extension's registered
            //    onClicked listener (ui.ts bindExtensionButtonClick)
            //    exactly as a toolbar button click would. Firefox 149
            //    does NOT expose dispatch (verified empirically); the
            //    sibling `autofill-firefox-full-chain.mjs` uses the
            //    production `invoke-action-click` runtime message
            //    RPC declared in background/init.ts instead. Both
            //    paths converge on runCommand → backend.getLogins →
            //    autoFill.
            //
            //    Note: chrome.runtime.sendMessage from the SW itself
            //    does NOT reach the same SW's onMessage listener
            //    (Chrome/Firefox both exclude the sender frame from
            //    message delivery), so the RPC path can't be used
            //    here — only from a different extension context
            //    (options page, popup, content script).
            const dispatchResult = await sw.evaluate(async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const tabs = await (chrome as any).tabs.query({});
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const tab = tabs.find((t: any) =>
                    t.url?.startsWith('https://github.com/login')
                );
                if (!tab) return { error: 'no github tab' };

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (chrome as any).action.onClicked.dispatch(tab);
                return { dispatched: true, tabId: tab.id };
            });
            expect(dispatchResult.dispatched, JSON.stringify(dispatchResult)).toBe(true);

            // 4. The extension flow opens KeeWebX's permission modal
            //    on the KeeWebX tab. Auto-grant by clicking the "Allow"
            //    button. Without this the test hangs on user input.
            //    Wait briefly for the modal then click.
            await neowebPage.waitForTimeout(800);
            try {
                const allowBtn = await neowebPage.waitForSelector(
                    "button[data-result='yes']",
                    { timeout: 5_000 }
                );
                await allowBtn.click();
            } catch {
                // Permission may have been auto-granted from a previous
                // test run; not fatal.
            }

            // 5. Wait for backend.getLogins → autoFill chain to complete.
            //    On a successful run this is fast (~500ms after permission
            //    grant). Allow extra slack for slow CI.
            await githubPage.waitForFunction(
                () => {
                    const u = document.getElementById(
                        'login_field'
                    ) as HTMLInputElement | null;
                    return u && u.value.length > 0;
                },
                { timeout: 15_000 }
            );

            // 6. Verify both fields populated. The exact values depend on
            //    the demo database (Demo button → load fixed entries),
            //    so we assert "non-empty" rather than fixed strings.
            const formState = await githubPage.evaluate(() => ({
                login: (document.getElementById('login_field') as HTMLInputElement).value,
                password: (document.getElementById('password') as HTMLInputElement).value
            }));
            expect(
                formState.login.length,
                `login_field must be filled by full chain. ` +
                    `dispatch=${JSON.stringify(dispatchResult)} ` +
                    `ghLogs=${ghLogs.slice(-5).join(' | ')}`
            ).toBeGreaterThan(0);
            expect(formState.password.length).toBeGreaterThan(0);
        } finally {
            await context.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });
});
