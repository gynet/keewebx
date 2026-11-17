import { afterEach, expect, spyOn, test } from 'bun:test';
import { isLocalHtml } from '../../vault/src/comp/browser/local-html';
import { loadStartupConfig } from '../../vault/src/comp/app/startup-config';
import { faviconUrl } from '../src/favicon-image';

const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
afterEach(() => {
    if (descriptor) Object.defineProperty(globalThis, 'location', descriptor);
    else Reflect.deleteProperty(globalThis, 'location');
});

test('local HTML skips startup configuration and ignores retained icon proxy settings', async () => {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'file:' } });
    expect(isLocalHtml()).toBe(true);
    const fetch = spyOn(globalThis, 'fetch');
    try {
        await loadStartupConfig({} as Parameters<typeof loadStartupConfig>[0]);
        expect(fetch).not.toHaveBeenCalled();
        expect(faviconUrl('https://example.com/private?secret=value', 'https://server.example/icon-proxy/'))
            .toBe('https://example.com/favicon.ico');
    } finally { fetch.mockRestore(); }
});

test('served HTML keeps explicitly configured network features', () => {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'https:' } });
    expect(isLocalHtml()).toBe(false);
    expect(faviconUrl('https://example.com/private', '/icons/')).toBe('/icons/example.com');
});

test('local HTML keeps the WebDAV provider enabled', async () => {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'file:' } });
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    try {
        const { StorageWebDav } = await import('../../vault/src/storage/impl/storage-webdav');
        expect(new StorageWebDav().enabled).toBe(true);
    } finally {
        if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
        else Reflect.deleteProperty(globalThis, 'window');
    }
});
