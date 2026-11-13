import { describe, test, expect } from 'bun:test';

import { CsvParser } from '../../vault/src/util/data/csv-parser';

describe('CsvParser', () => {
    const parser = new CsvParser();

    test('parses simple CSV with headers and rows', () => {
        const result = parser.parse('name,email\nAlice,alice@example.com\nBob,bob@example.com');
        expect(result.headers).toEqual(['name', 'email']);
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]).toEqual(['Alice', 'alice@example.com']);
        expect(result.rows[1]).toEqual(['Bob', 'bob@example.com']);
    });

    test('handles quoted values with commas', () => {
        const result = parser.parse('name,address\nAlice,"123 Main St, Apt 4"');
        expect(result.rows[0][1]).toBe('123 Main St, Apt 4');
    });

    test('handles escaped quotes inside quoted values (doubled quotes)', () => {
        const result = parser.parse('name,quote\nAlice,"She said ""hello"""');
        expect(result.rows[0][1]).toBe('She said "hello"');
    });

    test('handles escaped quotes with backslash', () => {
        const result = parser.parse('name,quote\nAlice,"She said \\"hello\\""');
        expect(result.rows[0][1]).toBe('She said "hello"');
    });

    test('handles CRLF line endings', () => {
        const result = parser.parse('name,email\r\nAlice,alice@test.com\r\nBob,bob@test.com');
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]).toEqual(['Alice', 'alice@test.com']);
    });

    test('throws on empty CSV', () => {
        expect(() => parser.parse('header1,header2')).toThrow('Empty CSV');
    });

    test('throws on unclosed quoted value', () => {
        expect(() => parser.parse('name,value\nAlice,"unclosed')).toThrow(
            'Quoted value not closed'
        );
    });

    test('handles three columns', () => {
        const result = parser.parse('a,b,c\n1,2,3\n4,5,6');
        expect(result.headers).toEqual(['a', 'b', 'c']);
        expect(result.rows[0]).toEqual(['1', '2', '3']);
        expect(result.rows[1]).toEqual(['4', '5', '6']);
    });

    test('handles empty field values', () => {
        const result = parser.parse('a,b,c\n1,,3');
        expect(result.rows[0]).toEqual(['1', '', '3']);
    });
});
