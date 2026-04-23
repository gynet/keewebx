import { describe, test, expect, beforeAll } from 'bun:test';

/**
 * Regression tests for `packages/core/app/scripts/util/kdbxweb/protected-value-ex.ts`.
 *
 * Specifically guards the 2026-04-09 fix to `isFieldReference()`.
 *
 * Background on the bug (preserved here so future readers don't
 * have to dig git history):
 *   - Original code returned `true` for ANY ProtectedValue whose
 *     byte length equalled the field-ref template (42 bytes), even
 *     if none of the literal characters matched.
 *   - Two independent reasons:
 *     1. The comparison `ch !== expected` was between a number
 *        (charcode from `forEachChar`) and a string (a char from
 *        `.split('')`). In strict inequality those are never equal,
 *        so the "return false on mismatch" branch was dead — and
 *        even when it wasn't dead, it only broke the `forEachChar`
 *        iteration, not the outer function.
 *     2. The outer function ended with `return true` unconditionally
 *        after `forEachChar` returned.
 *   - Downstream `_resolveFieldReference` in entry-model ran a
 *     regex on the decrypted text which filtered out the false
 *     positives, so there was no user-visible behaviour change,
 *     but the primitive was wrong and the false positives cost
 *     unnecessary decrypt + regex work on every 42-byte field.
 *
 * Fixed in commit 3a046620 (part of the 74 → 0 Phase 1 TS session).
 * Agent 2 replaced `ch !== expected` with `ch !== expected.charCodeAt(0)`
 * and introduced a `matches` flag that the callback flips to `false`
 * before breaking out of iteration.
 *
 * These tests assert the CORRECT post-fix behaviour:
 *   - True only for real field references
 *   - False for 42-byte values with mismatched literal chars
 *   - False for wrong-length values
 *   - Tolerant of any REF type char (T/N/P/A/U AND others —
 *     downstream regex narrows to [TNPAU])
 *   - Tolerant of any 32-char UUID slot content (downstream regex
 *     narrows to \w{32})
 *
 * DO NOT reintroduce a test that asserts `isFieldReference(garbage42b)`
 * returns `true` — that would pin the old bug. See `feedback_tests_must_not_lock_bugs`.
 */

// Dynamic import so the module's side-effect prototype patches run
// AFTER bun test sets up its module environment. Also avoids Bun
// complaining about top-level `import 'kdbxweb'` when the workspace
// alias is in a webpack-only path.
interface ProtectedValueWithExt {
    isFieldReference(): boolean;
    isProtected: boolean;
    byteLength: number;
    length: number;
    textLength: number;
    forEachChar(fn: (charCode: number) => void | false): void;
    includesLower(findLower: string): boolean;
    indexOfLower(findLower: string): number;
    indexOfSelfInLower(targetLower: string): number;
    equals(other: unknown): boolean;
    saltedValue(): string | number;
    dataAndSalt(): { data: number[]; salt: number[] };
    toBase64(): string;
    getText(): string;
    includes(str: string): boolean;
}

type PVCtor = new (value: ArrayBuffer | Uint8Array, salt: ArrayBuffer | Uint8Array) => ProtectedValueWithExt;

interface KdbxwebModule {
    ProtectedValue: PVCtor & {
        fromString(s: string): ProtectedValueWithExt;
        fromBase64(base64: string): ProtectedValueWithExt;
    };
    CryptoEngine: {
        random(n: number): Uint8Array;
    };
}

let kdbxweb: KdbxwebModule;

beforeAll(async () => {
    // The source file patches kdbxweb.ProtectedValue.prototype as a
    // side effect on import. Import the source first so by the time
    // we touch `kdbxweb.ProtectedValue` the prototype is extended.
    await import('../../../app/scripts/util/kdbxweb/protected-value-ex');
    kdbxweb = (await import('kdbxweb')) as unknown as KdbxwebModule;
});

function pv(s: string): ProtectedValueWithExt {
    return kdbxweb.ProtectedValue.fromString(s);
}

