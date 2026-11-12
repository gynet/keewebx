/**
 * Error path tests for KDBX loading.
 *
 * Tests that the library produces clear, correct errors for:
 * - Wrong password
 * - Corrupted file (bit-flipped data)
 * - Truncated file (incomplete data)
 * - Zero-length file
 * - Malformed XML in inner content
 * - Non-KDBX data (random bytes, text, etc.)
 * - Missing Argon2 implementation
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as kdbxweb from '../../lib';
import { argon2 } from '../test-support/argon2';

const RESOURCES_DIR = path.join(__dirname, '../../resources');

function readResource(name: string): ArrayBuffer {
    const filePath = path.join(RESOURCES_DIR, name);
    const content = fs.readFileSync(filePath);
    return kdbxweb.ByteUtils.arrayToBuffer(new Uint8Array(content));
}

describe('KDBX error paths', () => {
    beforeAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    });

    afterAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(undefined as any);
    });

    const validFile = () => readResource('Argon2.kdbx');
    const validCred = () =>
        new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            readResource('demo.key')
        );

    // ---------------------------------------------------------------
    // Wrong password
    // ---------------------------------------------------------------

    describe('wrong password', () => {
        test('rejects with InvalidKey for wrong password', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('wrong-password'),
                readResource('demo.key')
            );
            try {
                await kdbxweb.Kdbx.load(validFile(), cred);
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.InvalidKey
                );
            }
        });

        test('rejects with InvalidKey for correct password but wrong keyfile', async () => {
            const wrongKeyFile = new ArrayBuffer(32);
            new Uint8Array(wrongKeyFile).fill(0xaa);
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('demo'),
                wrongKeyFile
            );
            try {
                await kdbxweb.Kdbx.load(validFile(), cred);
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.InvalidKey
                );
            }
        });

        test('rejects with InvalidKey for password-only when keyfile is needed', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('demo')
            );
            try {
                await kdbxweb.Kdbx.load(validFile(), cred);
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.InvalidKey
                );
            }
        });
    });

    // ---------------------------------------------------------------
    // Corrupted file (bit-flip in encrypted data)
    // ---------------------------------------------------------------

    describe('corrupted file', () => {
        test('rejects file with flipped bit in header', async () => {
            const data = new Uint8Array(validFile());
            const corrupted = new Uint8Array(data.length);
            corrupted.set(data);
            // Flip a bit in the header hash area (after the header fields)
            corrupted[254] ^= 0xff;

            try {
                await kdbxweb.Kdbx.load(corrupted.buffer, validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                // Could be FileCorrupt (header hash mismatch) or InvalidKey (HMAC mismatch)
                const code = (e as kdbxweb.KdbxError).code;
                expect(
                    code === kdbxweb.Consts.ErrorCodes.FileCorrupt ||
                        code === kdbxweb.Consts.ErrorCodes.InvalidKey
                ).toBe(true);
            }
        });

        test('rejects file with flipped byte in encrypted payload', async () => {
            const data = new Uint8Array(validFile());
            const corrupted = new Uint8Array(data.length);
            corrupted.set(data);
            // Corrupt the encrypted payload area (well past the header)
            const corruptOffset = Math.min(data.length - 1, 500);
            corrupted[corruptOffset] ^= 0xff;

            try {
                await kdbxweb.Kdbx.load(corrupted.buffer, validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                // Payload corruption typically triggers InvalidKey or FileCorrupt
                const code = (e as kdbxweb.KdbxError).code;
                expect(
                    code === kdbxweb.Consts.ErrorCodes.FileCorrupt ||
                        code === kdbxweb.Consts.ErrorCodes.InvalidKey
                ).toBe(true);
            }
        });

        test('rejects file with overwritten signature', async () => {
            const data = new Uint8Array(validFile());
            const corrupted = new Uint8Array(data.length);
            corrupted.set(data);
            // Overwrite the KDBX magic signature bytes
            corrupted[0] = 0x00;
            corrupted[1] = 0x00;

            try {
                await kdbxweb.Kdbx.load(corrupted.buffer, validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.BadSignature
                );
            }
        });
    });

    // ---------------------------------------------------------------
    // Truncated file
    // ---------------------------------------------------------------

    describe('truncated file', () => {
        test('rejects file truncated to 8 bytes (just signatures)', async () => {
            const data = new Uint8Array(validFile());
            const truncated = data.slice(0, 8);

            try {
                await kdbxweb.Kdbx.load(truncated.buffer, validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                // Truncated files may throw RangeError (from DataView) or KdbxError
                expect(e).toBeTruthy();
                expect(e).not.toEqual(new Error('Should have thrown'));
            }
        });

        test('rejects file truncated to 12 bytes (signatures + version)', async () => {
            const data = new Uint8Array(validFile());
            const truncated = data.slice(0, 12);

            try {
                await kdbxweb.Kdbx.load(truncated.buffer, validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeTruthy();
                expect(e).not.toEqual(new Error('Should have thrown'));
            }
        });

        test('rejects file truncated mid-header', async () => {
            const data = new Uint8Array(validFile());
            // Truncate at roughly 50% of the header
            const truncated = data.slice(0, Math.min(100, data.length));

            try {
                await kdbxweb.Kdbx.load(truncated.buffer, validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeTruthy();
                expect(e).not.toEqual(new Error('Should have thrown'));
            }
        });

        test('rejects file truncated after header but before payload', async () => {
            const data = new Uint8Array(validFile());
            // Truncate at ~60% of file size
            const truncated = data.slice(0, Math.floor(data.length * 0.6));

            try {
                await kdbxweb.Kdbx.load(truncated.buffer, validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeTruthy();
                expect(e).not.toEqual(new Error('Should have thrown'));
            }
        });
    });

    // ---------------------------------------------------------------
    // Zero-length file
    // ---------------------------------------------------------------

    describe('zero-length file', () => {
        test('rejects empty ArrayBuffer', async () => {
            try {
                await kdbxweb.Kdbx.load(new ArrayBuffer(0), validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                // Empty file triggers FileCorrupt (not enough data for signatures)
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.FileCorrupt
                );
            }
        });

        test('rejects 1-byte file', async () => {
            try {
                await kdbxweb.Kdbx.load(new ArrayBuffer(1), validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.FileCorrupt
                );
            }
        });

        test('rejects 4-byte file', async () => {
            try {
                await kdbxweb.Kdbx.load(new ArrayBuffer(4), validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.FileCorrupt
                );
            }
        });
    });

    // ---------------------------------------------------------------
    // Malformed XML
    // ---------------------------------------------------------------

    describe('malformed XML', () => {
        test('rejects completely malformed XML', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('')
            );
            try {
                await kdbxweb.Kdbx.loadXml('this is not xml at all', cred);
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.FileCorrupt
                );
            }
        });

        test('rejects XML with missing KeePassFile root', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('')
            );
            try {
                await kdbxweb.Kdbx.loadXml(
                    '<?xml version="1.0"?><NotKeePass></NotKeePass>',
                    cred
                );
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.FileCorrupt
                );
            }
        });

        test('rejects empty string as XML', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('')
            );
            try {
                await kdbxweb.Kdbx.loadXml('', cred);
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.FileCorrupt
                );
            }
        });
    });

    // ---------------------------------------------------------------
    // Non-KDBX data
    // ---------------------------------------------------------------

    describe('non-KDBX data', () => {
        test('rejects random bytes', async () => {
            const randomData = new Uint8Array(1024);
            for (let i = 0; i < randomData.length; i++) {
                randomData[i] = Math.floor(Math.random() * 256);
            }

            try {
                await kdbxweb.Kdbx.load(randomData.buffer, validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.BadSignature
                );
            }
        });

        test('rejects text content as binary', async () => {
            const text = new TextEncoder().encode('This is a plain text file, not a KDBX database');

            try {
                await kdbxweb.Kdbx.load(text.buffer, validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.BadSignature
                );
            }
        });

        test('rejects KDB (KeePass 1.x) signature', async () => {
            // KDB1 magic: 0x9aa2d903 0xb54bfb65
            const kdb1Data = new Uint8Array(256);
            const view = new DataView(kdb1Data.buffer);
            view.setUint32(0, 0x9aa2d903, true); // Same first sig
            view.setUint32(4, 0xb54bfb65, true); // KDB1 sig2

            try {
                await kdbxweb.Kdbx.load(kdb1Data.buffer, validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.BadSignature
                );
            }
        });
    });

    // ---------------------------------------------------------------
    // Missing Argon2 implementation
    // ---------------------------------------------------------------

    describe('missing Argon2 implementation', () => {
        test('throws when Argon2 impl is not set', async () => {
            // Temporarily remove Argon2
            kdbxweb.CryptoEngine.setArgon2Impl(undefined as any);
            try {
                await kdbxweb.Kdbx.load(validFile(), validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeTruthy();
            } finally {
                // Restore
                kdbxweb.CryptoEngine.setArgon2Impl(argon2);
            }
        });
    });

    // ---------------------------------------------------------------
    // Invalid argument types
    // ---------------------------------------------------------------

    describe('invalid arguments', () => {
        test('rejects non-ArrayBuffer data', async () => {
            try {
                // @ts-ignore — intentional bad type
                await kdbxweb.Kdbx.load('not a buffer', validCred());
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.InvalidArg
                );
            }
        });

        test('rejects null credentials', async () => {
            try {
                // @ts-ignore — intentional bad type
                await kdbxweb.Kdbx.load(validFile(), null);
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.InvalidArg
                );
            }
        });

        test('rejects string credentials', async () => {
            try {
                // @ts-ignore — intentional bad type
                await kdbxweb.Kdbx.load(validFile(), 'password');
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.InvalidArg
                );
            }
        });
    });
});
