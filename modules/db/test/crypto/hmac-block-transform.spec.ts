import { describe, test, expect } from 'bun:test';
import { ByteUtils, Consts, HmacBlockTransform, KdbxError } from '../../lib';

describe('HmacBlockTransform', () => {
    const key = ByteUtils.arrayToBuffer(
        ByteUtils.hexToBytes('1f5c3ef76d43e72ee2c5216c36187c799b153cab3d0cb63a6f3ecccc2627f535')
    );

    test('decrypts and encrypts data', async () => {
        const src = new Uint8Array([1, 2, 3, 4, 5]);
        const enc = await HmacBlockTransform.encrypt(src.buffer, key);
        const dec = new Uint8Array(await HmacBlockTransform.decrypt(enc, key));
        expect(dec).toEqual(src);
    });

    test('decrypts several blocks', async () => {
        const src = new Uint8Array(1024 * 1024 * 2 + 2);
        for (let i = 0; i < src.length; i++) {
            src[i] = i % 256;
        }
        const enc = await HmacBlockTransform.encrypt(src.buffer, key);
        const dec = await HmacBlockTransform.decrypt(enc, key);
        expect(ByteUtils.bytesToBase64(dec)).toBe(ByteUtils.bytesToBase64(src));
    });

    test('throws error for invalid hash block', async () => {
        const src = new Uint8Array([1, 2, 3, 4, 5]);
        const enc = await HmacBlockTransform.encrypt(src.buffer, key);
        new Uint8Array(enc)[4] = 0;
        try {
            await HmacBlockTransform.decrypt(enc, key);
            throw new Error('We should not get here');
        } catch (e) {
            expect(e).toBeInstanceOf(KdbxError);
            expect((e as KdbxError).code).toBe(Consts.ErrorCodes.FileCorrupt);
        }
    });
});