describe('protected-value-ex — isFieldReference()', () => {
    describe('matches valid field references', () => {
        test('T (title) reference', () => {
            expect(pv('{REF:T@I:abc123abc123abc123abc123abc123ab}').isFieldReference()).toBe(true);
        });

        test('N (notes) reference', () => {
            expect(pv('{REF:N@I:00000000000000000000000000000000}').isFieldReference()).toBe(true);
        });

        test('P (password) reference', () => {
            expect(pv('{REF:P@I:deadbeefdeadbeefdeadbeefdeadbeef}').isFieldReference()).toBe(true);
        });

        test('A (URL) reference', () => {
            expect(pv('{REF:A@I:ffffffffffffffffffffffffffffffff}').isFieldReference()).toBe(true);
        });

        test('U (user name) reference', () => {
            expect(pv('{REF:U@I:12345678901234567890123456789012}').isFieldReference()).toBe(true);
        });

        test('accepts ANY char at the REF type slot (fast check is loose, narrowed by regex downstream)', () => {
            // These are technically not valid field refs per the
            // downstream regex `/^\{REF:([TNPAU])@I:(\w{32})}$/`,
            // but isFieldReference() is a byte-level fast check —
            // false positives here are OK, false negatives are not.
            expect(pv('{REF:X@I:abc123abc123abc123abc123abc123ab}').isFieldReference()).toBe(true);
            expect(pv('{REF:Q@I:abc123abc123abc123abc123abc123ab}').isFieldReference()).toBe(true);
        });

        test('accepts any char at the 32 UUID slots (fast check is loose)', () => {
            expect(pv('{REF:T@I:!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!}').isFieldReference()).toBe(true);
            expect(pv('{REF:T@I:GHIJKLMNGHIJKLMNGHIJKLMNGHIJKLMN}').isFieldReference()).toBe(true);
        });
    });

    describe('rejects non field references with wrong literal chars', () => {
        test('prefix {NOT: instead of {REF:', () => {
            expect(pv('{NOT:T@I:abc123abc123abc123abc123abc123ab}').isFieldReference()).toBe(false);
        });

        test('missing opening brace', () => {
            expect(pv(' REF:T@I:abc123abc123abc123abc123abc123ab}').isFieldReference()).toBe(false);
        });

        test('missing closing brace', () => {
            expect(pv('{REF:T@I:abc123abc123abc123abc123abc123ab ').isFieldReference()).toBe(false);
        });

        test('wrong @ sign position', () => {
            // Same length (42 bytes), but the '@' is missing from slot 6
            // (replaced by a space) — this is exactly the regression
            // class the pre-fix code got wrong: same length, literal
            // mismatch, used to return true, now returns false.
            expect(pv('{REF:T I:abc123abc123abc123abc123abc123ab}').isFieldReference()).toBe(false);
        });

        test('garbage with right byte length (the pre-fix false-positive regression)', () => {
            expect(
                pv('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx').isFieldReference()
            ).toBe(false);
        });
    });

    describe('rejects values with wrong byte length', () => {
        test('empty string', () => {
            expect(pv('').isFieldReference()).toBe(false);
        });

        test('short string', () => {
            expect(pv('{REF:T@I:1234}').isFieldReference()).toBe(false);
        });

        test('long string', () => {
            expect(
                pv('{REF:T@I:abc123abc123abc123abc123abc123ab}extra').isFieldReference()
            ).toBe(false);
        });

        test('a plain password', () => {
            expect(pv('hunter2').isFieldReference()).toBe(false);
        });
    });

    describe('basic ProtectedValue extension surface', () => {
        test('isProtected flag is true on all instances', () => {
            expect(pv('anything').isProtected).toBe(true);
        });

        test('isProtected flag is true even for empty value', () => {
            expect(pv('').isProtected).toBe(true);
        });
    });
});

describe('protected-value-ex — length / textLength', () => {
    test('empty string has length 0', () => {
        expect(pv('').length).toBe(0);
        expect(pv('').textLength).toBe(0);
    });

    test('ASCII string reports character length', () => {
        expect(pv('hunter2').length).toBe(7);
        expect(pv('hunter2').textLength).toBe(7);
    });

    test('length and textLength agree', () => {
        const v = pv('hello world');
        expect(v.length).toBe(v.textLength);
    });

    test('single ASCII char', () => {
        expect(pv('x').length).toBe(1);
    });

    test('2-byte UTF-8 codepoints count as 1 character each', () => {
        // 'é' = U+00E9 encodes to 2 bytes in UTF-8
        // 'ñ' = U+00F1 encodes to 2 bytes
        expect(pv('éñü').textLength).toBe(3);
    });

    test('3-byte UTF-8 codepoints count as 1 character each', () => {
        // '中' = U+4E2D encodes to 3 bytes
        // '文' = U+6587 encodes to 3 bytes
        expect(pv('中文').textLength).toBe(2);
    });

    test('4-byte UTF-8 codepoints (emoji) count as 2 UTF-16 code units', () => {
        // U+1F600 (grinning face) is 4 UTF-8 bytes and 2 UTF-16 code units
        // (surrogate pair). forEachChar yields two codes, so textLength = 2.
        expect(pv('😀').textLength).toBe(2);
    });

    test('mixed ASCII + 3-byte + 4-byte string', () => {
        expect(pv('a中😀').textLength).toBe(4); // 1 + 1 + 2 (surrogate pair)
    });
});

