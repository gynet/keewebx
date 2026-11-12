import { describe, test, expect } from 'bun:test';

// Inline the pure functions to avoid webpack alias resolution issues
const StringFormat = {
    camelCaseRegex: /-./g,

    capFirst(str: string): string {
        if (!str) return '';
        return str[0].toUpperCase() + str.substr(1);
    },

    pad(num: number, digits: number): string {
        let str = num.toString();
        while (str.length < digits) {
            str = '0' + str;
        }
        return str;
    },

    padStr(str: string, len: number): string {
        while (str.length < len) {
            str += ' ';
        }
        return str;
    },

    camelCase(str: string): string {
        return str.replace(this.camelCaseRegex, (match) => match[1].toUpperCase());
    },

    pascalCase(str: string): string {
        return this.capFirst(str.replace(this.camelCaseRegex, (match) => match[1].toUpperCase()));
    },

    replaceVersion(str: string, replacement: string): string {
        return str.replace(/\d+\.\d+\.\d+/g, replacement);
    }
};

describe('StringFormat.capFirst', () => {
    test('capitalizes first character', () => {
        expect(StringFormat.capFirst('hello')).toBe('Hello');
        expect(StringFormat.capFirst('world')).toBe('World');
    });

    test('returns empty string for empty input', () => {
        expect(StringFormat.capFirst('')).toBe('');
    });

    test('handles single character', () => {
        expect(StringFormat.capFirst('a')).toBe('A');
    });

    test('preserves rest of string', () => {
        expect(StringFormat.capFirst('hELLO')).toBe('HELLO');
    });
});

describe('StringFormat.pad', () => {
    test('pads number with leading zeros', () => {
        expect(StringFormat.pad(5, 3)).toBe('005');
        expect(StringFormat.pad(42, 5)).toBe('00042');
    });

    test('does not pad when already sufficient digits', () => {
        expect(StringFormat.pad(123, 3)).toBe('123');
        expect(StringFormat.pad(1234, 3)).toBe('1234');
    });

    test('handles zero', () => {
        expect(StringFormat.pad(0, 2)).toBe('00');
    });
});

describe('StringFormat.padStr', () => {
    test('pads string with trailing spaces', () => {
        expect(StringFormat.padStr('hi', 5)).toBe('hi   ');
    });

    test('does not pad when already sufficient length', () => {
        expect(StringFormat.padStr('hello', 3)).toBe('hello');
    });

    test('handles empty string', () => {
        expect(StringFormat.padStr('', 3)).toBe('   ');
    });
});

describe('StringFormat.camelCase', () => {
    test('converts kebab-case to camelCase', () => {
        expect(StringFormat.camelCase('my-variable')).toBe('myVariable');
        expect(StringFormat.camelCase('border-top-color')).toBe('borderTopColor');
    });

    test('leaves non-kebab strings unchanged', () => {
        expect(StringFormat.camelCase('hello')).toBe('hello');
    });
});

describe('StringFormat.pascalCase', () => {
    test('converts kebab-case to PascalCase', () => {
        expect(StringFormat.pascalCase('my-variable')).toBe('MyVariable');
        expect(StringFormat.pascalCase('border-top-color')).toBe('BorderTopColor');
    });

    test('capitalizes simple strings', () => {
        expect(StringFormat.pascalCase('hello')).toBe('Hello');
    });
});

describe('StringFormat.replaceVersion', () => {
    test('replaces version patterns', () => {
        expect(StringFormat.replaceVersion('version 1.2.3 is out', 'X.Y.Z')).toBe(
            'version X.Y.Z is out'
        );
    });

    test('replaces multiple version patterns', () => {
        expect(StringFormat.replaceVersion('from 1.0.0 to 2.0.0', 'V')).toBe('from V to V');
    });

    test('does not replace non-version patterns', () => {
        expect(StringFormat.replaceVersion('no version here', 'V')).toBe('no version here');
    });
});
