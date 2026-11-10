/**
 * Cross-implementation compatibility tests using test databases from keepass-rs.
 * Source: https://github.com/sseemayer/keepass-rs (MIT license)
 *
 * These tests verify that our KDBX4 implementation can read databases created
 * by keepass-rs, covering various KDF + cipher combinations.
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
    // KDBX4 fuzzing database (low round Argon2)
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
    // KDBX4 with default KeePass Argon2 settings (high memory)
    // ---------------------------------------------------------------

    describe('KDBX4 with high-memory Argon2', () => {
        const passwordCases: Array<[string, string, string]> = [
            ['Argon2d KDF + AES cipher', 'test_db_kdbx4_with_password_argon2.kdbx', 'demopass'],
            ['Argon2id KDF + AES cipher', 'test_db_kdbx4_with_password_argon2id.kdbx', 'demopass'],
            ['Argon2d KDF + ChaCha20 cipher', 'test_db_kdbx4_with_password_argon2_chacha20.kdbx', 'demopass'],
            ['Argon2id KDF + ChaCha20 cipher', 'test_db_kdbx4_with_password_argon2id_chacha20.kdbx', 'demopass'],
            ['Argon2 + deleted entry with recycle bin', 'test_db_kdbx4_with_password_deleted_entry.kdbx', 'demopass'],
            ['Argon2 + TOTP entry', 'test_db_kdbx4_with_totp_entry.kdbx', 'test']
        ];

        for (const [name, file, password] of passwordCases) {
            test(name, async () => {
                const db = await kdbxweb.Kdbx.load(
                    readExternal(file),
                    new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password))
                );
                expect(db).toBeInstanceOf(kdbxweb.Kdbx);
                expect(db.groups.length).toBe(1);
            }, 120000);
        }

        const twofishCases: Array<[string, string]> = [
            ['Argon2d KDF + Twofish cipher', 'test_db_kdbx4_with_password_argon2_twofish.kdbx'],
            ['Argon2id KDF + Twofish cipher', 'test_db_kdbx4_with_password_argon2id_twofish.kdbx']
        ];

        for (const [name, file] of twofishCases) {
            test(`${name} is rejected as unsupported`, async () => {
                const load = kdbxweb.Kdbx.load(
                    readExternal(file),
                    new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('demopass'))
                );
                await expect(load).rejects.toMatchObject({
                    code: kdbxweb.Consts.ErrorCodes.Unsupported
                });
            }, 120000);
        }

        const keyfileCases: Array<[string, string, string, string | null]> = [
            ['Argon2 + keyfile v1 (no password)', 'test_db_kdbx4_with_keyfile.kdbx', 'test_key.key', null],
            ['Argon2 + keyfile v2 + password', 'test_db_kdbx4_with_keyfile_v2.kdbx', 'test_db_kdbx4_with_keyfile_v2.keyx', 'demopass'],
            ['Argon2 + keyfile v2 alt (tabs in key data) + password', 'test_db_kdbx4_with_keyfile_v2_alt.kdbx', 'test_db_kdbx4_with_keyfile_v2_alt.keyx', '123123']
        ];

        for (const [name, file, keyfile, password] of keyfileCases) {
            test(name, async () => {
                const db = await kdbxweb.Kdbx.load(
                    readExternal(file),
                    new kdbxweb.Credentials(
                        password === null ? null : kdbxweb.ProtectedValue.fromString(password),
                        readExternal(keyfile)
                    )
                );
                expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            }, 120000);
        }
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