describe('protected-value-ex — forEachChar iteration', () => {
    test('empty value yields no characters', () => {
        const chars: number[] = [];
        pv('').forEachChar((ch) => {
            chars.push(ch);
        });
        expect(chars).toEqual([]);
    });

    test('ASCII string yields ASCII charcodes in order', () => {
        const chars: number[] = [];
        pv('abc').forEachChar((ch) => {
            chars.push(ch);
        });
        expect(chars).toEqual(['a'.charCodeAt(0), 'b'.charCodeAt(0), 'c'.charCodeAt(0)]);
    });

    test('2-byte UTF-8 decodes to real Unicode codepoint', () => {
        const chars: number[] = [];
        pv('é').forEachChar((ch) => {
            chars.push(ch);
        });
        expect(chars).toEqual([0x00e9]);
    });

    test('3-byte UTF-8 decodes to real Unicode codepoint', () => {
        const chars: number[] = [];
        pv('中').forEachChar((ch) => {
            chars.push(ch);
        });
        expect(chars).toEqual([0x4e2d]);
    });

    test('4-byte UTF-8 decodes to surrogate pair', () => {
        const chars: number[] = [];
        pv('😀').forEachChar((ch) => {
            chars.push(ch);
        });
        // U+1F600 -> UTF-16 surrogate pair 0xD83D 0xDE00
        expect(chars).toEqual([0xd83d, 0xde00]);
    });

    test('callback returning false stops iteration', () => {
        const chars: number[] = [];
        pv('abcdef').forEachChar((ch) => {
            chars.push(ch);
            if (chars.length === 3) {
                return false;
            }
        });
        expect(chars.length).toBe(3);
        expect(chars).toEqual(['a'.charCodeAt(0), 'b'.charCodeAt(0), 'c'.charCodeAt(0)]);
    });

    test('iterates across mixed ASCII + non-ASCII', () => {
        const chars: number[] = [];
        pv('a中b').forEachChar((ch) => {
            chars.push(ch);
        });
        expect(chars).toEqual(['a'.charCodeAt(0), 0x4e2d, 'b'.charCodeAt(0)]);
    });

    test('regression: 3-byte UTF-8 char followed by ASCII (inherited upstream bug)', () => {
        // Background: pre-fix, the 3-byte branch was missing a `continue`
        // and fell through into the 4-byte branch's pre-read (`i++; b3 =
        // value[i]`). That silently consumed a byte belonging to the
        // NEXT character, dropping every codepoint that followed a
        // 3-byte char. So `pv('中b')` yielded `[0x4e2d]` instead of
        // `[0x4e2d, 0x62]`; `pv('中文')` yielded only one char. The bug
        // corrupted password strength analysis, password display, and
        // any search over non-ASCII protected fields.
        //
        // This test asserts the CORRECT post-fix behaviour. If the
        // `continue;` after the 3-byte branch gets removed, this test
        // (and the `pv('a中b')` one above) will fail.
        const after3Byte: number[] = [];
        pv('中b').forEachChar((ch) => {
            after3Byte.push(ch);
        });
        expect(after3Byte).toEqual([0x4e2d, 'b'.charCodeAt(0)]);

        const two3Byte: number[] = [];
        pv('中文').forEachChar((ch) => {
            two3Byte.push(ch);
        });
        expect(two3Byte).toEqual([0x4e2d, 0x6587]);

        const mixed: number[] = [];
        pv('a中文b').forEachChar((ch) => {
            mixed.push(ch);
        });
        expect(mixed).toEqual(['a'.charCodeAt(0), 0x4e2d, 0x6587, 'b'.charCodeAt(0)]);
    });
});

