/**
 * Cross-implementation compatibility tests using test databases from pykeepass.
 * Source: https://github.com/libkeepass/pykeepass (GPLv3 license)
 *
 * These tests verify that our KDBX4 implementation can read databases created
 * by pykeepass, a popular Python KeePass library.
 *
 * Credential mapping (from pykeepass tests/tests.py):
 *   test4.kdbx             — password "password" + test4.key
 *   test4_aes.kdbx         — password "password" + test4.key
 *   test4_aeskdf.kdbx      — password "password" + test4.key
 *   test4_chacha20.kdbx    — password "password" + test4.key
 *   test4_hex.kdbx         — password "password" + test4_hex.key
 *   test4_aes_uncompressed — password "password", no keyfile
 *   test4_chacha20_uncompressed — password "password", no keyfile
 *   test4_argon2id.kdbx    — password "password", no keyfile
 *   test4_blankpass.kdbx   — password "" + test4.key
 *   test4_keyx.kdbx        — password "password" + test4_keyx.keyx
 *   test4_transformed.kdbx — uses pre-computed transformed key (skipped)
 *   test4_twofish*.kdbx    — Twofish cipher, not supported
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as kdbxweb from '../../lib';
import { argon2 } from '../test-support/argon2';

const PYKEEPASS_DIR = path.join(__dirname, '../../resources/external/pykeepass');

function readFile(name: string): ArrayBuffer {
    const filePath = path.join(PYKEEPASS_DIR, name);
    const content = fs.readFileSync(filePath);
    return kdbxweb.ByteUtils.arrayToBuffer(new Uint8Array(content));
}

/** Credentials with password + keyfile */
function credWithKey(password: string, keyFileName: string): kdbxweb.KdbxCredentials {
    return new kdbxweb.Credentials(
        kdbxweb.ProtectedValue.fromString(password),
        readFile(keyFileName)
    );
}

/** Credentials with password only */
function credPasswordOnly(password: string): kdbxweb.KdbxCredentials {
    return new kdbxweb.Credentials(
        kdbxweb.ProtectedValue.fromString(password)
    );
}

