import { describe, test, expect, afterEach } from 'bun:test';
import { ByteUtils, CryptoEngine } from '../../lib';

const isNode = !!global.process?.versions?.node;

function fromHex(str: string) {
    return ByteUtils.arrayToBuffer(ByteUtils.hexToBytes(str));
}

function toHex(bytes: ArrayBuffer) {
    if (!(bytes instanceof ArrayBuffer)) {
        throw 'Not ArrayBuffer';
    }
    return ByteUtils.bytesToHex(bytes);
}

function useDefaultImpl() {
    if (isNode) {
        // @ts-ignore
        global.crypto = undefined;
    }
}

function useSubtleMock() {
    if (isNode) {
        // @ts-ignore
        global.crypto = require('../test-support/subtle-mock-node').SubtleMockNode;
    }
}

describe('CryptoEngine', () => {
    afterEach(useDefaultImpl);

    describe('sha256', () => {
        const src = 'f03f102fa66d1847535a85ffc09c3911d1d56887c451832448df3cbac293be4b';
        const exp = 'affa378dae878f64d10f302df67c614ebb901601dd53a51713ffe664850c833b';
        const expEmpty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

        test('calculates sha256', async () => {
            useDefaultImpl();
            const hash = await CryptoEngine.sha256(fromHex(src));
            expect(toHex(hash)).toBe(exp);
        });

        test('calculates sha256 of empty data', async () => {
            useDefaultImpl();
            const hash = await CryptoEngine.sha256(new ArrayBuffer(0));
            expect(toHex(hash)).toBe(expEmpty);
        });

        if (isNode) {
            test('calculates sha256 with subtle', async () => {
                useSubtleMock();
                const hash = await CryptoEngine.sha256(fromHex(src));
                expect(toHex(hash)).toBe(exp);
            });
        }
    });

    describe('sha512', () => {
        const src = 'f03f102fa66d1847535a85ffc09c3911d1d56887c451832448df3cbac293be4b';
        const exp =
            '8425338d314de7b33d2be207494bd10335c543b9e354ed9316400bf86ecca4b8' +
            '707b22e3a7f3f32b1b0e83793137f5cdbff4c5cfd331ca66dc4887a10594257f';
        const expEmpty =
            'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce' +
            '47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';

        test('calculates sha512', async () => {
            useDefaultImpl();
            const hash = await CryptoEngine.sha512(fromHex(src));
            expect(toHex(hash)).toBe(exp);
        });

        test('calculates sha512 of empty data', async () => {
            useDefaultImpl();
            const hash = await CryptoEngine.sha512(new ArrayBuffer(0));
            expect(toHex(hash)).toBe(expEmpty);
        });

        if (isNode) {
            test('calculates sha512 with subtle', async () => {
                useSubtleMock();
                const hash = await CryptoEngine.sha512(fromHex(src));
                expect(toHex(hash)).toBe(exp);
            });
        }
    });

    describe('hmacSha256', () => {
        const data = '14af83cb4ecb6e1773a0ff0fa607e2e96a43dbeeade61291c52ab3853b1dda9d';
        const key = 'c50d2f8d0d51ba443ec46f7f843bf17491b8c0a09b58437acd589b14b73aa35c';
        const exp = 'f25a33a0424440b91d98cb4d9c0e897ff0a1f48c78820e6374257cf7fa774fb2';

        test('calculates hmac-sha256', async () => {
            useDefaultImpl();
            const hash = await CryptoEngine.hmacSha256(fromHex(key), fromHex(data));
            expect(toHex(hash)).toBe(exp);
        });

        if (isNode) {
            test('calculates hmac-sha256 with subtle', async () => {
                useSubtleMock();
                const hash = await CryptoEngine.hmacSha256(fromHex(key), fromHex(data));
                expect(toHex(hash)).toBe(exp);
            });
        }
    });

    describe('random', () => {
        test('fills random bytes', () => {
            useDefaultImpl();
            const rand1 = CryptoEngine.random(20);
            expect(rand1.length).toBe(20);
            const rand2 = CryptoEngine.random(20);
            expect(rand2.length).toBe(20);
            expect(ByteUtils.arrayBufferEquals(rand1, rand2)).toBe(false);
            const rand3 = CryptoEngine.random(10);
            expect(rand3.length).toBe(10);
        });

        test('can fill more than 65536 bytes', () => {
            useDefaultImpl();
            const rand1 = CryptoEngine.random(77111);
            expect(rand1.length).toBe(77111);
        });

        if (isNode) {
            test('generates random bytes with subtle', () => {
                useSubtleMock();
                const rand1 = CryptoEngine.random(20);
                expect(rand1.length).toBe(20);
            });

            test('can fill more than 65536 bytes with subtle', () => {
                useSubtleMock();
                const rand1 = CryptoEngine.random(77111);
                expect(rand1.length).toBe(77111);
            });
        }
    });

    describe('AesCbc', () => {
        const key = '6b2796fa863a6552986c428528d053b76de7ba8e12f8c0e74edb5ed44da3f601';
        const data = 'e567554429098a38d5f819115edffd39';
        const iv = '4db46dff4add42cb813b98de98e627c4';
        const exp = '46ab4c37d9ec594e5742971f76f7c1620bc29f2e0736b27832d6bcc5c1c39dc1';

        test('encrypts-decrypts with aes-cbc', async () => {
            useDefaultImpl();
            const aes = CryptoEngine.createAesCbc();
            await aes.importKey(fromHex(key));
            const result = await aes.encrypt(fromHex(data), fromHex(iv));
            expect(toHex(result)).toBe(exp);
            const decrypted = await aes.decrypt(result, fromHex(iv));
            expect(toHex(decrypted)).toBe(data);
        });

        test('throws error or generates wrong data for bad key', async () => {
            useDefaultImpl();
            const aes = CryptoEngine.createAesCbc();
            await aes.importKey(fromHex(key));
            try {
                const result = await aes.decrypt(fromHex(data), fromHex(iv));
                expect(toHex(result)).not.toBe(data);
            } catch (e) {
                expect((e as Error).message).toContain('Error InvalidKey: ');
            }
        });

        test('throws if key is not set', async () => {
            useDefaultImpl();
            const aes = CryptoEngine.createAesCbc();
            try {
                await aes.encrypt(new ArrayBuffer(0), new ArrayBuffer(0));
                throw new Error('Should have thrown');
            } catch (e) {
                expect((e as Error).message).toContain('no key');
            }
        });

        if (isNode) {
            test('encrypts-decrypts with aes-cbc with subtle', async () => {
                useSubtleMock();
                const aes = CryptoEngine.createAesCbc();
                await aes.importKey(fromHex(key));
                const result = await aes.encrypt(fromHex(data), fromHex(iv));
                expect(toHex(result)).toBe(exp);
                const decrypted = await aes.decrypt(result, fromHex(iv));
                expect(toHex(decrypted)).toBe(data);
            });

            test('throws error for bad key with subtle', async () => {
                useSubtleMock();
                const aes = CryptoEngine.createAesCbc();
                await aes.importKey(fromHex(key));
                try {
                    const result = await aes.decrypt(fromHex(data), fromHex(iv));
                    expect(toHex(result)).toBe(data);
                    throw new Error('Not expected');
                } catch (e) {
                    expect((e as Error).message).toContain('Error InvalidKey: ');
                }
            });

            test('throws if key is not set with subtle', async () => {
                useSubtleMock();
                const aes = CryptoEngine.createAesCbc();
                try {
                    await aes.encrypt(new ArrayBuffer(0), new ArrayBuffer(0));
                    throw new Error('Should have thrown');
                } catch (e) {
                    expect((e as Error).message).toContain('no key');
                }
            });
        }
    });

    describe('chacha20', () => {
        const key = '6b2796fa863a6552986c428528d053b76de7ba8e12f8c0e74edb5ed44da3f601';
        const data = 'e567554429098a38d5f819115edffd39';
        const iv12 = '4db46dff4add42cb813b98de';
        const exp12 = 'd0b413d0e71dd55db9ce29ed092724d1';
        const iv8 = '4db46dff4add42cb';
        const exp8 = 'ebaee4b6790192fd6e60f6294ea12c98';

        test('encrypts with chacha20', async () => {
            useDefaultImpl();
            const result = await CryptoEngine.chacha20(
                ByteUtils.hexToBytes(data),
                ByteUtils.hexToBytes(key),
                ByteUtils.hexToBytes(iv12)
            );
            expect(toHex(result)).toBe(exp12);
        });

        test('encrypts with short iv', async () => {
            useDefaultImpl();
            const result = await CryptoEngine.chacha20(
                ByteUtils.hexToBytes(data),
                ByteUtils.hexToBytes(key),
                ByteUtils.hexToBytes(iv8)
            );
            expect(toHex(result)).toBe(exp8);
        });
    });

    describe('argon2', () => {
        test('throws error if argon2 is not implemented', async () => {
            useDefaultImpl();
            CryptoEngine.setArgon2Impl(undefined as any);
            try {
                await CryptoEngine.argon2(
                    new ArrayBuffer(0),
                    new ArrayBuffer(0),
                    0,
                    0,
                    0,
                    0,
                    CryptoEngine.Argon2TypeArgon2d,
                    0x10
                );
                throw new Error('No error generated');
            } catch (e) {
                expect((e as Error).message).toBe('Error NotImplemented: argon2 not implemented');
            }
        });
    });
});
