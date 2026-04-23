/**
 * Unit tests for WebDAV credential AES-256-GCM encryption (#57).
 *
 * These tests exercise the pure crypto module directly — no mocks,
 * no storage layer, no model layer. Bun's built-in Web Crypto API
 * (via `crypto.subtle`) powers all SubtleCrypto operations.
 */
import { describe, test, expect } from 'bun:test';

import {
    deriveWebDavKey,
    encryptWebDavPassword,
    decryptWebDavPassword,
    AESGCM_PREFIX,
    __testing__
} from '../../../app/scripts/comp/crypto/webdav-cred-crypto';

// Helper: create a deterministic 32-byte password hash for testing
function makePasswordHash(seed: number): Uint8Array {
    const hash = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        hash[i] = (seed + i) & 0xff;
    }
    return hash;
}

describe('deriveWebDavKey', () => {
    test('same password + fileId -> same key (deterministic)', async () => {
        const hash = makePasswordHash(42);
        const key1 = await deriveWebDavKey(hash, 'file-123');
        const key2 = await deriveWebDavKey(hash, 'file-123');
        // CryptoKey objects are not directly comparable; verify by
        // encrypting the same data and checking deterministic output
        // when using the same IV.
        const iv = new Uint8Array(12); // all zeros
        const data = new TextEncoder().encode('test');
        const ct1 = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key1, data)
        );
        const ct2 = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key2, data)
        );
        expect(ct1).toEqual(ct2);
    });

    test('different password -> different key', async () => {
        const hash1 = makePasswordHash(1);
        const hash2 = makePasswordHash(99);
        const key1 = await deriveWebDavKey(hash1, 'file-abc');
        const key2 = await deriveWebDavKey(hash2, 'file-abc');
        const iv = new Uint8Array(12);
        const data = new TextEncoder().encode('test');
        const ct1 = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key1, data)
        );
        const ct2 = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key2, data)
        );
        expect(ct1).not.toEqual(ct2);
    });

    test('different fileId -> different key', async () => {
        const hash = makePasswordHash(42);
        const key1 = await deriveWebDavKey(hash, 'file-111');
        const key2 = await deriveWebDavKey(hash, 'file-222');
        const iv = new Uint8Array(12);
        const data = new TextEncoder().encode('test');
        const ct1 = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key1, data)
        );
        const ct2 = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key2, data)
        );
        expect(ct1).not.toEqual(ct2);
    });
});

describe('encryptWebDavPassword + decryptWebDavPassword', () => {
    const hash = makePasswordHash(7);
    const fileId = 'test-file-uuid';

    test('round-trip: encrypt then decrypt returns original', async () => {
        const password = 'my-webdav-password!';
        const encrypted = await encryptWebDavPassword(password, hash, fileId);
        expect(encrypted).not.toBeNull();
        const decrypted = await decryptWebDavPassword(encrypted!, hash, fileId);
        expect(decrypted).toBe(password);
    });

    test('decryptWebDavPassword with wrong password -> returns null', async () => {
        const encrypted = await encryptWebDavPassword('secret', hash, fileId);
        expect(encrypted).not.toBeNull();
        const wrongHash = makePasswordHash(99);
        const decrypted = await decryptWebDavPassword(encrypted!, wrongHash, fileId);
        expect(decrypted).toBeNull();
    });

    test('decryptWebDavPassword with corrupted ciphertext -> returns null', async () => {
        const encrypted = await encryptWebDavPassword('secret', hash, fileId);
        expect(encrypted).not.toBeNull();
        // Corrupt the ciphertext by flipping a character in the base64 body
        const prefix = AESGCM_PREFIX;
        const b64 = encrypted!.slice(prefix.length);
        const corrupted = prefix + 'X' + b64.slice(1);
        const decrypted = await decryptWebDavPassword(corrupted, hash, fileId);
        expect(decrypted).toBeNull();
    });

    test('encryptWebDavPassword: empty password -> works', async () => {
        const encrypted = await encryptWebDavPassword('', hash, fileId);
        expect(encrypted).not.toBeNull();
        expect(encrypted!.startsWith(AESGCM_PREFIX)).toBe(true);
        const decrypted = await decryptWebDavPassword(encrypted!, hash, fileId);
        expect(decrypted).toBe('');
    });

    test('encryptWebDavPassword: unicode password (Chinese, emoji) -> works', async () => {
        const password = '\u5bc6\u7801\ud83d\udd12test\u00e9';
        const encrypted = await encryptWebDavPassword(password, hash, fileId);
        expect(encrypted).not.toBeNull();
        const decrypted = await decryptWebDavPassword(encrypted!, hash, fileId);
        expect(decrypted).toBe(password);
    });

    test('encryptWebDavPassword: produces different ciphertext each call (random IV)', async () => {
        const password = 'determinism-check';
        const enc1 = await encryptWebDavPassword(password, hash, fileId);
        const enc2 = await encryptWebDavPassword(password, hash, fileId);
        expect(enc1).not.toBeNull();
        expect(enc2).not.toBeNull();
        // Both should decrypt to the same value
        expect(await decryptWebDavPassword(enc1!, hash, fileId)).toBe(password);
        expect(await decryptWebDavPassword(enc2!, hash, fileId)).toBe(password);
        // But the ciphertext should differ due to random IV
        expect(enc1).not.toBe(enc2);
    });

    test('format prefix: encrypted output starts with "aesgcm:"', async () => {
        const encrypted = await encryptWebDavPassword('test', hash, fileId);
        expect(encrypted).not.toBeNull();
        expect(encrypted!.startsWith('aesgcm:')).toBe(true);
    });

    test('decryptWebDavPassword: too-short input -> returns null', async () => {
        const result = await decryptWebDavPassword('aesgcm:AQID', hash, fileId);
        expect(result).toBeNull();
    });

    test('decryptWebDavPassword: invalid base64 -> returns null', async () => {
        const result = await decryptWebDavPassword('aesgcm:!!!invalid!!!', hash, fileId);
        expect(result).toBeNull();
    });

    test('different fileId cannot decrypt', async () => {
        const encrypted = await encryptWebDavPassword('secret', hash, 'file-A');
        expect(encrypted).not.toBeNull();
        const decrypted = await decryptWebDavPassword(encrypted!, hash, 'file-B');
        expect(decrypted).toBeNull();
    });

    test('long password (1000 chars) round-trips', async () => {
        const longPassword = 'A'.repeat(1000);
        const encrypted = await encryptWebDavPassword(longPassword, hash, fileId);
        expect(encrypted).not.toBeNull();
        const decrypted = await decryptWebDavPassword(encrypted!, hash, fileId);
        expect(decrypted).toBe(longPassword);
    });
});

describe('__testing__ helpers', () => {
    test('HKDF_INFO is the expected wire-format constant', () => {
        expect(__testing__.HKDF_INFO).toBe('keewebx-webdav-cred-v1');
    });

    test('AES_GCM_IV_BYTES is 12', () => {
        expect(__testing__.AES_GCM_IV_BYTES).toBe(12);
    });

    test('bytesToBase64 round-trips with base64ToBytes', () => {
        const original = new Uint8Array([0, 1, 127, 128, 255]);
        const b64 = __testing__.bytesToBase64(original);
        const recovered = __testing__.base64ToBytes(b64);
        expect(recovered).toEqual(original);
    });
});
