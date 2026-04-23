import { describe, test, expect } from 'bun:test';
import { ByteUtils, ProtectedValue } from '../../lib';

describe('ProtectedValue', () => {
    const valueBytes = ByteUtils.stringToBytes('strvalue'),
        encValueBytes = ByteUtils.stringToBytes('strvalue'),
        saltBytes = new Uint8Array(valueBytes.length);
    for (let i = 0; i < saltBytes.length; i++) {
        saltBytes[i] = i;
        encValueBytes[i] ^= i;
    }

    test('decrypts salted value in string', () => {
        const value = new ProtectedValue(encValueBytes, saltBytes);
        expect(value.getText()).toBe('strvalue');
    });

    test('returns string in binary', () => {
        const value = new ProtectedValue(encValueBytes, saltBytes);
        expect(value.getBinary()).toEqual(valueBytes);
    });

    test('checks substring', () => {
        const value = new ProtectedValue(encValueBytes, saltBytes);
        expect(value.includes('test')).toBe(false);
        expect(value.includes('str')).toBe(true);
        expect(value.includes('val')).toBe(true);
        expect(value.includes('value')).toBe(true);
        expect(value.includes('')).toBe(false);
    });

    test('calculates SHA512 hash', async () => {
        const value = new ProtectedValue(encValueBytes, saltBytes);
        const hash = await value.getHash();
        expect(ByteUtils.bytesToHex(hash)).toBe(
            '1f5c3ef76d43e72ee2c5216c36187c799b153cab3d0cb63a6f3ecccc2627f535'
        );
    });

    test('creates value from string', () => {
        const value = ProtectedValue.fromString('test');
        expect(value.getText()).toBe('test');
    });

    test('creates value from binary', () => {
        const value = ProtectedValue.fromBinary(ByteUtils.stringToBytes('test'));
        expect(value.getText()).toBe('test');
    });

    test('returns byte length', () => {
        const value = ProtectedValue.fromBinary(ByteUtils.stringToBytes('test'));
        expect(value.byteLength).toBe(4);
    });

    test('can change salt', () => {
        const value = ProtectedValue.fromString('test');
        expect(value.getText()).toBe('test');
        value.setSalt(new Uint8Array([1, 2, 3, 4]).buffer);
        expect(value.getText()).toBe('test');
    });

    test('returns protected value as base64 string', () => {
        const value = ProtectedValue.fromBinary(ByteUtils.stringToBytes('test'));
        value.setSalt(new Uint8Array([1, 2, 3, 4]).buffer);
        expect(value.toString()).toBe('dWdwcA==');
    });

    test('clones itself', () => {
        const value = ProtectedValue.fromString('test').clone();
        expect(value.getText()).toBe('test');
    });

    test('creates a value from base64', () => {
        const value = ProtectedValue.fromBase64('aGVsbG8=');
        expect(value.getText()).toBe('hello');
    });

    test('returns base64 of the value', () => {
        const value = ProtectedValue.fromString('hello');
        expect(value.toBase64()).toBe('aGVsbG8=');
    });
});
