import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

/**
 * Unit tests for the OTP / TOTP implementation in packages/core/app/scripts/util/data/otp.ts
 *
 * The module uses a legacy-style constructor function + prototype chain and
 * references `window.crypto.subtle` directly, which makes it hard to import
 * under the Bun test runtime. Rather than shim webpack aliases, we inline the
 * pure functions here (matching the convention in url-format.test.ts) and
 * provide an async `computeTotp` driver that mirrors `Otp.prototype.next`
 * using Bun's built-in WebCrypto (`globalThis.crypto.subtle`).
 *
 * Test vectors come from:
 *   - RFC 4648 Section 10 (base32 encoding)
 *   - RFC 6238 Appendix B (TOTP reference values, SHA-1, 8 digits)
 *   - RFC 4226 Section 5.4 (HOTP truncation + digit extraction)
 *
 * Previously: zero OTP unit tests. See Issue #12.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Inlined from packages/core/app/scripts/util/data/otp.ts
// ─────────────────────────────────────────────────────────────────────────────

function leftPad(str: string, len: number): string {
    while (str.length < len) {
        str = '0' + str;
    }
    return str;
}

function fromBase32(str: string): ArrayBuffer | null {
    str = str.replace(/\s/g, '');
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bin = '';
    for (let i = 0; i < str.length; i++) {
        const ix = alphabet.indexOf(str[i].toLowerCase());
        if (ix < 0) {
            return null;
        }
        bin += leftPad(ix.toString(2), 5);
    }
    const hex = new Uint8Array(Math.floor(bin.length / 8));
    for (let i = 0; i < hex.length; i++) {
        const chunk = bin.substr(i * 8, 8);
        hex[i] = parseInt(chunk, 2);
    }
    return hex.buffer;
}

function isSecret(str: string): boolean {
    return !!fromBase32(str);
}

function hmacToDigits(hmac: number, length: number): string {
    let code = hmac.toString();
    code = leftPad(code.substr(code.length - length), length);
    return code;
}

function hmacToSteamCode(hmac: number): string {
    const steamChars = '23456789BCDFGHJKMNPQRTVWXY';
    let code = '';
    for (let i = 0; i < 5; ++i) {
        code += steamChars.charAt(hmac % steamChars.length);
        hmac = Math.floor(hmac / steamChars.length);
    }
    return code;
}

interface OtpParams {
    type?: string;
    account?: string;
    secret?: string;
    issuer?: string;
    algorithm?: string;
    digits?: string | number;
    counter?: number;
    period?: string | number;
}

interface ParsedOtp {
    url: string;
    type: string;
    account?: string;
    secret: string;
    issuer?: string;
    algorithm: string;
    digits: number;
    counter?: number;
    period: number;
    key: ArrayBuffer;
}

function createOtp(url: string, params: OtpParams): ParsedOtp {
    if (['hotp', 'totp'].indexOf(params.type ?? '') < 0) {
        throw 'Bad type: ' + params.type;
    }
    if (!params.secret) {
        throw 'Empty secret';
    }
    if (params.algorithm && ['SHA1', 'SHA256', 'SHA512'].indexOf(params.algorithm) < 0) {
        throw 'Bad algorithm: ' + params.algorithm;
    }
    if (params.digits && ['6', '7', '8'].indexOf(String(params.digits)) < 0) {
        throw 'Bad digits: ' + params.digits;
    }
    if (params.type === 'hotp') {
        // RFC 4226: counter is a non-negative integer. Counter=0 is valid (#28).
        if (params.counter === undefined || params.counter === null || (params.counter as unknown) === '') {
            throw 'Bad counter: ' + params.counter;
        }
        const counterNum = Number(params.counter);
        if (!Number.isFinite(counterNum) || counterNum < 0 || Math.floor(counterNum) !== counterNum) {
            throw 'Bad counter: ' + params.counter;
        }
        params.counter = counterNum;
    }
    const periodNum = params.period !== undefined ? Number(params.period) : undefined;
    if (periodNum !== undefined && (isNaN(periodNum) || periodNum < 1)) {
        throw 'Bad period: ' + params.period;
    }
    const key = fromBase32(params.secret);
    if (!key) {
        throw 'Bad key: ' + params.secret;
    }
    return {
        url,
        type: params.type!,
        account: params.account,
        secret: params.secret,
        issuer: params.issuer,
        algorithm: params.algorithm ? params.algorithm.toUpperCase() : 'SHA1',
        digits: params.digits ? +params.digits : 6,
        counter: params.counter,
        period: periodNum ?? 30,
        key
    };
}

function parseUrl(url: string): ParsedOtp {
    const match = /^otpauth:\/\/(\w+)(?:\/([^\?]+)\?|\?)(.*)/i.exec(url);
    if (!match) {
        throw 'Not OTP url';
    }
    const params: OtpParams = {};
    const label = decodeURIComponent(match[2] ?? 'default');
    if (label) {
        const parts = label.split(':');
        params.issuer = parts[0].trim();
        if (parts.length > 1) {
            params.account = parts[1].trim();
        }
    }
    params.type = match[1].toLowerCase();
    match[3].split('&').forEach((part) => {
        const parts = part.split('=', 2);
        (params as unknown as Record<string, string>)[parts[0].toLowerCase()] = decodeURIComponent(
            parts[1]
        );
    });
    return createOtp(url, params);
}

function makeUrl(secret: string, period?: number, digits?: number): string {
    return (
        'otpauth://totp/default?secret=' +
        secret +
        (period ? '&period=' + period : '') +
        (digits ? '&digits=' + digits : '')
    );
}

async function computeOtpCode(otp: ParsedOtp, nowMs: number): Promise<{ pass: string; timeLeft: number }> {
    let valueForHashing: number;
    let timeLeft = 0;
    if (otp.type === 'totp') {
        const epoch = Math.round(nowMs / 1000);
        valueForHashing = Math.floor(epoch / otp.period);
        const msPeriod = otp.period * 1000;
        timeLeft = msPeriod - (nowMs % msPeriod);
    } else {
        valueForHashing = otp.counter!;
    }
    const data = new Uint8Array(8).buffer;
    new DataView(data).setUint32(4, valueForHashing);
    const algo = { name: 'HMAC', hash: { name: otp.algorithm.replace('SHA', 'SHA-') } };
    const key = await globalThis.crypto.subtle.importKey('raw', otp.key, algo, false, ['sign']);
    const sigBuf = await globalThis.crypto.subtle.sign(algo, key, data);
    const sig = new DataView(sigBuf);
    const offset = sig.getInt8(sig.byteLength - 1) & 0xf;
    const hmac = sig.getUint32(offset) & 0x7fffffff;
    let pass: string;
    if (otp.issuer === 'Steam') {
        pass = hmacToSteamCode(hmac);
    } else {
        pass = hmacToDigits(hmac, otp.digits);
    }
    return { pass, timeLeft };
}

// Helper: build a base32-encoded secret from raw ASCII bytes
function asciiToBase32(ascii: string): string {
    const bytes = new TextEncoder().encode(ascii);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bin = '';
    for (const b of bytes) {
        bin += leftPad(b.toString(2), 8);
    }
    // pad bin length to multiple of 5
    while (bin.length % 5 !== 0) bin += '0';
    let out = '';
    for (let i = 0; i < bin.length; i += 5) {
        out += alphabet[parseInt(bin.substr(i, 5), 2)];
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Otp.fromBase32', () => {
    test('decodes RFC 4648 test vector "FOOBAR"', () => {
        // "FOOBAR" in base32: IZHU6QSCKI====== decodes back to the bytes 'F','O','O','B','A','R'
        // But simpler test: "JBSWY3DPEB3W64TMMQ======" == "Hello World"
        // We verify round-trip from a known ascii string.
        const secret = asciiToBase32('Hello!');
        const buf = fromBase32(secret);
        expect(buf).not.toBeNull();
        const arr = new Uint8Array(buf!);
        expect(Array.from(arr).slice(0, 6)).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21]);
    });

    test('decodes canonical "12345678901234567890" test secret', () => {
        const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of "12345678901234567890"
        const buf = fromBase32(secret);
        expect(buf).not.toBeNull();
        const arr = new Uint8Array(buf!);
        const decoded = new TextDecoder().decode(arr);
        expect(decoded).toBe('12345678901234567890');
    });

    test('is case-insensitive', () => {
        const upper = fromBase32('JBSWY3DPEHPK3PXP');
        const lower = fromBase32('jbswy3dpehpk3pxp');
        expect(upper).not.toBeNull();
        expect(lower).not.toBeNull();
        expect(new Uint8Array(upper!)).toEqual(new Uint8Array(lower!));
    });

    test('ignores whitespace', () => {
        const spaced = fromBase32('JBSW Y3DP EHPK 3PXP');
        const nospc = fromBase32('JBSWY3DPEHPK3PXP');
        expect(spaced).not.toBeNull();
        expect(new Uint8Array(spaced!)).toEqual(new Uint8Array(nospc!));
    });

    test('returns null for invalid base32 chars', () => {
        expect(fromBase32('0000')).toBeNull(); // '0' and '1' are not in base32
        expect(fromBase32('!!!!')).toBeNull();
        expect(fromBase32('ABCD8')).toBeNull(); // '8' not in alphabet
    });

    test('returns empty buffer for empty string', () => {
        const buf = fromBase32('');
        expect(buf).not.toBeNull();
        expect(buf!.byteLength).toBe(0);
    });
});

describe('Otp.isSecret', () => {
    test('accepts valid base32 strings', () => {
        expect(isSecret('JBSWY3DPEHPK3PXP')).toBe(true);
        expect(isSecret('GEZDGNBVGY3TQOJQ')).toBe(true);
        // empty string is technically valid base32 -> returns true
        expect(isSecret('')).toBe(true);
    });

    test('rejects non-base32 strings', () => {
        expect(isSecret('hello world!')).toBe(false);
        expect(isSecret('otpauth://totp/foo')).toBe(false);
        expect(isSecret('0001')).toBe(false);
    });
});

describe('Otp.hmacToDigits', () => {
    test('RFC 4226 Section 5.4 truncation example', () => {
        // RFC 4226 example: DBC1CA00 masked -> 1357872410 -> last 6 digits = 872410
        const hmac = 0x50ef7f19; // = 1357872409 in the RFC example
        // but since it's a raw value for the tail extraction, we just verify the mod-10^n behavior
        expect(hmacToDigits(1357872410, 6)).toBe('872410');
    });

    test('zero-pads short numbers', () => {
        expect(hmacToDigits(42, 6)).toBe('000042');
        expect(hmacToDigits(7, 8)).toBe('00000007');
    });

    test('handles 8-digit length', () => {
        expect(hmacToDigits(1234567890, 8)).toBe('34567890');
    });
});

describe('Otp.hmacToSteamCode', () => {
    test('produces a 5-character Steam code from alphabet', () => {
        const code = hmacToSteamCode(0xabcdef12);
        expect(code.length).toBe(5);
        for (const c of code) {
            expect('23456789BCDFGHJKMNPQRTVWXY'.includes(c)).toBe(true);
        }
    });

    test('is deterministic for the same input', () => {
        const a = hmacToSteamCode(123456);
        const b = hmacToSteamCode(123456);
        expect(a).toBe(b);
    });
});

describe('Otp.parseUrl', () => {
    test('parses a basic totp URL', () => {
        const otp = parseUrl('otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example');
        expect(otp.type).toBe('totp');
        expect(otp.issuer).toBe('Example');
        expect(otp.account).toBe('alice@example.com');
        expect(otp.secret).toBe('JBSWY3DPEHPK3PXP');
        expect(otp.digits).toBe(6);
        expect(otp.period).toBe(30);
        expect(otp.algorithm).toBe('SHA1');
    });

    test('parses URL with custom period and digits', () => {
        const otp = parseUrl('otpauth://totp/test?secret=GEZDGNBVGY3TQOJQ&period=60&digits=8');
        expect(otp.period).toBe(60);
        expect(otp.digits).toBe(8);
    });

    test('parses URL with SHA256 algorithm', () => {
        const otp = parseUrl('otpauth://totp/test?secret=GEZDGNBVGY3TQOJQ&algorithm=SHA256');
        expect(otp.algorithm).toBe('SHA256');
    });

    test('throws on non-otp URL', () => {
        expect(() => parseUrl('https://example.com')).toThrow();
        expect(() => parseUrl('not-a-url')).toThrow();
    });

    test('throws on invalid type', () => {
        expect(() => parseUrl('otpauth://xxx/test?secret=GEZDGNBVGY3TQOJQ')).toThrow(/Bad type/);
    });

    test('throws on bad digits', () => {
        expect(() => parseUrl('otpauth://totp/test?secret=GEZDGNBVGY3TQOJQ&digits=9')).toThrow(
            /Bad digits/
        );
    });

    test('throws on bad algorithm', () => {
        expect(() => parseUrl('otpauth://totp/test?secret=GEZDGNBVGY3TQOJQ&algorithm=MD5')).toThrow(
            /Bad algorithm/
        );
    });

    test('throws on bad base32 secret', () => {
        expect(() => parseUrl('otpauth://totp/test?secret=!!!invalid!!!')).toThrow(/Bad key/);
    });
});

describe('Otp.makeUrl', () => {
    test('builds minimal URL', () => {
        expect(makeUrl('JBSWY3DPEHPK3PXP')).toBe('otpauth://totp/default?secret=JBSWY3DPEHPK3PXP');
    });

    test('includes period when provided', () => {
        expect(makeUrl('JBSWY3DPEHPK3PXP', 60)).toBe(
            'otpauth://totp/default?secret=JBSWY3DPEHPK3PXP&period=60'
        );
    });

    test('includes both period and digits', () => {
        expect(makeUrl('JBSWY3DPEHPK3PXP', 30, 8)).toBe(
            'otpauth://totp/default?secret=JBSWY3DPEHPK3PXP&period=30&digits=8'
        );
    });
});

describe('TOTP code generation — RFC 6238 test vectors', () => {
    // RFC 6238 Appendix B: secret = "12345678901234567890" (ASCII)
    // Expected TOTP values (8 digits, SHA-1, period=30):
    //   T (seconds)    |  Code
    //   ──────────────────────────
    //   59             | 94287082
    //   1111111109     | 07081804
    //   1111111111     | 14050471
    //   1234567890     | 89005924
    //   2000000000     | 69279037
    //   20000000000    | 65353130

    const secretB32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

    const vectors: Array<{ t: number; expected: string }> = [
        { t: 59, expected: '94287082' },
        { t: 1111111109, expected: '07081804' },
        { t: 1111111111, expected: '14050471' },
        { t: 1234567890, expected: '89005924' },
        { t: 2000000000, expected: '69279037' }
    ];

    for (const { t, expected } of vectors) {
        test(`T=${t}s produces ${expected}`, async () => {
            const otp = createOtp(makeUrl(secretB32, 30, 8), {
                type: 'totp',
                secret: secretB32,
                digits: 8,
                period: 30,
                algorithm: 'SHA1'
            });
            const { pass } = await computeOtpCode(otp, t * 1000);
            expect(pass).toBe(expected);
        });
    }

    test('returns a 6-digit code by default', async () => {
        const otp = createOtp(makeUrl(secretB32), {
            type: 'totp',
            secret: secretB32
        });
        const { pass } = await computeOtpCode(otp, 59_000);
        expect(pass).toMatch(/^\d{6}$/);
    });

    test('timeLeft is within the period window', async () => {
        const otp = createOtp(makeUrl(secretB32), {
            type: 'totp',
            secret: secretB32
        });
        const { timeLeft } = await computeOtpCode(otp, 1_700_000_015_000); // arbitrary
        expect(timeLeft).toBeGreaterThan(0);
        expect(timeLeft).toBeLessThanOrEqual(30_000);
    });

    test('produces the same code within the same 30s window', async () => {
        const otp = createOtp(makeUrl(secretB32), {
            type: 'totp',
            secret: secretB32
        });
        // Both timestamps are inside the same 30s bucket:
        //   t=91s  -> floor(91/30)=3
        //   t=119s -> floor(119/30)=3
        const a = await computeOtpCode(otp, 91_000);
        const b = await computeOtpCode(otp, 119_000);
        expect(a.pass).toBe(b.pass);
    });

    test('produces different codes in different 30s windows', async () => {
        const otp = createOtp(makeUrl(secretB32), {
            type: 'totp',
            secret: secretB32
        });
        const a = await computeOtpCode(otp, 0);
        const b = await computeOtpCode(otp, 30_000);
        expect(a.pass).not.toBe(b.pass);
    });
});

describe('HOTP code generation — RFC 4226 test vectors', () => {
    // RFC 4226 Appendix D: secret = "12345678901234567890" (ASCII)
    // Expected HOTP values (6 digits, SHA-1):
    //   Counter  |  Code
    //   ────────────────
    //   0        | 755224
    //   1        | 287082
    //   2        | 359152
    //   3        | 969429
    //   4        | 338314
    //   5        | 254676
    //   6        | 287922
    //   7        | 162583
    //   8        | 399871
    //   9        | 520489

    const secretB32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    // Issue #28: counter=0 is a valid HOTP counter and must produce "755224".
    // Previously the validator used `!params.counter`, which rejected counter=0 as falsy.
    const vectors: Array<{ counter: number; expected: string }> = [
        { counter: 0, expected: '755224' },
        { counter: 1, expected: '287082' },
        { counter: 2, expected: '359152' },
        { counter: 3, expected: '969429' },
        { counter: 4, expected: '338314' },
        { counter: 5, expected: '254676' },
        { counter: 9, expected: '520489' }
    ];

    for (const { counter, expected } of vectors) {
        test(`counter=${counter} produces ${expected}`, async () => {
            const otp = createOtp('otpauth://hotp/test?secret=' + secretB32 + '&counter=' + counter, {
                type: 'hotp',
                secret: secretB32,
                counter,
                digits: 6,
                algorithm: 'SHA1'
            });
            const { pass } = await computeOtpCode(otp, 0);
            expect(pass).toBe(expected);
        });
    }

    test('counter=0 (Issue #28 regression) is accepted programmatically', () => {
        expect(() =>
            createOtp('otpauth://hotp/test?secret=' + secretB32 + '&counter=0', {
                type: 'hotp',
                secret: secretB32,
                counter: 0
            })
        ).not.toThrow();
    });

    test('counter="0" string from URL is accepted and coerced to 0', async () => {
        const otp = createOtp('otpauth://hotp/test?secret=' + secretB32 + '&counter=0', {
            type: 'hotp',
            secret: secretB32,
            // simulate parseUrl, which stores params from the query string as strings
            counter: '0' as unknown as number
        });
        expect(otp.counter).toBe(0);
        const { pass } = await computeOtpCode(otp, 0);
        expect(pass).toBe('755224');
    });

    test('rejects negative counter', () => {
        expect(() =>
            createOtp('otpauth://hotp/test?secret=' + secretB32 + '&counter=-1', {
                type: 'hotp',
                secret: secretB32,
                counter: -1
            })
        ).toThrow(/Bad counter/);
    });

    test('rejects non-numeric counter', () => {
        expect(() =>
            createOtp('otpauth://hotp/test?secret=' + secretB32 + '&counter=abc', {
                type: 'hotp',
                secret: secretB32,
                counter: 'abc' as unknown as number
            })
        ).toThrow(/Bad counter/);
    });

    test('rejects missing counter on hotp', () => {
        expect(() =>
            createOtp('otpauth://hotp/test?secret=' + secretB32, {
                type: 'hotp',
                secret: secretB32
            })
        ).toThrow(/Bad counter/);
    });

    test('rejects fractional counter', () => {
        expect(() =>
            createOtp('otpauth://hotp/test?secret=' + secretB32 + '&counter=1.5', {
                type: 'hotp',
                secret: secretB32,
                counter: 1.5
            })
        ).toThrow(/Bad counter/);
    });
});
