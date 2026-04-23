import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * Tab-switch autofill test. Same idea as autofill-github-repro.spec.ts
 * but inserts a tab-switch between the focus and the auto-fill dispatch
 * — matching what happens in real usage when KeeWebX's SelectEntryView
 * modal takes focus (on a different tab) and the user picks an entry,
 * then commands.ts activates the original form tab and dispatches the
 * auto-fill message.
 *
 * The previous isolation test (which passed) skipped the tab-switch.
 * The user's real flow crosses at least one tab-switch between the
 * `focus(#login_field)` moment and the `chrome.tabs.sendMessage
 * {action: auto-fill}` moment. If the tab-switch breaks autoFill,
 * this test reproduces the user's bug without needing the full
 * KeeWebX + picker + permission flow.
 */

const EXT_PATH = path.resolve(__dirname, '../../packages/extension/dist/chrome');

test.describe('Extension autofill with tab-switch before dispatch', () => {
    test('autoFill still works on github.com/login after tab-switch round-trip', async () => {
        expect(fs.existsSync(path.join(EXT_PATH, 'manifest.json'))).toBe(true);

        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-ext-tsw-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${EXT_PATH}`,
                `--load-extension=${EXT_PATH}`
            ]
        });

        try {
            let [sw] = context.serviceWorkers();
            if (!sw) {
                sw = await context.waitForEvent('serviceworker');
            }

            // Open github.com/login
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
            expect(await githubPage.evaluate(() => document.activeElement?.id)).toBe('login_field');

            // Open a SECOND tab — this mimics the user switching to the
            // KeeWebX tab to interact with the picker modal. Any second
            // tab will do; we just need to see if tab-switching breaks the
            // github tab's focus.
            const neowebPage = await context.newPage();
            await neowebPage.goto('about:blank'); // cheap, no network
            await neowebPage.bringToFront();
            // eslint-disable-next-line no-console
            console.log('Brought second (mock-neoweb) tab to front');
            await neowebPage.waitForTimeout(500);

            // Now switch back to the github tab. In the real user flow
            // this is what chrome.tabs.update({active: true}) does via
            // activateTab() in commands.ts after getLogins resolves.
            await githubPage.bringToFront();
            // eslint-disable-next-line no-console
            console.log('Brought github tab back to front');
            await githubPage.waitForTimeout(500);

            // Check activeElement AFTER the round-trip. This is the moment
            // of truth — is focus preserved, or did the tab-switch reset
            // document.activeElement to body?
            const afterSwitch = await githubPage.evaluate(() => ({
                tag: document.activeElement?.tagName,
                id: (document.activeElement as HTMLElement | null)?.id,
                value: (document.activeElement as HTMLInputElement | null)?.value,
                hasFocus: document.hasFocus(),
                locationHref: location.href
            }));
            // eslint-disable-next-line no-console
            console.log('After tab round-trip, activeElement:', JSON.stringify(afterSwitch));

            const realLocationHref = afterSwitch.locationHref;

            // Now dispatch the auto-fill message — same as runCommand would
            const dispatchResult = await sw.evaluate(
                async ({ targetUrl }) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const chromeApi = (globalThis as any).chrome;
                    const tabs = await chromeApi.tabs.query({});
                    const tab = tabs.find(
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        (t: any) => t.url?.startsWith('https://github.com/login')
                    );
                    if (!tab) {
                        return { error: 'no github tab' };
                    }
                    try {
                        await chromeApi.scripting.executeScript({
                            files: ['js/content-page.js'],
                            target: { tabId: tab.id, allFrames: true }
                        });
                    } catch (e) {
                        return { error: 'executeScript: ' + (e as Error).message };
                    }
                    await new Promise((r) => setTimeout(r, 200));
                    return new Promise<unknown>((resolve) => {
                        chromeApi.tabs.sendMessage(
                            tab.id,
                            {
                                action: 'auto-fill',
                                url: tab.url,
                                text: 'gynet.gy@gmail.com',
                                password: 'testpass-tabswitch',
                                submit: false
                            },
                            { frameId: 0 },
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            (resp: any) => {
                                const err = chromeApi.runtime.lastError;
                                resolve({ ok: !err, err: err?.message, resp });
                            }
                        );
                    });
                },
                { targetUrl: realLocationHref }
            );
            // eslint-disable-next-line no-console
            console.log('Dispatch result:', JSON.stringify(dispatchResult));

            await githubPage.waitForTimeout(1500);

            const formState = await githubPage.evaluate(() => ({
                loginFieldValue: (document.getElementById('login_field') as HTMLInputElement).value,
                passwordValue: (document.getElementById('password') as HTMLInputElement).value
            }));
            // eslint-disable-next-line no-console
            console.log('Final form state:', JSON.stringify(formState));
            // eslint-disable-next-line no-console
            console.log(
                'GitHub tab NKW-Connect logs:\n' +
                    ghLogs.filter((l) => l.includes('NKW-Connect')).join('\n')
            );

            expect(
                formState.loginFieldValue,
                `login field should be filled after tab-switch round-trip. ` +
                    `afterSwitch=${JSON.stringify(afterSwitch)} dispatch=${JSON.stringify(dispatchResult)}`
            ).toBe('gynet.gy@gmail.com');
            expect(formState.passwordValue).toBe('testpass-tabswitch');
        } finally {
            await context.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });
});
