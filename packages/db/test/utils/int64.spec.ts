import { describe, test, expect } from 'bun:test';
import { Int64 } from '../../lib';

describe('Int64', () => {
    test('creates empty int64', () => {
        const i = new Int64();
        expect(i.hi).toBe(0);
        expect(i.lo).toBe(0);
        expect(i.value).toBe(0);
        expect(i.valueOf()).toBe(0);
    });

    test('creates int64 with low part', () => {
        const i = new Int64(0x123);
        expect(i.hi).toBe(0);
        expect(i.lo).toBe(0x123);
        expect(i.value).toBe(0x123);
        expect(i.valueOf()).toBe(0x123);
    });

    test('creates int64 with low and high parts', () => {
        const i = new Int64(0x123, 0x456);
        expect(i.hi).toBe(0x456);
        expect(i.lo).toBe(0x123);
        expect(i.value).toBe(0x45600000123);
        expect(i.valueOf()).toBe(0x45600000123);
    });

    test('creates int64 with large value', () => {
        const i = Int64.from(0x45600000123);
        expect(i.hi).toBe(0x456);
        expect(i.lo).toBe(0x123);
        expect(i.value).toBe(0x45600000123);
        expect(i.valueOf()).toBe(0x45600000123);
    });

    test('throws error for too high number conversion', () => {
        const i = new Int64(0xffffffff, 0xffffffff);
        expect(() => i.value).toThrow('too large number');
    });

    test('throws error for too high number creation', () => {
        expect(() => {
            // eslint-disable-next-line no-loss-of-precision
            Int64.from(0xffffffffffffff);
        }).toThrow('too large number');
    });
});
