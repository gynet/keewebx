import { expect, test } from 'bun:test';
import { legacyClassicEntry } from '../src/comp/browser/ui-entry';

test('New stays the default without an explicit Classic selector', () => {
    for (const url of ['https://example.test/', 'https://example.test/index.html?ui=new', 'file:///vault/index.html']) {
        expect(legacyClassicEntry(url)).toBeUndefined();
    }
});
test('Classic redirect preserves nested hosting, query namespaces and hash', () => {
    expect(legacyClassicEntry('https://example.test/vault/?ui=classic&namespace=a#open'))
        .toBe('https://example.test/vault/classic.html?ui=classic&namespace=a#open');
    expect(legacyClassicEntry('file:///vault/index.html?ui=classic#settings'))
        .toBe('file:///vault/classic.html?ui=classic#settings');
    expect(legacyClassicEntry('https://example.test/app?ui=classic'))
        .toBe('https://example.test/classic.html?ui=classic');
});
