import { describe, test, expect } from 'bun:test';

// Inline the pure utility functions from src/background/utils.ts
function toBase64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

function fromBase64(str: string): Uint8Array {
    return Uint8Array.from(atob(str), (ch) => ch.charCodeAt(0));
}

function randomBytes(byteLength: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(byteLength));
}

function randomBase64(byteLength: number): string {
    return toBase64(randomBytes(byteLength));
}

describe('toBase64', () => {
    test('encodes empty array', () => {
        expect(toBase64(new Uint8Array(0))).toBe('');
    });

    test('encodes known bytes to expected base64', () => {
        // "Hello" = [72, 101, 108, 108, 111]
        const bytes = new Uint8Array([72, 101, 108, 108, 111]);
        expect(toBase64(bytes)).toBe('SGVsbG8=');
    });

    test('encodes single byte', () => {
        const bytes = new Uint8Array([0]);
        expect(toBase64(bytes)).toBe('AA==');
    });

    test('encodes all zero bytes', () => {
        const bytes = new Uint8Array(3);
        expect(toBase64(bytes)).toBe('AAAA');
    });

    test('encodes max byte values', () => {
        const bytes = new Uint8Array([255, 255, 255]);
        expect(toBase64(bytes)).toBe('////');
    });
});

describe('fromBase64', () => {
    test('decodes empty string', () => {
        expect(fromBase64('')).toEqual(new Uint8Array(0));
    });

    test('decodes known base64 to expected bytes', () => {
        const decoded = fromBase64('SGVsbG8=');
        expect(decoded).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
    });

    test('round-trips with toBase64', () => {
        const original = new Uint8Array([1, 2, 3, 127, 128, 255]);
        const encoded = toBase64(original);
        const decoded = fromBase64(encoded);
        expect(decoded).toEqual(original);
    });
});

describe('randomBytes', () => {
    test('returns correct length', () => {
        expect(randomBytes(16).length).toBe(16);
        expect(randomBytes(32).length).toBe(32);
        expect(randomBytes(0).length).toBe(0);
    });

    test('returns Uint8Array', () => {
        const result = randomBytes(8);
        expect(result).toBeInstanceOf(Uint8Array);
    });

    test('produces different values on successive calls', () => {
        const a = randomBytes(32);
        const b = randomBytes(32);
        // Extremely unlikely to be equal for 32 random bytes
        expect(toBase64(a)).not.toBe(toBase64(b));
    });
});

describe('randomBase64', () => {
    test('returns a non-empty base64 string', () => {
        const result = randomBase64(16);
        expect(result.length).toBeGreaterThan(0);
    });

    test('round-trips to correct byte length', () => {
        const result = randomBase64(24);
        const decoded = fromBase64(result);
        expect(decoded.length).toBe(24);
    });

    test('produces different values on successive calls', () => {
        const a = randomBase64(16);
        const b = randomBase64(16);
        expect(a).not.toBe(b);
    });
});
