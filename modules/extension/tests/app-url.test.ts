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
    test('legacy Classic selectors follow only the explicit Classic redirect', () => {
        expect(matchesAppUrl('https://vault.example:8443/keewebx/classic.html?ui=classic', configured)).toBe(true);
        expect(matchesAppUrl('https://vault.example:8443/keewebx/classic/index.html?ui=classic', configured)).toBe(true);
        expect(matchesAppUrl('https://vault.example:8443/keewebx/classic.html', configured)).toBe(false);
        expect(matchesAppUrl('https://vault.example:8443/other/classic.html?ui=classic', configured)).toBe(false);
    });
    test('next and rewritten New entries follow the exact Classic destination', () => {
        for (const entry of ['next.html', 'app']) {
            const source = `https://vault.example/keewebx/${entry}?ui=classic&namespace=a`;
            expect(matchesAppUrl('https://vault.example/keewebx/classic.html?namespace=a&ui=classic#open', source)).toBe(true);
            expect(matchesAppUrl('https://vault.example/keewebx/classic/index.html?namespace=a&ui=classic', source)).toBe(true);
            for (const candidate of ['other.html', 'other/app', 'other/classic.html']) {
                expect(matchesAppUrl(`https://vault.example/keewebx/${candidate}?ui=classic&namespace=a`, source)).toBe(false);
            }
            expect(matchesAppUrl('https://vault.example/keewebx/classic.html?ui=classic&namespace=b', source)).toBe(false);
        }
        expect(matchesAppUrl('https://vault.example/keewebx/classic.html?ui=classic', 'https://vault.example/keewebx?ui=classic')).toBe(true);
        expect(matchesAppUrl('https://vault.example/classic.html?ui=classic', 'https://vault.example/classic.html')).toBe(true);
        expect(matchesAppUrl('https://vault.example/classic.html?ui=classic', 'https://vault.example/next.html')).toBe(false);
    });
    test('query-free settings retain hash and query routing at the same app path', () => {
        expect(matchesAppUrl(configured, 'https://vault.example:8443/keewebx/')).toBe(true);
        expect(matchesAppUrl('https://vault.example/keewebx', 'https://vault.example/keewebx/')).toBe(true);
    });
    test('the hosted preview directory selects its own app document', () => {
        const preview = 'https://keewebx.app/preview/';
        for (const candidate of [preview, preview + '#settings', preview + 'index.html'])
            expect(matchesAppUrl(candidate, preview)).toBe(true);
        for (const candidate of ['https://keewebx.app/app', 'https://keewebx.app/',
            preview + 'next.html', preview + 'classic.html', 'https://keewebx.app/preview-other/'])
            expect(matchesAppUrl(candidate, preview)).toBe(false);
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
    test('tab discovery reuses a Classic redirect from configured next.html', async () => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
        Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { tabs: {
            query(_query: unknown, callback: (tabs: unknown[]) => void) { callback([
                { id: 8, url: 'https://vault.example/other.html?ui=classic' },
                { id: 9, url: 'https://vault.example/classic.html?ui=classic' }
            ]); }, create() { throw new Error('Redirect must reuse the existing tab'); }
        } } });
        try {
            const transport = new TransportBrowserTab('https://vault.example/next.html?ui=classic');
            expect((await (transport as unknown as { findOrCreateTab(): Promise<{ id: number }> }).findOrCreateTab()).id).toBe(9);
        } finally { if (previous) Object.defineProperty(globalThis, 'chrome', previous); else Reflect.deleteProperty(globalThis, 'chrome'); }
    });

});
