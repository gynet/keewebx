/**
 * Cross-implementation compatibility tests using test databases from keepass-rs.
 * Source: https://github.com/sseemayer/keepass-rs (MIT license)
 *
 * These tests verify that our KDBX4 implementation can read databases created
 * by keepass-rs, covering various KDF + cipher combinations.
 *
 * NOTE: Many keepass-rs test databases use Argon2 with >=256MB memory, which
 * exceeds the 128MB WASM heap of our test argon2-asm module. Those tests are
 * skipped here and marked accordingly. They would pass with a production
 * Argon2 implementation (e.g., argon2-browser with dynamic memory).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as kdbxweb from '../../lib';
import { argon2 } from '../test-support/argon2';

const EXTERNAL_DIR = path.join(__dirname, '../../resources/external');

function readExternal(name: string): ArrayBuffer {
    const filePath = path.join(EXTERNAL_DIR, name);
    const content = fs.readFileSync(filePath);
    return kdbxweb.ByteUtils.arrayToBuffer(new Uint8Array(content));
}

describe('keepass-rs interop', () => {
    beforeAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    });

    afterAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(undefined as any);
    });

    // ---------------------------------------------------------------
    // KDBX4 with AES KDF (no Argon2 needed - works with test module)
    // ---------------------------------------------------------------

    describe('KDBX4 with password + AES KDF + AES cipher', () => {
        test('loads and has valid structure', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('demopass')
            );
            const db = await kdbxweb.Kdbx.load(
                readExternal('test_db_kdbx4_with_password_aes.kdbx'),
                cred
            );
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.groups.length).toBe(1);
            expect(db.groups[0].name).toBe('Root');
        }, 30000);

        test('reads entry fields correctly', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('demopass')
            );
            const db = await kdbxweb.Kdbx.load(
                readExternal('test_db_kdbx4_with_password_aes.kdbx'),
                cred
            );
            // keepass-rs verifies 1 entry in root with title "ASDF"
            const defaultGroup = db.getDefaultGroup();
            expect(defaultGroup.entries.length).toBe(1);
            expect(defaultGroup.entries[0].fields.get('Title')).toBe('ASDF');
        }, 30000);
    });

    // ---------------------------------------------------------------
    // KDBX4 fuzzing database (low round Argon2 - fits in 128MB)
    // ---------------------------------------------------------------

    describe('KDBX4 with few rounds (fuzzing db)', () => {
        test('loads with password "demopass"', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('demopass')
            );
            const db = await kdbxweb.Kdbx.load(
                readExternal('test_db_few_rounds.kdbx'),
                cred
            );
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.groups.length).toBe(1);
            expect(db.groups[0].name).toBe('Root');
        }, 30000);
    });

    // ---------------------------------------------------------------
    // KDBX4 with high-memory Argon2 (skipped: argon2-asm 128MB limit)
    // These databases use default KeePass Argon2 settings (256MB+).
    // They work with argon2-browser or native Argon2 in production.
    // ---------------------------------------------------------------

    describe('KDBX4 with high-memory Argon2 (require >128MB WASM)', () => {
        test.skip('Argon2d KDF + AES cipher', () => {
            // File: test_db_kdbx4_with_password_argon2.kdbx, password: "demopass"
        });

        test.skip('Argon2id KDF + AES cipher', () => {
            // File: test_db_kdbx4_with_password_argon2id.kdbx, password: "demopass"
        });

        test.skip('Argon2d KDF + ChaCha20 cipher', () => {
            // File: test_db_kdbx4_with_password_argon2_chacha20.kdbx, password: "demopass"
        });

        test.skip('Argon2id KDF + ChaCha20 cipher', () => {
            // File: test_db_kdbx4_with_password_argon2id_chacha20.kdbx, password: "demopass"
        });

        test.skip('Argon2d KDF + Twofish cipher (unsupported cipher)', () => {
            // File: test_db_kdbx4_with_password_argon2_twofish.kdbx, password: "demopass"
            // Even if Argon2 passed, Twofish is not supported and should throw Unsupported.
        });

        test.skip('Argon2id KDF + Twofish cipher (unsupported cipher)', () => {
            // File: test_db_kdbx4_with_password_argon2id_twofish.kdbx, password: "demopass"
        });

        test.skip('Argon2 + deleted entry with recycle bin', () => {
            // File: test_db_kdbx4_with_password_deleted_entry.kdbx, password: "demopass"
        });

        test.skip('Argon2 + TOTP entry', () => {
            // File: test_db_kdbx4_with_totp_entry.kdbx, password: "test"
        });

        test.skip('Argon2 + keyfile v1 (no password)', () => {
            // File: test_db_kdbx4_with_keyfile.kdbx, keyfile: test_key.key
        });

        test.skip('Argon2 + keyfile v2 + password "demopass"', () => {
            // File: test_db_kdbx4_with_keyfile_v2.kdbx, keyfile: .keyx, password: "demopass"
        });

        test.skip('Argon2 + keyfile v2 alt (tabs in key data) + password "123123"', () => {
            // File: test_db_kdbx4_with_keyfile_v2_alt.kdbx, keyfile: .keyx, password: "123123"
        });
    });

    // ---------------------------------------------------------------
    // KDBX3 files - should be rejected with InvalidVersion
    // ---------------------------------------------------------------

    describe('KDBX3 files (should be rejected)', () => {
        test('rejects KDBX3 with password', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('demopass')
            );
            try {
                await kdbxweb.Kdbx.load(
                    readExternal('test_db_with_password.kdbx'),
                    cred
                );
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.InvalidVersion
                );
            }
        });

        test('rejects KDBX3 with chacha20 protected fields', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('password')
            );
            try {
                await kdbxweb.Kdbx.load(
                    readExternal('test_db_kdbx3_with_chacha20_protected_fields.kdbx'),
                    cred
                );
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.InvalidVersion
                );
            }
        });
    });

    // ---------------------------------------------------------------
    // Broken files - should produce errors, not crashes
    // ---------------------------------------------------------------

    describe('broken files', () => {
        test('rejects random data', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('')
            );
            try {
                await kdbxweb.Kdbx.load(
                    readExternal('broken_random_data.kdbx'),
                    cred
                );
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            }
        });

        test('rejects broken KDBX version', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('')
            );
            try {
                await kdbxweb.Kdbx.load(
                    readExternal('broken_kdbx_version.kdbx'),
                    cred
                );
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            }
        });
    });
});
