import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { ByteUtils, Consts, CryptoEngine, Int64, KeyEncryptorKdf, VarDictionary } from '../../lib';
import { ValueType } from '../../lib/utils/var-dictionary';

describe('KeyEncryptorKdf', () => {
    const data = ByteUtils.arrayToBuffer(
        ByteUtils.hexToBytes('5d18f8a5ae0e7ea86f0ad817f0c0d40656ef1da6367d8a88508b3c13cec0d7af')
    );
    const exp = '5d2a000401200200130000000000000000000000000000000000000000000000';

    beforeAll(() => {
        CryptoEngine.setArgon2Impl(
            (password, salt, memory, iterations, length, parallelism, type, version) => {
                const res = new ArrayBuffer(32);
                const view = new DataView(res);
                view.setUint8(0, new Uint8Array(password)[0]);
                view.setUint8(1, new Uint8Array(salt)[0]);
                view.setInt16(2, memory);
                view.setInt8(4, iterations);
                view.setInt8(5, length);
                view.setInt8(6, parallelism);
                view.setInt8(7, type);
                view.setInt8(8, version);
                return Promise.resolve(res);
            }
        );
    });

    afterAll(() => {
        CryptoEngine.setArgon2Impl(undefined as any);
    });

    test('calls argon2 function', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, ByteUtils.base64ToBytes(Consts.KdfId.Argon2));
        const saltArr = new Uint8Array(32);
        saltArr[0] = 42;
        const salt = ByteUtils.arrayToBuffer(saltArr);
        params.set('S', ValueType.Bytes, salt);
        params.set('P', ValueType.UInt32, 2);
        params.set('I', ValueType.UInt64, new Int64(1));
        params.set('M', ValueType.UInt64, new Int64(1024 * 4));
        params.set('V', ValueType.UInt32, 0x13);
        const res = await KeyEncryptorKdf.encrypt(data, params);
        expect(ByteUtils.bytesToHex(res)).toBe(exp);
    });

    test('throws error for no uuid', async () => {
        const params = new VarDictionary();
        try {
            await KeyEncryptorKdf.encrypt(data, params);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('FileCorrupt: no kdf uuid');
        }
    });

    test('throws error for invalid uuid', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, new ArrayBuffer(32));
        try {
            await KeyEncryptorKdf.encrypt(data, params);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('Unsupported: bad kdf');
        }
    });

    test('throws error for bad salt', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, ByteUtils.base64ToBytes(Consts.KdfId.Argon2));
        params.set('S', ValueType.Bytes, new ArrayBuffer(10));
        try {
            await KeyEncryptorKdf.encrypt(data, params);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('FileCorrupt: bad argon2 salt');
        }
    });

    test('throws error for bad parallelism', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, ByteUtils.base64ToBytes(Consts.KdfId.Argon2));
        params.set('S', ValueType.Bytes, new ArrayBuffer(32));
        params.set('P', ValueType.Int32, -1);
        try {
            await KeyEncryptorKdf.encrypt(data, params);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('FileCorrupt: bad argon2 parallelism');
        }
    });

    test('throws error for bad parallelism type', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, ByteUtils.base64ToBytes(Consts.KdfId.Argon2));
        params.set('S', ValueType.Bytes, new ArrayBuffer(32));
        params.set('P', ValueType.String, 'xxx');
        try {
            await KeyEncryptorKdf.encrypt(data, params);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('FileCorrupt: bad argon2 parallelism');
        }
    });

    test('throws error for bad iterations', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, ByteUtils.base64ToBytes(Consts.KdfId.Argon2));
        params.set('S', ValueType.Bytes, new ArrayBuffer(32));
        params.set('P', ValueType.Int32, 1);
        params.set('I', ValueType.Int32, -1);
        try {
            await KeyEncryptorKdf.encrypt(data, params);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('FileCorrupt: bad argon2 iterations');
        }
    });

    test('throws error for bad memory', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, ByteUtils.base64ToBytes(Consts.KdfId.Argon2));
        params.set('S', ValueType.Bytes, new ArrayBuffer(32));
        params.set('P', ValueType.Int32, 1);
        params.set('I', ValueType.Int32, 1);
        params.set('M', ValueType.Int32, 123);
        try {
            await KeyEncryptorKdf.encrypt(data, params);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('FileCorrupt: bad argon2 memory');
        }
    });

    test('throws error for bad version', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, ByteUtils.base64ToBytes(Consts.KdfId.Argon2));
        params.set('S', ValueType.Bytes, new ArrayBuffer(32));
        params.set('P', ValueType.Int32, 1);
        params.set('I', ValueType.Int32, 1);
        params.set('M', ValueType.Int32, 1024);
        params.set('V', ValueType.Int32, 5);
        try {
            await KeyEncryptorKdf.encrypt(data, params);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('FileCorrupt: bad argon2 version');
        }
    });

    test('throws error for secret key', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, ByteUtils.base64ToBytes(Consts.KdfId.Argon2));
        params.set('S', ValueType.Bytes, new ArrayBuffer(32));
        params.set('P', ValueType.Int32, 1);
        params.set('I', ValueType.Int32, 1);
        params.set('M', ValueType.Int32, 1024);
        params.set('V', ValueType.Int32, 0x10);
        params.set('K', ValueType.Bytes, new ArrayBuffer(32));
        try {
            await KeyEncryptorKdf.encrypt(data, params);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('Unsupported: argon2 secret key');
        }
    });

    test('throws error for assoc data', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, ByteUtils.base64ToBytes(Consts.KdfId.Argon2));
        params.set('S', ValueType.Bytes, new ArrayBuffer(32));
        params.set('P', ValueType.Int32, 1);
        params.set('I', ValueType.Int32, 1);
        params.set('M', ValueType.Int32, 1024);
        params.set('V', ValueType.Int32, 0x13);
        params.set('A', ValueType.Bytes, new ArrayBuffer(32));
        try {
            await KeyEncryptorKdf.encrypt(data, params);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('Unsupported: argon2 assoc data');
        }
    });

    test('calls aes function', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, ByteUtils.base64ToBytes(Consts.KdfId.Aes));
        const key = ByteUtils.hexToBytes(
            'ee66af917de0b0336e659fe6bd40a337d04e3c2b3635210fa16f28fb24d563ac'
        );
        const salt = ByteUtils.hexToBytes(
            '5d18f8a5ae0e7ea86f0ad817f0c0d40656ef1da6367d8a88508b3c13cec0d7af'
        );
        const result = 'af0be2c639224ad37bd2bc7967d6c3303a8a6d4b7813718918a66bde96dc3132';
        params.set('S', ValueType.Bytes, salt);
        params.set('R', ValueType.Int64, new Int64(2));
        const res = await KeyEncryptorKdf.encrypt(key, params);
        expect(ByteUtils.bytesToHex(res)).toBe(result);
    });

    test('throws error for bad aes salt', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, ByteUtils.base64ToBytes(Consts.KdfId.Aes));
        params.set('S', ValueType.Bytes, new ArrayBuffer(10));
        try {
            await KeyEncryptorKdf.encrypt(data, params);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('FileCorrupt: bad aes salt');
        }
    });

    test('throws error for bad aes rounds', async () => {
        const params = new VarDictionary();
        params.set('$UUID', ValueType.Bytes, ByteUtils.base64ToBytes(Consts.KdfId.Aes));
        params.set('S', ValueType.Bytes, new ArrayBuffer(32));
        params.set('R', ValueType.Int64, new Int64(-1));
        try {
            await KeyEncryptorKdf.encrypt(data, params);
            throw new Error('Not expected');
        } catch (e) {
            expect((e as Error).message).toContain('FileCorrupt: bad aes rounds');
        }
    });
});
