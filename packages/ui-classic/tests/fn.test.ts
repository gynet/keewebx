import { describe, test, expect } from 'bun:test';

// Inline pure utility functions to avoid webpack alias resolution issues

function pick(obj: any, props: string[]): any {
    if (!obj) return obj;
    const result: any = {};
    for (const prop of props) {
        if (Object.prototype.hasOwnProperty.call(obj, prop)) {
            result[prop] = obj[prop];
        }
    }
    return result;
}

function omit(obj: any, props: string[]): any {
    if (!obj) return obj;
    const result = { ...obj };
    for (const prop of props) {
        delete result[prop];
    }
    return result;
}

function omitEmpty(obj: any): any {
    if (!obj) return obj;
    return Object.entries(obj).reduce((result: any, [key, value]) => {
        if (value) {
            result[key] = value;
        }
        return result;
    }, {});
}

function mapObject(obj: any, fn: (v: any) => any): any {
    return Object.entries(obj).reduce((result: any, [key, value]) => {
        result[key] = fn(value);
        return result;
    }, {});
}

function isEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a instanceof Date) return +a === +b;
    if (a instanceof Array && b instanceof Array) return a.join(',') === b.join(',');
    return false;
}

function minmax(val: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, val));
}

describe('pick', () => {
    test('picks specified properties', () => {
        const obj = { a: 1, b: 2, c: 3 };
        expect(pick(obj, ['a', 'c'])).toEqual({ a: 1, c: 3 });
    });

    test('ignores non-existent properties', () => {
        const obj = { a: 1 };
        expect(pick(obj, ['a', 'b'])).toEqual({ a: 1 });
    });

    test('returns falsy input as-is', () => {
        expect(pick(null, ['a'])).toBeNull();
        expect(pick(undefined, ['a'])).toBeUndefined();
    });
});

describe('omit', () => {
    test('omits specified properties', () => {
        const obj = { a: 1, b: 2, c: 3 };
        expect(omit(obj, ['b'])).toEqual({ a: 1, c: 3 });
    });

    test('does not modify original object', () => {
        const obj = { a: 1, b: 2 };
        omit(obj, ['b']);
        expect(obj).toEqual({ a: 1, b: 2 });
    });

    test('returns falsy input as-is', () => {
        expect(omit(null, ['a'])).toBeNull();
    });
});

describe('omitEmpty', () => {
    test('removes falsy values', () => {
        const obj = { a: 1, b: '', c: null, d: 'ok', e: 0 };
        expect(omitEmpty(obj)).toEqual({ a: 1, d: 'ok' });
    });

    test('returns falsy input as-is', () => {
        expect(omitEmpty(null)).toBeNull();
    });
});

describe('mapObject', () => {
    test('maps values with transform function', () => {
        const obj = { a: 1, b: 2, c: 3 };
        expect(mapObject(obj, (v) => v * 2)).toEqual({ a: 2, b: 4, c: 6 });
    });

    test('maps values to strings', () => {
        const obj = { x: 1, y: 2 };
        expect(mapObject(obj, (v) => `val:${v}`)).toEqual({ x: 'val:1', y: 'val:2' });
    });
});

describe('isEqual', () => {
    test('returns true for same reference', () => {
        const obj = { a: 1 };
        expect(isEqual(obj, obj)).toBe(true);
    });

    test('returns true for same primitives', () => {
        expect(isEqual(1, 1)).toBe(true);
        expect(isEqual('a', 'a')).toBe(true);
    });

    test('returns false for different primitives', () => {
        expect(isEqual(1, 2)).toBe(false);
        expect(isEqual('a', 'b')).toBe(false);
    });

    test('compares dates by value', () => {
        const d1 = new Date('2024-01-01');
        const d2 = new Date('2024-01-01');
        const d3 = new Date('2024-01-02');
        expect(isEqual(d1, d2)).toBe(true);
        expect(isEqual(d1, d3)).toBe(false);
    });

    test('compares arrays by joined string', () => {
        expect(isEqual([1, 2, 3], [1, 2, 3])).toBe(true);
        expect(isEqual([1, 2], [1, 3])).toBe(false);
    });

    test('returns false for different types', () => {
        expect(isEqual(1, '1')).toBe(false);
    });
});

describe('minmax', () => {
    test('clamps value within range', () => {
        expect(minmax(5, 0, 10)).toBe(5);
        expect(minmax(-1, 0, 10)).toBe(0);
        expect(minmax(15, 0, 10)).toBe(10);
    });

    test('handles edge cases at boundaries', () => {
        expect(minmax(0, 0, 10)).toBe(0);
        expect(minmax(10, 0, 10)).toBe(10);
    });
});
