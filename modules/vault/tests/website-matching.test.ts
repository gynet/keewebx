import { describe, expect, test } from 'bun:test';
import { entryMatchesWebsite, matchesWebsiteUrl, validWebsiteOrigin } from '../src/comp/extension/website-matching';

describe('validWebsiteOrigin', () => {
    test.each([
        'https://example.com', 'https://www.example.com', 'https://example.com:8443',
        'https://xn--bcher-kva.example', 'https://localhost', 'https://printer',
        'https://127.0.0.1', 'https://[::1]', 'https://[2001:db8::1]:8443'
    ])('accepts canonical HTTPS origin %s', (origin) => {
        expect(validWebsiteOrigin(origin)).toBe(origin);
    });

    test.each([
        undefined, null, false, 42, {}, [], new URL('https://example.com'),
        '', 'null', 'example.com', '//example.com', 'http://example.com',
        'ftp://example.com', 'file:///example.com', 'javascript:alert(1)',
        'HTTPS://example.com', 'https://EXAMPLE.com', 'https://example.com:443',
        'https://example.com:08443', 'https://example.com:', 'https://example.com:65536',
        'https://example.com/', 'https://example.com/login', 'https://example.com/.',
        'https://example.com?', 'https://example.com?next=evil', 'https://example.com#',
        'https://example.com#fragment', 'https://user:secret@example.com',
        'https://user@example.com', 'https://@example.com', 'https://:@example.com',
        ' https://example.com', 'https://example.com ', 'https://exam\nple.com',
        'https://example.com\t', 'https://example.com\\login', 'https:example.com',
        'https:/example.com', 'https:///example.com', 'https://',
        'https://bücher.example', 'https://%65xample.com', 'https://127.1',
        'https://0x7f000001', 'https://[0:0:0:0:0:0:0:1]'
    ].map((value) => [value]))('rejects noncanonical or invalid origin %p', (value) => {
        expect(validWebsiteOrigin(value)).toBeUndefined();
    });
});

