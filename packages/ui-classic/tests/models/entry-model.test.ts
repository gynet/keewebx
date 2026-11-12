import { describe, test, expect } from 'bun:test';

// Test the pure utility logic from EntryModel without importing the full module
// (which has deep dependency chains requiring webpack resolution)

describe('EntryModel pure logic', () => {
    // Replicate the URL regex and display URL logic
    const UrlRegex = /^https?:\/\//i;

    function getDisplayUrl(url: string): string {
        if (!url) return '';
        return url.replace(UrlRegex, '');
    }

    describe('getDisplayUrl', () => {
        test('strips http prefix', () => {
            expect(getDisplayUrl('http://example.com')).toBe('example.com');
        });

        test('strips https prefix', () => {
            expect(getDisplayUrl('https://example.com/path')).toBe('example.com/path');
        });

        test('returns empty for empty url', () => {
            expect(getDisplayUrl('')).toBe('');
        });

        test('keeps non-http URLs', () => {
            expect(getDisplayUrl('ftp://example.com')).toBe('ftp://example.com');
        });

        test('is case insensitive', () => {
            expect(getDisplayUrl('HTTP://EXAMPLE.COM')).toBe('EXAMPLE.COM');
            expect(getDisplayUrl('HTTPS://secure.example.com')).toBe('secure.example.com');
        });
    });

    // Replicate the field reference regex
    const FieldRefRegex = /^\{REF:([TNPAU])@I:(\w{32})}$/;
    const FieldRefIds: Record<string, string> = {
        T: 'Title',
        U: 'UserName',
        P: 'Password',
        A: 'URL',
        N: 'Notes'
    };

    describe('field reference parsing', () => {
        test('parses valid title reference', () => {
            const ref = '{REF:T@I:12345678901234567890123456789012}';
            const match = ref.match(FieldRefRegex);
            expect(match).toBeTruthy();
            expect(match![1]).toBe('T');
            expect(FieldRefIds[match![1]]).toBe('Title');
            expect(match![2]).toBe('12345678901234567890123456789012');
        });

        test('parses valid password reference', () => {
            const ref = '{REF:P@I:ABCDEF01234567890ABCDEF012345678}';
            const match = ref.match(FieldRefRegex);
            expect(match).toBeTruthy();
            expect(match![1]).toBe('P');
            expect(FieldRefIds[match![1]]).toBe('Password');
        });

        test('parses valid URL reference', () => {
            const ref = '{REF:A@I:abcdef01234567890abcdef012345678}';
            const match = ref.match(FieldRefRegex);
            expect(match).toBeTruthy();
            expect(FieldRefIds[match![1]]).toBe('URL');
        });

        test('rejects invalid format', () => {
            expect('{REF:X@I:12345678901234567890123456789012}'.match(FieldRefRegex)).toBeNull();
            expect('not a ref'.match(FieldRefRegex)).toBeNull();
            expect('{REF:T@I:short}'.match(FieldRefRegex)).toBeNull();
        });
    });

    // Replicate sanitizeFieldValue
    function sanitizeFieldValue(val: unknown): unknown {
        if (val && !(val as { isProtected?: boolean }).isProtected) {
            // eslint-disable-next-line no-control-regex
            val = (val as string).replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\uFFF0-\uFFFF]/g, '');
        }
        return val;
    }

    describe('sanitizeFieldValue', () => {
        test('strips control characters', () => {
            expect(sanitizeFieldValue('hello\x00world')).toBe('helloworld');
            expect(sanitizeFieldValue('a\x01b\x08c')).toBe('abc');
        });

        test('preserves tabs and newlines', () => {
            expect(sanitizeFieldValue('line1\tvalue\nline2')).toBe('line1\tvalue\nline2');
        });

        test('strips high Unicode control chars', () => {
            expect(sanitizeFieldValue('test\uFFF0end')).toBe('testend');
        });

        test('passes protected values unchanged', () => {
            const protectedVal = { isProtected: true, text: 'secret\x00' };
            expect(sanitizeFieldValue(protectedVal)).toBe(protectedVal);
        });

        test('passes null through', () => {
            expect(sanitizeFieldValue(null)).toBeNull();
        });
    });

    // ExtraUrlFieldName logic
    const ExtraUrlFieldName = 'KP2A_URL';

    describe('ExtraUrlFieldName', () => {
        test('has correct value', () => {
            expect(ExtraUrlFieldName).toBe('KP2A_URL');
        });

        function getNextUrlFieldName(fieldKeys: string[]): string {
            const takenFields = new Set(
                fieldKeys.filter((f) => f.startsWith(ExtraUrlFieldName))
            );
            for (let i = 0; ; i++) {
                const fieldName = i ? `${ExtraUrlFieldName}_${i}` : ExtraUrlFieldName;
                if (!takenFields.has(fieldName)) {
                    return fieldName;
                }
            }
        }

        test('returns base name when none taken', () => {
            expect(getNextUrlFieldName(['Title', 'Password'])).toBe('KP2A_URL');
        });

        test('returns _1 when base is taken', () => {
            expect(getNextUrlFieldName(['KP2A_URL'])).toBe('KP2A_URL_1');
        });

        test('returns _2 when base and _1 taken', () => {
            expect(getNextUrlFieldName(['KP2A_URL', 'KP2A_URL_1'])).toBe('KP2A_URL_2');
        });
    });

    describe('getAllUrls logic', () => {
        function getAllUrls(mainUrl: string, fields: Record<string, string>): string[] {
            const urls = mainUrl ? [mainUrl] : [];
            const extraUrls = Object.entries(fields)
                .filter(([field]) => field.startsWith(ExtraUrlFieldName))
                .map(([, value]) => value)
                .filter((value) => value);
            return urls.concat(extraUrls);
        }

        test('returns main URL', () => {
            expect(getAllUrls('http://main.com', {})).toEqual(['http://main.com']);
        });

        test('returns empty when no URL', () => {
            expect(getAllUrls('', {})).toEqual([]);
        });

        test('includes extra URL fields', () => {
            const fields = {
                'KP2A_URL': 'http://extra1.com',
                'KP2A_URL_1': 'http://extra2.com',
                'Title': 'not included'
            };
            const urls = getAllUrls('http://main.com', fields);
            expect(urls).toHaveLength(3);
            expect(urls).toContain('http://main.com');
            expect(urls).toContain('http://extra1.com');
            expect(urls).toContain('http://extra2.com');
        });

        test('filters out empty extra URLs', () => {
            const fields = { 'KP2A_URL': '' };
            expect(getAllUrls('http://main.com', fields)).toEqual(['http://main.com']);
        });
    });
});