describe('protected-value-ex — includesLower / indexOfLower', () => {
    test('finds target at start', () => {
        expect(pv('hello world').includesLower('hello')).toBe(true);
        expect(pv('hello world').indexOfLower('hello')).toBe(0);
    });

    test('finds target in middle', () => {
        expect(pv('hello world').includesLower('lo wo')).toBe(true);
        expect(pv('hello world').indexOfLower('lo wo')).toBe(3);
    });

    test('finds target at end', () => {
        expect(pv('hello world').includesLower('world')).toBe(true);
        expect(pv('hello world').indexOfLower('world')).toBe(6);
    });

    test('case-insensitive — original is upper, search is lower', () => {
        expect(pv('HELLO').includesLower('hello')).toBe(true);
        expect(pv('HELLO').indexOfLower('hello')).toBe(0);
    });

    test('case-insensitive — original is mixed case', () => {
        expect(pv('Hello World').includesLower('hello')).toBe(true);
        expect(pv('Hello World').indexOfLower('hello')).toBe(0);
        expect(pv('Hello World').includesLower('world')).toBe(true);
        expect(pv('Hello World').indexOfLower('world')).toBe(6);
    });

    test('not found returns false / -1', () => {
        expect(pv('hello world').includesLower('xyz')).toBe(false);
        expect(pv('hello world').indexOfLower('xyz')).toBe(-1);
    });

    test('partial match at end is not a full match', () => {
        expect(pv('hello').includesLower('hellow')).toBe(false);
        expect(pv('hello').indexOfLower('hellow')).toBe(-1);
    });

    test('overlapping candidates — second candidate wins when first breaks', () => {
        // Looking for 'aba' in 'ababa':
        //   first match starts at index 0 ('aba'ba)
        //   indexOfLower returns the first one
        expect(pv('ababa').indexOfLower('aba')).toBe(0);
        expect(pv('ababa').includesLower('aba')).toBe(true);
    });

    test('single-char target', () => {
        expect(pv('abcdef').indexOfLower('c')).toBe(2);
        expect(pv('abcdef').includesLower('c')).toBe(true);
    });

    test('single-char target not present', () => {
        expect(pv('abcdef').indexOfLower('z')).toBe(-1);
        expect(pv('abcdef').includesLower('z')).toBe(false);
    });

    test('target at offset requiring restart (false start, true match later)', () => {
        // 'heaven hello' — 'hel' does not match 'hea', then does match at index 7
        expect(pv('heaven hello').indexOfLower('hel')).toBe(7);
    });

    test('empty source', () => {
        expect(pv('').includesLower('x')).toBe(false);
        expect(pv('').indexOfLower('x')).toBe(-1);
    });
});

describe('protected-value-ex — indexOfSelfInLower', () => {
    test('short protected value found at start of target', () => {
        expect(pv('hello').indexOfSelfInLower('hello world')).toBe(0);
    });

    test('short protected value found in middle of target', () => {
        expect(pv('llo w').indexOfSelfInLower('hello world')).toBe(2);
    });

    test('short protected value found at end of target', () => {
        expect(pv('world').indexOfSelfInLower('hello world')).toBe(6);
    });

    test('protected value not in target returns -1', () => {
        expect(pv('xyz').indexOfSelfInLower('hello world')).toBe(-1);
    });

    test('single char match', () => {
        expect(pv('w').indexOfSelfInLower('hello world')).toBe(6);
    });

    test('case-insensitive (target is lowercased by caller convention)', () => {
        // The method name says "InLower" — caller is expected to pass a
        // lowercase target. Protected value's chars are lowercased inside
        // the loop. So pv('HELLO') should find itself in 'hello world'.
        expect(pv('HELLO').indexOfSelfInLower('hello world')).toBe(0);
    });

    test('skips false starts and finds later match', () => {
        // pv('cat') in 'caterpillar category cat':
        //   - index 0: 'cat' matches → returns 0 (first hit)
        expect(pv('cat').indexOfSelfInLower('caterpillar category cat')).toBe(0);
    });

    test('first char appears but full sequence does not', () => {
        expect(pv('abx').indexOfSelfInLower('abcdef')).toBe(-1);
    });
});

