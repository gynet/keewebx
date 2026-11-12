import { describe, test, expect } from 'bun:test';
import { ByteUtils, Consts, ProtectSaltGenerator } from '../../lib';

describe('ProtectSaltGenerator', () => {
    test('generates random sequences with ChaCha20', async () => {
        const gen = await ProtectSaltGenerator.create(
            new Uint8Array([1, 2, 3]),
            Consts.CrsAlgorithm.ChaCha20
        );
        let bytes = gen.getSalt(0);
        expect(bytes.byteLength).toBe(0);
        bytes = gen.getSalt(10);
        expect(ByteUtils.bytesToBase64(bytes)).toBe('iUIv7m2BJN2ubQ==');
        bytes = gen.getSalt(10);
        expect(ByteUtils.bytesToBase64(bytes)).toBe('BILRgZKxaxbRzg==');
        bytes = gen.getSalt(20);
        expect(ByteUtils.bytesToBase64(bytes)).toBe('KUeBUGjNBYhAoJstSqnMXQwuD6E=');
    });

    test('fails if the algorithm is not supported', async () => {
        try {
            await ProtectSaltGenerator.create(new Uint8Array(0), 0);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('Unsupported: crsAlgorithm');
        }
    });
});
