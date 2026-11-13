import { test, expect, spyOn } from 'bun:test';
import { faviconUrl, faviconCap, fetchFavicon } from '../src/favicon-image';
test('icon URL removes private paths and queries and rejects unsafe inputs', () => {
    expect(faviconUrl('https://example.com/private?token=secret#value')).toBe('https://example.com/favicon.ico');
    expect(faviconUrl('example.com')).toBe('https://example.com/favicon.ico');
    for (const url of ['', 'https://user:pass@example.com', 'file:///tmp/icon', 'javascript:alert(1)', 'https://example.com\\evil', 'https://example.com/\nvalue']) expect(() => faviconUrl(url)).toThrow();
    expect([0, 16, 32, 64, 128, 256, NaN].map(faviconCap)).toEqual([32, 32, 32, 64, 128, 32, 32]);
});
test('icon download rejects unsupported and oversized bodies before decoding, without credentials', async () => {
    const fake = spyOn(globalThis, 'fetch');
    try {
        fake.mockResolvedValueOnce(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }));
        await expect(fetchFavicon('https://example.com/favicon.ico', 32, new AbortController().signal)).rejects.toThrow('supported image');
        let canceled = false;
        fake.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { canceled = true; } }), { headers: { 'content-type': 'image/png' } }));
        await expect(fetchFavicon('https://example.com/favicon.ico', 32, new AbortController().signal)).rejects.toThrow('exceeds 1 MB');
        expect(canceled).toBe(true);
        expect(fake.mock.calls[0][1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', mode: 'cors' });
    } finally { fake.mockRestore(); }
});
