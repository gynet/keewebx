import { describe, test, expect } from 'bun:test';

// Inline the pure functions to avoid webpack alias resolution issues
const UrlFormat = {
    multiSlashRegex: /\/{2,}/g,
    lastPartRegex: /[\/\\]?[^\/\\]+$/,
    kdbxEndRegex: /\.kdbx$/i,

    getDataFileName(url: string): string {
        const ix = url.lastIndexOf('/');
        if (ix >= 0) {
            url = url.substr(ix + 1);
        }
        url = url.replace(/\?.*/, '').replace(/\.kdbx/i, '');
        return url;
    },

    isKdbx(url: string): boolean {
        return !!url && this.kdbxEndRegex.test(url);
    },

    fixSlashes(url: string): string {
        return url.replace(this.multiSlashRegex, '/');
    },

    fileToDir(url: string): string {
        return url.replace(this.lastPartRegex, '') || '/';
    },

    makeUrl(base: string, args: Record<string, string>): string {
        const queryString = Object.entries(args)
            .map(([key, value]) => key + '=' + encodeURIComponent(value))
            .join('&');
        return base + '?' + queryString;
    },

    buildFormData(params: Record<string, string>): string {
        return Object.entries(params)
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join('&');
    }
};

describe('UrlFormat.getDataFileName', () => {
    test('extracts filename from URL path', () => {
        expect(UrlFormat.getDataFileName('https://example.com/path/mydb.kdbx')).toBe('mydb');
    });

    test('strips query parameters', () => {
        expect(UrlFormat.getDataFileName('https://example.com/mydb.kdbx?token=abc')).toBe('mydb');
    });

    test('handles URL without path', () => {
        expect(UrlFormat.getDataFileName('mydb.kdbx')).toBe('mydb');
    });

    test('handles non-kdbx files', () => {
        expect(UrlFormat.getDataFileName('https://example.com/file.txt')).toBe('file.txt');
    });
});

describe('UrlFormat.isKdbx', () => {
    test('returns true for .kdbx files', () => {
        expect(UrlFormat.isKdbx('mydb.kdbx')).toBe(true);
        expect(UrlFormat.isKdbx('path/to/mydb.KDBX')).toBe(true);
    });

    test('returns false for non-kdbx files', () => {
        expect(UrlFormat.isKdbx('mydb.txt')).toBe(false);
        expect(UrlFormat.isKdbx('mydb.kdbx.bak')).toBe(false);
    });

    test('returns false for empty/falsy input', () => {
        expect(UrlFormat.isKdbx('')).toBe(false);
    });
});

describe('UrlFormat.fixSlashes', () => {
    test('replaces multiple slashes with single slash', () => {
        expect(UrlFormat.fixSlashes('path//to///file')).toBe('path/to/file');
    });

    test('leaves single slashes unchanged', () => {
        expect(UrlFormat.fixSlashes('path/to/file')).toBe('path/to/file');
    });
});

describe('UrlFormat.fileToDir', () => {
    test('removes last path segment', () => {
        expect(UrlFormat.fileToDir('/path/to/file.txt')).toBe('/path/to');
    });

    test('handles root path', () => {
        expect(UrlFormat.fileToDir('/file.txt')).toBe('/');
    });

    test('handles backslashes', () => {
        expect(UrlFormat.fileToDir('C:\\Users\\file.txt')).toBe('C:\\Users');
    });
});

describe('UrlFormat.makeUrl', () => {
    test('builds URL with query parameters', () => {
        const url = UrlFormat.makeUrl('https://example.com/api', {
            key: 'abc',
            value: 'hello world'
        });
        expect(url).toBe('https://example.com/api?key=abc&value=hello%20world');
    });

    test('encodes special characters', () => {
        const url = UrlFormat.makeUrl('https://api.com', { q: 'a&b=c' });
        expect(url).toBe('https://api.com?q=a%26b%3Dc');
    });
});

describe('UrlFormat.buildFormData', () => {
    test('builds form-encoded data', () => {
        const result = UrlFormat.buildFormData({ user: 'john', pass: 'p@ss' });
        expect(result).toBe('user=john&pass=p%40ss');
    });
});
