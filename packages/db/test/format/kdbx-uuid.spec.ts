import { describe, test, expect } from 'bun:test';
import { KdbxUuid } from '../../lib';

describe('KdbxUuid', () => {
    test('creates uuid from 16 bytes ArrayBuffer', () => {
        const uuid = new KdbxUuid(
            new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5, 6]).buffer
        );
        expect(uuid.id).toBe('AQIDBAUGBwgJCgECAwQFBg==');
    });

    test('creates uuid from 16 bytes array', () => {
        const uuid = new KdbxUuid(
            new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5, 6])
        );
        expect(uuid.id).toBe('AQIDBAUGBwgJCgECAwQFBg==');
    });

    test('creates uuid base64 string', () => {
        const uuid = new KdbxUuid('AQIDBAUGBwgJCgECAwQFBg==');
        expect(uuid.id).toBe('AQIDBAUGBwgJCgECAwQFBg==');
    });

    test('throws an error for less than 16 bytes', () => {
        expect(() => {
            new KdbxUuid(new Uint16Array([123]).buffer);
        }).toThrow();
    });

    test('creates empty uuid from undefined', () => {
        const uuid = new KdbxUuid(undefined);
        expect(uuid.id).toBe('AAAAAAAAAAAAAAAAAAAAAA==');
        expect(uuid.empty).toBe(true);
    });

    test('returns uuid in toString method', () => {
        const uuid = new KdbxUuid(
            new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5, 6]).buffer
        );
        expect(uuid.toString()).toBe('AQIDBAUGBwgJCgECAwQFBg==');
    });

    test('returns uuid in valueOf method', () => {
        const uuid = new KdbxUuid(
            new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5, 6]).buffer
        );
        expect(uuid.valueOf()).toBe('AQIDBAUGBwgJCgECAwQFBg==');
    });

    test('creates empty uuid from no arg', () => {
        const uuid = new KdbxUuid();
        expect(uuid.toString()).toBe('AAAAAAAAAAAAAAAAAAAAAA==');
        expect(uuid.empty).toBe(true);
    });

    test('sets empty property for empty uuid', () => {
        const uuid = new KdbxUuid(new Uint8Array(16).buffer);
        expect(uuid.toString()).toBe('AAAAAAAAAAAAAAAAAAAAAA==');
        expect(uuid.empty).toBe(true);
    });

    test('returns bytes in toBytes method', () => {
        const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5, 6]);
        const uuid = new KdbxUuid(bytes.buffer);
        expect(uuid.toBytes()).toEqual(bytes);
    });

    test('returns bytes in bytes property', () => {
        const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5, 6]);
        const uuid = new KdbxUuid(bytes.buffer);
        expect(uuid.bytes).toEqual(bytes);
    });

    test('returns bytes in toBytes method for empty value', () => {
        const uuid = new KdbxUuid();
        expect(uuid.toBytes()).toEqual(new Uint8Array(16));
    });

    test('generates random uuid', () => {
        const uuid = KdbxUuid.random();
        expect(uuid).toBeInstanceOf(KdbxUuid);
        expect(uuid.toString()).not.toBe('AAAAAAAAAAAAAAAAAAAAAA==');
    });

    test('checks equality', () => {
        const uuid = new KdbxUuid(
            new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5, 6]).buffer
        );
        expect(uuid.equals('AQIDBAUGBwgJCgECAwQFBg==')).toBe(true);
        expect(uuid.equals(new KdbxUuid('AQIDBAUGBwgJCgECAwQFBg=='))).toBe(true);
        expect(uuid.equals(undefined)).toBe(false);
        expect(uuid.equals(null)).toBe(false);
        expect(uuid.equals('')).toBe(false);
        expect(uuid.equals('???')).toBe(false);
        expect(uuid.equals(new KdbxUuid())).toBe(false);
    });
});
