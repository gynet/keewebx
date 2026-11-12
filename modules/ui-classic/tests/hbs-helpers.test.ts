import { describe, test, expect } from 'bun:test';

/**
 * Tests for hbs-helpers logic.
 * We inline the pure logic from each helper to test it without
 * requiring the Handlebars runtime (which is a webpack alias).
 */

// add helper logic
function add(lvalue: string, rvalue: string): number {
    return parseInt(lvalue) + parseInt(rvalue);
}

// cmp helper logic
function cmp(lvalue: unknown, rvalue: unknown, op: string): boolean | undefined {
    switch (op) {
        case '<':
            return (lvalue as number) < (rvalue as number);
        case '>':
            return (lvalue as number) > (rvalue as number);
        case '>=':
            return (lvalue as number) >= (rvalue as number);
        case '<=':
            return (lvalue as number) <= (rvalue as number);
        case '===':
        case '==':
            return lvalue === rvalue;
        case '!==':
        case '!=':
            return lvalue !== rvalue;
    }
    return undefined;
}

// ifeq helper logic
function ifeq(lvalue: unknown, rvalue: unknown): boolean {
    return lvalue === rvalue;
}

// ifneq helper logic
function ifneq(lvalue: unknown, rvalue: unknown): boolean {
    return lvalue !== rvalue;
}

// ifemptyoreq helper logic
function ifemptyoreq(lvalue: unknown, rvalue: unknown): boolean {
    return !lvalue || lvalue === rvalue;
}

describe('add helper', () => {
    test('adds two positive integers', () => {
        expect(add('3', '5')).toBe(8);
    });

    test('adds negative numbers', () => {
        expect(add('-1', '3')).toBe(2);
    });

    test('adds zero', () => {
        expect(add('0', '7')).toBe(7);
    });

    test('handles string representations', () => {
        expect(add('10', '20')).toBe(30);
    });
});

describe('cmp helper', () => {
    test('less than', () => {
        expect(cmp(1, 2, '<')).toBe(true);
        expect(cmp(2, 1, '<')).toBe(false);
        expect(cmp(1, 1, '<')).toBe(false);
    });

    test('greater than', () => {
        expect(cmp(2, 1, '>')).toBe(true);
        expect(cmp(1, 2, '>')).toBe(false);
    });

    test('greater than or equal', () => {
        expect(cmp(2, 1, '>=')).toBe(true);
        expect(cmp(1, 1, '>=')).toBe(true);
        expect(cmp(0, 1, '>=')).toBe(false);
    });

    test('less than or equal', () => {
        expect(cmp(1, 2, '<=')).toBe(true);
        expect(cmp(1, 1, '<=')).toBe(true);
        expect(cmp(2, 1, '<=')).toBe(false);
    });

    test('strict equality with ===', () => {
        expect(cmp('a', 'a', '===')).toBe(true);
        expect(cmp('a', 'b', '===')).toBe(false);
        expect(cmp(1, 1, '==')).toBe(true);
    });

    test('strict inequality with !==', () => {
        expect(cmp('a', 'b', '!==')).toBe(true);
        expect(cmp('a', 'a', '!==')).toBe(false);
        expect(cmp(1, 2, '!=')).toBe(true);
    });

    test('returns undefined for unknown operator', () => {
        expect(cmp(1, 2, '~')).toBeUndefined();
    });
});

describe('ifeq helper', () => {
    test('returns true for equal values', () => {
        expect(ifeq('hello', 'hello')).toBe(true);
        expect(ifeq(42, 42)).toBe(true);
    });

    test('returns false for different values', () => {
        expect(ifeq('hello', 'world')).toBe(false);
        expect(ifeq(1, 2)).toBe(false);
    });

    test('uses strict equality', () => {
        expect(ifeq(1, '1')).toBe(false);
        expect(ifeq(0, false)).toBe(false);
        expect(ifeq(null, undefined)).toBe(false);
    });
});

describe('ifneq helper', () => {
    test('returns true for different values', () => {
        expect(ifneq('a', 'b')).toBe(true);
    });

    test('returns false for equal values', () => {
        expect(ifneq('a', 'a')).toBe(false);
    });

    test('uses strict inequality', () => {
        expect(ifneq(1, '1')).toBe(true);
    });
});

describe('ifemptyoreq helper', () => {
    test('returns true when lvalue is empty string', () => {
        expect(ifemptyoreq('', 'anything')).toBe(true);
    });

    test('returns true when lvalue is null', () => {
        expect(ifemptyoreq(null, 'anything')).toBe(true);
    });

    test('returns true when lvalue is undefined', () => {
        expect(ifemptyoreq(undefined, 'anything')).toBe(true);
    });

    test('returns true when lvalue equals rvalue', () => {
        expect(ifemptyoreq('test', 'test')).toBe(true);
    });

    test('returns false when lvalue is non-empty and different from rvalue', () => {
        expect(ifemptyoreq('hello', 'world')).toBe(false);
    });

    test('returns true when lvalue is 0 (falsy)', () => {
        expect(ifemptyoreq(0, 'anything')).toBe(true);
    });
});
