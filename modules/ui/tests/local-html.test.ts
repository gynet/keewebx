import { afterEach, expect, spyOn, test } from 'bun:test';
import { isLocalHtml, requireNetwork } from '../../vault/src/comp/browser/local-html';
import { loadStartupConfig } from '../../vault/src/comp/app/startup-config';
import { faviconUrl } from '../src/favicon-image';

const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
afterEach(() => {
    if (descriptor) Object.defineProperty(globalThis, 'location', descriptor);
    else Reflect.deleteProperty(globalThis, 'location');
});

test('local HTML ignores remote configuration and retained icon proxy settings', async () => {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'file:' } });
    expect(isLocalHtml()).toBe(true);
    expect(requireNetwork).toThrow('Network access is disabled');
    const fetch = spyOn(globalThis, 'fetch');
    try {
        await loadStartupConfig({} as Parameters<typeof loadStartupConfig>[0]);
        expect(fetch).not.toHaveBeenCalled();
        expect(faviconUrl('https://example.com/private?secret=value', 'https://server.example/api/favicon/'))
            .toBe('https://example.com/favicon.ico');
    } finally { fetch.mockRestore(); }
});

test('served HTML keeps explicitly configured network features', () => {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'https:' } });
    expect(isLocalHtml()).toBe(false);
    expect(requireNetwork).not.toThrow();
    expect(faviconUrl('https://example.com/private', '/icons/')).toBe('/icons/example.com');
});
