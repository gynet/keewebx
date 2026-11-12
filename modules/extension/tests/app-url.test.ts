import { describe, test, expect } from 'bun:test';
import { matchesAppUrl } from '../src/common/app-url';
import { TransportBrowserTab } from '../src/background/transport/transport-browser-tab';

describe('configured app tab identity', () => {
    const configured = 'https://vault.example:8443/keewebx/?ui=classic';
    test('query-bearing custom URL matches its existing hash-routed app tab', () => {
        expect(matchesAppUrl(configured + '#settings', configured)).toBe(true);
        expect(matchesAppUrl('https://vault.example:8443/keewebx/index.html?ui=classic#app/open', configured)).toBe(true);
        expect(matchesAppUrl('https://vault.example/app?b=2&a=1#hash', 'https://vault.example/app?a=1&b=2')).toBe(true);
    });
    test('query-free settings retain hash and query routing at the same app path', () => {
        expect(matchesAppUrl(configured, 'https://vault.example:8443/keewebx/')).toBe(true);
        expect(matchesAppUrl('https://vault.example/keewebx', 'https://vault.example/keewebx/')).toBe(true);
    });
    test('an explicit UI selector cannot select another interface or namespace', () => {
        for (const query of ['', '?ui=new', '?ui=classic&namespace=other', '?ui=classic&ui=new']) {
            expect(matchesAppUrl('https://vault.example:8443/keewebx/' + query, configured)).toBe(false);
        }
    });
    test('rejects hostile origin, port, scheme and path prefix matches', () => {
        for (const candidate of [
            'https://vault.example.evil:8443/keewebx/?ui=classic',
            'http://vault.example:8443/keewebx/?ui=classic',
            'https://vault.example/keewebx/?ui=classic',
            'https://vault.example:8443/keewebx-evil/?ui=classic',
            'https://vault.example:8443/keewebx/other-app/?ui=classic',
            'https://vault.example:8443/keewebx%2fother/?ui=classic',
            'https://user@vault.example:8443/keewebx/?ui=classic',
            'javascript:alert(1)', 'not a url'
        ]) expect(matchesAppUrl(candidate, configured)).toBe(false);
        expect(matchesAppUrl(undefined, configured)).toBe(false);
        expect(matchesAppUrl(configured, undefined)).toBe(false);
    });
    test('opaque extension and file origins still require exact host and document path', () => {
        expect(matchesAppUrl('chrome-extension://one/app/index.html#open', 'chrome-extension://one/app/index.html')).toBe(true);
        expect(matchesAppUrl('chrome-extension://two/app/index.html', 'chrome-extension://one/app/index.html')).toBe(false);
        expect(matchesAppUrl('file:///vault/index.html#open', 'file:///vault/index.html')).toBe(true);
        expect(matchesAppUrl('file:///other/index.html', 'file:///vault/index.html')).toBe(false);
    });
    test('real tab discovery reuses the configured Classic tab instead of creating a duplicate', async () => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
        let created = false;
        Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
            tabs: {
                query(_query: unknown, callback: (tabs: unknown[]) => void) { callback([
                    { id: 1, url: 'https://vault.example:8443/keewebx/?ui=new' },
                    { id: 2, url: configured + '#app/open' }
                ]); },
                create() { created = true; throw new Error('Unexpected new tab'); }
            }
        } });
        try {
            const transport = new TransportBrowserTab(configured);
            const tab = await (transport as unknown as { findOrCreateTab(): Promise<{ id: number }> }).findOrCreateTab();
            expect(tab.id).toBe(2);
            expect(created).toBe(false);
        } finally { if (previous) Object.defineProperty(globalThis, 'chrome', previous); else Reflect.deleteProperty(globalThis, 'chrome'); }
    });
});