describe('matchesWebsiteUrl', () => {
    test.each([
        ['example.com', 'https://example.com'],
        ['example.com/login?next=/account#form', 'https://example.com'],
        ['  example.com/login  ', 'https://example.com'],
        ['https://EXAMPLE.com:443/account', 'https://example.com'],
        ['https://www.example.com/login', 'https://example.com'],
        ['example.com', 'https://www.example.com'],
        ['www.example.com', 'https://example.com'],
        ['https://www.example.co.uk', 'https://example.co.uk'],
        ['example.com:8443/login', 'https://www.example.com:8443'],
        ['https://www.example.com:8443', 'https://example.com:8443'],
        ['https://accounts.example.com', 'https://accounts.example.com'],
        ['https://www.www.example.com', 'https://www.www.example.com'],
        ['http://example.com', 'https://example.com'],
        ['http://www.example.com:80/login', 'https://example.com'],
        ['http://example.com:80', 'https://www.example.com'],
        ['http://EXAMPLE.com:080', 'https://example.com'],
        ['https://bücher.example/login', 'https://xn--bcher-kva.example'],
        ['https://%65xample.com', 'https://example.com'],
        ['https://example.com/path@evil.test?next=https://evil.test', 'https://example.com'],
        ['localhost:8443/login', 'https://localhost:8443'],
        ['http://localhost:80', 'https://localhost'],
        ['printer', 'https://printer'],
        ['https://printer.local/login', 'https://printer.local'],
        ['127.0.0.1:8443', 'https://127.0.0.1:8443'],
        ['https://127.1', 'https://127.0.0.1'],
        ['https://0x7f000001', 'https://127.0.0.1'],
        ['http://127.0.0.1', 'https://127.0.0.1'],
        ['[::1]:8443/login', 'https://[::1]:8443'],
        ['https://[0:0:0:0:0:0:0:1]', 'https://[::1]'],
        ['https://[2001:db8::1]', 'https://[2001:db8::1]']
    ])('matches stored %s to %s', (value, origin) => {
        expect(matchesWebsiteUrl(value, origin)).toBe(true);
    });

    test.each([
        ['example.com', 'https://accounts.example.com'],
        ['https://accounts.example.com', 'https://example.com'],
        ['https://accounts.example.com', 'https://www.example.com'],
        ['example.com', 'https://www.example.com.evil.test'],
        ['https://example.com.evil.test', 'https://example.com'],
        ['https://evil-example.com', 'https://example.com'],
        ['https://example.comevil.test', 'https://example.com'],
        ['https://examp1e.com', 'https://example.com'],
        ['https://exаmple.com', 'https://example.com'],
        ['https://www.example.com%2eevil.test', 'https://example.com'],
        ['https://evil.test/?next=https://example.com', 'https://example.com'],
        ['https://evil.test/#https://example.com', 'https://example.com'],
        ['https://evil.test/example.com', 'https://example.com'],
        ['https://user:secret@example.com', 'https://example.com'],
        ['https://user@example.com', 'https://example.com'],
        ['https://@example.com', 'https://example.com'],
        ['https://:@example.com', 'https://example.com'],
        ['user:secret@example.com', 'https://example.com'],
        ['example.com@evil.test', 'https://evil.test'],
        ['https://example.com@evil.test', 'https://example.com'],
        ['https://example.com@evil.test', 'https://evil.test'],
        ['https://example.com:8443', 'https://example.com'],
        ['https://example.com', 'https://example.com:8443'],
        ['https://example.com:8443', 'https://example.com:9443'],
        ['http://example.com:8080', 'https://example.com'],
        ['http://example.com:8443', 'https://example.com:8443'],
        ['http://example.com:443', 'https://example.com'],
        ['http://example.com', 'https://example.com:80'],
        ['http://example.com', 'https://example.com:8443'],
        ['https://example.com', 'http://example.com'],
        ['example.com', 'https://example.com/'],
        ['example.com', 'https://example.com:443'],
        ['example.com', 'https://user@example.com'],
        ['https://www.www.example.com', 'https://example.com'],
        ['https://www.www.example.com', 'https://www.example.com'],
        ['https://www.example.com', 'https://www.www.example.com'],
        ['https://www.www.www.example.com', 'https://www.www.example.com'],
        ['https://localhost', 'https://www.localhost'],
        ['https://www.localhost', 'https://localhost'],
        ['printer', 'https://www.printer'],
        ['https://www.printer', 'https://printer'],
        ['https://printer.local', 'https://www.printer.local'],
        ['https://www.printer.local', 'https://printer.local'],
        ['https://service.localhost', 'https://www.service.localhost'],
        ['https://printer.localdomain', 'https://www.printer.localdomain'],
        ['https://printer.internal', 'https://www.printer.internal'],
        ['https://printer.lan', 'https://www.printer.lan'],
        ['https://printer.home.arpa', 'https://www.printer.home.arpa'],
        ['https://127.0.0.1', 'https://127.0.0.2'],
        ['https://127.0.0.1', 'https://localhost'],
        ['https://127.0.0.1', 'https://www.127.0.0.1'],
        ['https://www.127.0.0.1', 'https://127.0.0.1'],
        ['https://[::1]', 'https://[::2]'],
        ['https://[::1]', 'https://localhost'],
        ['https://example.com.', 'https://example.com'],
        ['ftp://example.com', 'https://example.com'],
        ['ftp://example.com', 'https://ftp'],
        ['file://example.com', 'https://file'],
        ['javascript://example.com', 'https://javascript'],
        ['javascript:alert(1)', 'https://example.com'],
        ['data:text/html,example.com', 'https://example.com'],
        ['mailto:user@example.com', 'https://example.com'],
        ['https:/example.com', 'https://https'],
        ['https:///example.com', 'https://example.com'],
        ['//example.com', 'https://example.com'],
        ['https://exam\nple.com', 'https://example.com'],
        ['https://exam\tple.com', 'https://example.com'],
        ['https://example.com\\@evil.test', 'https://example.com'],
        ['https://example.com\\login', 'https://example.com'],
        ['https://example.com:', 'https://example.com'],
        ['https://example.com:65536', 'https://example.com'],
        ['https://[::1', 'https://[::1]'],
        ['', 'https://example.com'],
        ['not a valid URL', 'https://example.com']
    ])('rejects stored %s for %s', (value, origin) => {
        expect(matchesWebsiteUrl(value, origin)).toBe(false);
    });
});

describe('entryMatchesWebsite', () => {
    test('matches any additional URL even when the primary URL is unrelated or invalid', () => {
        const urls = ['https://unrelated.test', 'javascript:alert(1)', 'http://www.example.com:80/login'];
        const entry = { getAllUrls: () => urls };
        expect(entryMatchesWebsite(entry, 'https://example.com')).toBe(true);
        expect(urls).toEqual(['https://unrelated.test', 'javascript:alert(1)', 'http://www.example.com:80/login']);
    });

    test('accepts an entry with only an additional URL and checks the primary URL too', () => {
        expect(entryMatchesWebsite({ getAllUrls: () => ['example.com'] }, 'https://www.example.com')).toBe(true);
        expect(entryMatchesWebsite({ getAllUrls: () => ['https://example.com', 'https://unrelated.test'] }, 'https://example.com')).toBe(true);
    });

    test('rejects entries without a matching URL', () => {
        expect(entryMatchesWebsite({ getAllUrls: () => [] }, 'https://example.com')).toBe(false);
        expect(entryMatchesWebsite({ getAllUrls: () => ['https://example.com.evil.test', 'https://accounts.example.com'] }, 'https://example.com')).toBe(false);
    });

    test('rejects an invalid destination before reading entry URLs', () => {
        const entry = { getAllUrls: (): string[] => { throw new Error('URLs must not be read'); } };
        for (const origin of ['http://example.com', 'https://example.com/', 'https://user@example.com', 'invalid']) {
            expect(entryMatchesWebsite(entry, origin)).toBe(false);
        }
    });
});
