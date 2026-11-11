import * as kdbxweb from 'kdbxweb';
import { phonetic } from 'util/generators/phonetic';
import { shuffle } from 'util/fn';

interface PasswordGeneratorOptions {
    length: number;
    name?: string;
    upper?: boolean;
    lower?: boolean;
    digits?: boolean;
    special?: boolean;
    brackets?: boolean;
    high?: boolean;
    ambiguous?: boolean;
    include?: string;
    pattern?: string;
    [key: string]: unknown;
}

interface DerivedOpts {
    length: number;
    [key: string]: unknown;
}

const CharRanges: Record<string, string> = {
    upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
    lower: 'abcdefghijkmnpqrstuvwxyz',
    digits: '123456789',
    special: '!@#$%^&*_+-=,./?;:`"~\'\\',
    brackets: '(){}[]<>',
    high:
        '\u00A1\u00A2\u00A3\u00A4\u00A5\u00A6\u00A7\u00A9\u00AA\u00AB\u00AC\u00AE\u00AF\u00B0\u00B1\u00B2\u00B3\u00B4\u00B5\u00B6\u00B9\u00BA\u00BB\u00BC\u00BD\u00BE\u00BF\u00C0\u00C1\u00C2\u00C3\u00C4\u00C5\u00C6\u00C7\u00C8\u00C9\u00CA\u00CB\u00CC\u00CD\u00CE\u00CF\u00D0\u00D1\u00D2\u00D3\u00D4\u00D5\u00D6\u00D7\u00D8\u00D9\u00DA\u00DB\u00DC\u00DD\u00DE\u00DF\u00E0\u00E1\u00E2\u00E3\u00E4\u00E5\u00E6\u00E7\u00E8\u00E9\u00EA\u00EB\u00EC\u00ED\u00EE\u00EF\u00F0\u00F1\u00F2\u00F3\u00F4\u00F5\u00F6\u00F7\u00F8\u00F9\u00FA\u00FB\u00FC\u00FD\u00FE',
    ambiguous: 'O0oIl'
};

const DefaultCharRangesByPattern: Record<string, string> = {
    'A': CharRanges.upper,
    'a': CharRanges.lower,
    '1': CharRanges.digits,
    '*': CharRanges.special,
    '[': CharRanges.brackets,
    '\u00C4': CharRanges.high,
    '0': CharRanges.ambiguous
};

const PasswordGenerator = {
    generate(opts: PasswordGeneratorOptions): string {
        if (!opts || typeof opts.length !== 'number' || opts.length < 0) {
            return '';
        }
        if (opts.name === 'Pronounceable') {
            return this.generatePronounceable(opts);
        }
        const ranges: string[] = Object.keys(CharRanges)
            .filter((r) => opts[r])
            .map((r) => CharRanges[r]);
        if (opts.include && opts.include.length) {
            ranges.push(opts.include);
        }
        if (!ranges.length) {
            return '';
        }
        const rangesByPatternChar: Record<string, string> = {
            ...DefaultCharRangesByPattern,
            'I': opts.include || ''
        };
        const pattern = opts.pattern || 'X';

        let countDefaultChars = 0;
        for (let i = 0; i < opts.length; i++) {
            const patternChar = pattern[i % pattern.length];
            if (patternChar === 'X') {
                countDefaultChars++;
            }
        }

        const rangeIxRandomBytes = kdbxweb.CryptoEngine.random(countDefaultChars);
        const rangeCharRandomBytes = kdbxweb.CryptoEngine.random(countDefaultChars);
        const defaultRangeGeneratedChars: string[] = [];
        for (let i = 0; i < countDefaultChars; i++) {
            const rangeIx = i < ranges.length ? i : rangeIxRandomBytes[i] % ranges.length;
            const range = ranges[rangeIx];
            const char = range[rangeCharRandomBytes[i] % range.length];
            defaultRangeGeneratedChars.push(char);
        }
        shuffle(defaultRangeGeneratedChars);

        const randomBytes = kdbxweb.CryptoEngine.random(opts.length);
        const chars: string[] = [];
        for (let i = 0; i < opts.length; i++) {
            const rand = Math.round(Math.random() * 1000) + randomBytes[i];
            const patternChar = pattern[i % pattern.length];
            if (patternChar === 'X') {
                chars.push(defaultRangeGeneratedChars.pop()!);
            } else {
                const range = rangesByPatternChar[patternChar];
                const char = range ? range[rand % range.length] : patternChar;
                chars.push(char);
            }
        }
        return chars.join('');
    },

    generatePronounceable(opts: PasswordGeneratorOptions): string {
        const pass = phonetic.generate({
            length: opts.length
        });
        let result = '';
        const upper: number[] = [];
        let i: number;
        if (opts.upper) {
            for (i = 0; i < pass.length; i += 8) {
                upper.push(Math.floor(Math.random() * opts.length));
            }
        }
        for (i = 0; i < pass.length; i++) {
            let ch = pass[i];
            if (upper.indexOf(i) >= 0) {
                ch = ch.toUpperCase();
            }
            result += ch;
        }
        return result.substr(0, opts.length);
    },

    deriveOpts(password: kdbxweb.ProtectedValue | null | undefined): DerivedOpts {
        const opts: DerivedOpts = { length: 0 };
        let length = 0;
        if (password) {
            const charRanges = CharRanges;
            password.forEachChar((ch: number) => {
                length++;
                const chStr = String.fromCharCode(ch);
                for (const [range, chars] of Object.entries(charRanges)) {
                    if (chars.indexOf(chStr) >= 0) {
                        (opts as Record<string, unknown>)[range] = true;
                    }
                }
            });
        }
        opts.length = length;
        return opts;
    }
};

export { PasswordGenerator, CharRanges };