describe('protected-value-ex — equals', () => {
    test('equals returns false for null / undefined', () => {
        expect(pv('hello').equals(null)).toBe(false);
        expect(pv('hello').equals(undefined)).toBe(false);
    });

    test('equals same ProtectedValue instance returns true', () => {
        const v = pv('hello');
        expect(v.equals(v)).toBe(true);
    });

    test('equals two ProtectedValues with same plaintext (different salt) returns true', () => {
        // Each fromString() call generates a fresh random salt, so the
        // raw bytes differ but the decrypted plaintext is identical.
        // equals() must compare plaintext, not raw bytes.
        expect(pv('hello').equals(pv('hello'))).toBe(true);
    });

    test('equals two ProtectedValues with different plaintext returns false', () => {
        expect(pv('hello').equals(pv('world'))).toBe(false);
    });

    test('equals two ProtectedValues of different length returns false', () => {
        expect(pv('hello').equals(pv('hello world'))).toBe(false);
    });

    test('equals plain-string-like object via includes() path', () => {
        // When `other.isProtected` is falsy, equals() falls back to
        // comparing textLength and calling this.includes(other).
        // kdbxweb's ProtectedValue.includes(str) accepts a string.
        // Passing a ProtectedValue-shaped object without isProtected
        // would route through includes; the structural test here is
        // best done by spoofing the object shape.
        const spoof = { length: 5, isProtected: false };
        // textLength of 'hello' is 5, and includes('hello') === false
        // because the argument is an object not a string — so equals
        // should return false (not throw).
        expect(() => pv('hello').equals(spoof)).not.toThrow();
    });

    test('empty ProtectedValues equal each other', () => {
        expect(pv('').equals(pv(''))).toBe(true);
    });

    test('unicode equality', () => {
        expect(pv('中文').equals(pv('中文'))).toBe(true);
        expect(pv('中文').equals(pv('英文'))).toBe(false);
    });
});

describe('protected-value-ex — saltedValue', () => {
    test('empty value returns 0 (sentinel)', () => {
        expect(pv('').saltedValue()).toBe(0);
    });

    test('non-empty value returns a string', () => {
        expect(typeof pv('hello').saltedValue()).toBe('string');
    });

    test('salted value has same byte length as plaintext (1 byte per input byte)', () => {
        const v = pv('hello');
        const salted = v.saltedValue();
        expect(typeof salted).toBe('string');
        if (typeof salted === 'string') {
            expect(salted.length).toBe(v.byteLength);
        }
    });

    test('same plaintext value has same salted value within session (idempotent)', () => {
        // saltedValue should be a function of plaintext XOR session salt —
        // plaintext identical + session salt identical → same output.
        expect(pv('hello').saltedValue()).toBe(pv('hello').saltedValue());
    });

    test('different plaintexts produce different salted values', () => {
        expect(pv('hello').saltedValue()).not.toBe(pv('world').saltedValue());
    });

    test('single-char plaintexts with different content differ', () => {
        // Very high likelihood of different outputs; session salt is fixed.
        expect(pv('a').saltedValue()).not.toBe(pv('b').saltedValue());
    });
});

describe('protected-value-ex — dataAndSalt', () => {
    test('returns an object with data and salt arrays', () => {
        const result = pv('hello').dataAndSalt();
        expect(Array.isArray(result.data)).toBe(true);
        expect(Array.isArray(result.salt)).toBe(true);
    });

    test('data and salt arrays have same length as byteLength', () => {
        const v = pv('hello');
        const result = v.dataAndSalt();
        expect(result.data.length).toBe(v.byteLength);
        expect(result.salt.length).toBe(v.byteLength);
    });

    test('data XOR salt reconstructs plaintext bytes', () => {
        const v = pv('hi');
        const { data, salt } = v.dataAndSalt();
        const recovered = data.map((b, i) => b ^ salt[i]);
        // 'hi' = [0x68, 0x69]
        expect(recovered).toEqual([0x68, 0x69]);
    });

    test('empty value produces empty arrays', () => {
        const result = pv('').dataAndSalt();
        expect(result.data).toEqual([]);
        expect(result.salt).toEqual([]);
    });
});

describe('protected-value-ex — toBase64 / fromBase64 round-trip', () => {
    test('toBase64 returns a string', () => {
        expect(typeof pv('hello').toBase64()).toBe('string');
    });

    test('empty value round-trips through base64', () => {
        const original = pv('');
        const b64 = original.toBase64();
        const restored = kdbxweb.ProtectedValue.fromBase64(b64);
        expect(restored.byteLength).toBe(0);
        expect(restored.getText()).toBe('');
    });

    test('ASCII value round-trips through base64', () => {
        const original = pv('hello world');
        const b64 = original.toBase64();
        const restored = kdbxweb.ProtectedValue.fromBase64(b64);
        expect(restored.getText()).toBe('hello world');
        expect(restored.byteLength).toBe(11);
    });

    test('unicode value round-trips through base64', () => {
        const original = pv('中文 éñ 😀');
        const b64 = original.toBase64();
        const restored = kdbxweb.ProtectedValue.fromBase64(b64);
        expect(restored.getText()).toBe('中文 éñ 😀');
    });

    test('toBase64 output is valid base64 (only valid chars)', () => {
        const b64 = pv('hello').toBase64();
        expect(b64).toMatch(/^[A-Za-z0-9+/]*=*$/);
    });
});
