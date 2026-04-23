import { test, expect } from '@playwright/test';

/**
 * Extension protocol smoke — verifies the BrowserExtensionConnector
 * window.postMessage receive/respond chain is alive end-to-end WITHOUT
 * needing an actual browser extension installed. The page sends
 * `kwConnect:'request'` messages to itself, which satisfies the strict
 * `e.source === window` filter in browser-extension-connector.ts:102,
 * and the protocol-impl handler is expected to post back a
 * `kwConnect:'response'` event.
 *
 * This spec exists because of the 2026-04-09 second warroom where the
 * user reported autofill via the upstream KeeWeb Connect extension was
 * broken. Static analysis of the autofill chain found nothing missing,
 * but we had no way to verify the protocol layer was alive without
 * installing the real extension and manually triggering autofill from a
 * real website (a flaky, unreproducible test). The headless ping
 * roundtrip below took 30 seconds to write and instantly proved that
 * the KeeWebX side of the protocol is functional, isolating the bug
 * to the extension side. From now on, every commit runs this spec; any
 * regression that breaks BrowserExtensionConnector init order, listener
 * registration, the source/origin/kwConnect filter, ProtocolImpl
 * dispatch, or the sendWebResponse roundtrip turns master red.
 *
 * Future test cases to add (deferred — needs NaCl box on client side):
 *   - change-public-keys handshake roundtrip with real keys
 *   - get-databasehash on a fixture-loaded file
 *   - get-logins with a fixture URL → SelectEntryView render check
 */

test.describe('Extension protocol', () => {
    test('BrowserExtensionConnector logs Started after boot', async ({ page }) => {
        const consoleLogs: string[] = [];
        page.on('console', (msg) => {
            if (msg.type() === 'log' || msg.type() === 'info') {
                consoleLogs.push(msg.text());
            }
        });
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        // postInit() runs the connector init in setTimeout(500ms) after
        // showApp completes. Give a generous margin so the listener has
        // time to attach.
        await page.waitForTimeout(2000);
        const found = consoleLogs.some((l) =>
            l.includes('[browser-extension-connector] Started')
        );
        expect(
            found,
            `console must contain "[browser-extension-connector] Started" log. ` +
                `If missing, postInit() likely did not run — boot chain rejected somewhere ` +
                `or browserExt.init() threw. Captured logs:\n${consoleLogs.slice(-15).join('\n')}`
        ).toBe(true);
    });

    test('ping request gets a matching response', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        // Wait long enough for postInit's setTimeout(500ms) to fire and
        // BrowserExtensionConnector.start() to attach the message listener.
        await page.waitForTimeout(2000);

        const result = await page.evaluate(() => {
            return new Promise<{
                status: 'response' | 'timeout';
                responseData?: unknown;
            }>((resolve) => {
                const handler = (e: MessageEvent) => {
                    const d = e.data as { kwConnect?: string; data?: unknown };
                    if (d?.kwConnect === 'response') {
                        window.removeEventListener('message', handler);
                        resolve({ status: 'response', responseData: d.data });
                    }
                };
                window.addEventListener('message', handler);
                window.postMessage(
                    { kwConnect: 'request', action: 'ping', data: { hello: 'world' } },
                    location.origin
                );
                setTimeout(() => {
                    window.removeEventListener('message', handler);
                    resolve({ status: 'timeout' });
                }, 5000);
            });
        });

        expect(
            result.status,
            'BrowserExtensionConnector must respond to ping. Timeout = either ' +
                'postInit() did not run, browserExt.init() threw silently, or a future ' +
                'change broke the kwConnect message filter. To debug locally: open the ' +
                'dev server in a browser, F12 → Console → ' +
                '`localStorage.debugBrowserExtension="1"; location.reload()` and watch ' +
                'for "[browser-extension-connector] Extension -> KeeWeb" log lines.'
        ).toBe('response');
        // The ping handler echoes back whatever `data` was sent.
        expect(result.responseData).toEqual({ hello: 'world' });
    });

    test('non-kwConnect messages are ignored by the connector', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);

        const result = await page.evaluate(() => {
            return new Promise<'gotresponse' | 'timeout'>((resolve) => {
                const handler = (e: MessageEvent) => {
                    const d = e.data as { kwConnect?: string };
                    if (d?.kwConnect === 'response') {
                        window.removeEventListener('message', handler);
                        resolve('gotresponse');
                    }
                };
                window.addEventListener('message', handler);
                // Missing the kwConnect:'request' marker — must be ignored
                // per browser-extension-connector.ts:105.
                window.postMessage(
                    { action: 'ping', data: { test: 1 } },
                    location.origin
                );
                setTimeout(() => {
                    window.removeEventListener('message', handler);
                    resolve('timeout');
                }, 1500);
            });
        });
        expect(
            result,
            'connector must ignore messages without kwConnect:"request"'
        ).toBe('timeout');
    });
});
