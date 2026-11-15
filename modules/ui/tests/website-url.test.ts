import { expect, test } from 'bun:test';
import { safeWebsiteUrl } from '../src/website-url';

test('Classic website protocols and schemeless addresses remain actionable', () => {
    for (const value of ['https://example.com/', 'http://example.com/', 'ftp://example.com/file', 'ftps://example.com/file', 'mailto:user@example.com']) {
        expect(safeWebsiteUrl(value)).toBe(value);
    }
    expect(safeWebsiteUrl('//example.com/file')).toBe('https://example.com/file');
    expect(safeWebsiteUrl('example.com')).toBe('https://example.com/');
});
test('executable and parser-normalized unsafe protocols remain plain text', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd',
        'java\nscript:alert(1)', 'https://example.com\\secret', 'mailto:', '']) expect(safeWebsiteUrl(value)).toBeUndefined();
});