describe('pykeepass interop', () => {
    beforeAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    });

    afterAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(undefined as any);
    });

    // ---------------------------------------------------------------
    // test4.kdbx — KDBX4 with Argon2d + AES cipher, password+keyfile
    // ---------------------------------------------------------------

    describe('test4.kdbx (Argon2d + AES, password+keyfile)', () => {
        test('loads with password and keyfile', async () => {
            const cred = credWithKey('password', 'test4.key');
            const db = await kdbxweb.Kdbx.load(readFile('test4.kdbx'), cred);
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.versionMajor).toBe(4);
            expect(db.groups.length).toBe(1);
        }, 30000);

        test('has entries from pykeepass test suite', async () => {
            const cred = credWithKey('password', 'test4.key');
            const db = await kdbxweb.Kdbx.load(readFile('test4.kdbx'), cred);
            let entryCount = 0;
            for (const _e of db.getDefaultGroup().allEntries()) {
                entryCount++;
            }
            expect(entryCount).toBeGreaterThan(0);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // test4_aes.kdbx — KDBX4 with Argon2d + AES cipher, password+keyfile
    // ---------------------------------------------------------------

    describe('test4_aes.kdbx (Argon2d + AES, password+keyfile)', () => {
        test('loads with password and keyfile', async () => {
            const cred = credWithKey('password', 'test4.key');
            const db = await kdbxweb.Kdbx.load(readFile('test4_aes.kdbx'), cred);
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.versionMajor).toBe(4);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // test4_aes_uncompressed.kdbx — KDBX4, AES, no gzip, password only
    // ---------------------------------------------------------------

    describe('test4_aes_uncompressed.kdbx (Argon2d + AES, uncompressed)', () => {
        test('loads uncompressed database', async () => {
            const cred = credPasswordOnly('password');
            const db = await kdbxweb.Kdbx.load(
                readFile('test4_aes_uncompressed.kdbx'),
                cred
            );
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.versionMajor).toBe(4);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // test4_aeskdf.kdbx — KDBX4 with AES KDF, password+keyfile
    // ---------------------------------------------------------------

    describe('test4_aeskdf.kdbx (AES KDF, password+keyfile)', () => {
        test('loads with AES key derivation', async () => {
            const cred = credWithKey('password', 'test4.key');
            const db = await kdbxweb.Kdbx.load(
                readFile('test4_aeskdf.kdbx'),
                cred
            );
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.versionMajor).toBe(4);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // test4_chacha20.kdbx — KDBX4 with Argon2d + ChaCha20, password+keyfile
    // ---------------------------------------------------------------

    describe('test4_chacha20.kdbx (Argon2d + ChaCha20, password+keyfile)', () => {
        test('loads ChaCha20 encrypted database', async () => {
            const cred = credWithKey('password', 'test4.key');
            const db = await kdbxweb.Kdbx.load(
                readFile('test4_chacha20.kdbx'),
                cred
            );
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.versionMajor).toBe(4);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // test4_chacha20_uncompressed.kdbx — password only
    // ---------------------------------------------------------------

    describe('test4_chacha20_uncompressed.kdbx (Argon2d + ChaCha20, uncompressed)', () => {
        test('loads uncompressed ChaCha20 database', async () => {
            const cred = credPasswordOnly('password');
            const db = await kdbxweb.Kdbx.load(
                readFile('test4_chacha20_uncompressed.kdbx'),
                cred
            );
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.versionMajor).toBe(4);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // test4_argon2id.kdbx — KDBX4 with Argon2id KDF, password only
    // ---------------------------------------------------------------

    describe('test4_argon2id.kdbx (Argon2id, password only)', () => {
        test('loads Argon2id database', async () => {
            const cred = credPasswordOnly('password');
            const db = await kdbxweb.Kdbx.load(
                readFile('test4_argon2id.kdbx'),
                cred
            );
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.versionMajor).toBe(4);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // test4_blankpass.kdbx — KDBX4 with blank password + keyfile
    // ---------------------------------------------------------------

    describe('test4_blankpass.kdbx (blank password + keyfile)', () => {
        test('loads with empty password and keyfile', async () => {
            const cred = credWithKey('', 'test4.key');
            const db = await kdbxweb.Kdbx.load(
                readFile('test4_blankpass.kdbx'),
                cred
            );
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.versionMajor).toBe(4);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // test4_hex.kdbx — KDBX4 with hex keyfile
    // ---------------------------------------------------------------

    describe('test4_hex.kdbx (hex keyfile)', () => {
        test('loads with password and hex keyfile', async () => {
            const cred = credWithKey('password', 'test4_hex.key');
            const db = await kdbxweb.Kdbx.load(readFile('test4_hex.kdbx'), cred);
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.versionMajor).toBe(4);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // test4_keyx.kdbx — KDBX4 with v2 XML keyfile (.keyx)
    // ---------------------------------------------------------------

    describe('test4_keyx.kdbx (v2 XML keyfile)', () => {
        test('loads with v2 XML keyfile', async () => {
            const cred = credWithKey('password', 'test4_keyx.keyx');
            const db = await kdbxweb.Kdbx.load(readFile('test4_keyx.kdbx'), cred);
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.versionMajor).toBe(4);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // test4_transformed.kdbx — uses pre-computed transformed key
    // Skipped: our library doesn't support raw transformed key input.
    // The pykeepass test passes a raw 32-byte key instead of password.
    // ---------------------------------------------------------------

    describe('test4_transformed.kdbx (pre-computed transformed key)', () => {
        test.skip('requires raw transformed key (not supported in this API)', () => {
            // pykeepass uses transformed_key=b'\x95\x0b...' directly,
            // bypassing normal password hashing. Our Credentials API
            // doesn't expose this low-level path.
        });
    });

    // ---------------------------------------------------------------
    // Twofish cipher tests — error during decryption (unsupported cipher)
    // The Twofish files with keyfile fail at HMAC validation before we
    // reach cipher dispatch because the cipher UUID check happens
    // during decryption, after HMAC. With password-only files, we get
    // to the decryption step where Unsupported is thrown.
    // ---------------------------------------------------------------

    describe('Twofish cipher (unsupported)', () => {
        test('rejects test4_twofish.kdbx (password+keyfile)', async () => {
            const cred = credWithKey('password', 'test4.key');
            try {
                await kdbxweb.Kdbx.load(readFile('test4_twofish.kdbx'), cred);
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                // With correct credentials, reaches Unsupported cipher error
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.Unsupported
                );
            }
        }, 30000);

        test('rejects test4_twofish_uncompressed.kdbx (password only)', async () => {
            const cred = credPasswordOnly('password');
            try {
                await kdbxweb.Kdbx.load(
                    readFile('test4_twofish_uncompressed.kdbx'),
                    cred
                );
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.Unsupported
                );
            }
        }, 30000);
    });

    // ---------------------------------------------------------------
    // Wrong password rejection
    // ---------------------------------------------------------------

    describe('wrong password rejection', () => {
        test('rejects test4_aes_uncompressed.kdbx with wrong password', async () => {
            const cred = credPasswordOnly('wrong-password');
            try {
                await kdbxweb.Kdbx.load(
                    readFile('test4_aes_uncompressed.kdbx'),
                    cred
                );
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.InvalidKey
                );
            }
        }, 30000);
    });
});
