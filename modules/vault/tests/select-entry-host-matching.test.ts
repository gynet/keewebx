import { expect, test } from 'bun:test';
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
if (!originalWindow) Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
const { SelectEntryFilter } = await import('../src/comp/app/select-entry-filter');
if (!originalWindow) Reflect.deleteProperty(globalThis, 'window');

function rank(stored: string, destination: string, subdomains = true): number {
    const entry = { title: 'Account', searchText: destination, getAllUrls: () => [stored] };
    const filter = new SelectEntryFilter({ url: destination }, { getEntriesByFilter: () => [entry] }, null, {});
    filter.subdomains = subdomains;
    return filter._getEntryRank(entry);
}

test('URL ranking recognizes only complete DNS labels and ignores free-form text', () => {
    expect(rank('https://example.test', 'https://auth.example.test/session')).toBeGreaterThan(0);
    expect(rank('https://example.test', 'https://unrelated.test/session')).toBe(0);
    expect(rank('https://example.test', 'https://notexample.test/session')).toBe(0);
    expect(rank('https://example.test', 'https://auth.example.test.invalid.test/session')).toBe(0);
});

test('exact-host ranking normalizes IDN and keeps subdomains and non-matching ports separate', () => {
    expect(rank('https://bücher.test', 'https://xn--bcher-kva.test/login', false)).toBeGreaterThan(0);
    expect(rank('https://bücher.test', 'https://auth.xn--bcher-kva.test/login', false)).toBe(0);
    expect(rank('https://bücher.test', 'https://xn--bcher-kva.test:8443/login', false)).toBe(0);
});
