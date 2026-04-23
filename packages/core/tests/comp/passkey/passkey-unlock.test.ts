import { describe, test, expect, mock } from 'bun:test';

/**
 * Tests for `comp/passkey/passkey-unlock`.
 *
 * The module is mostly a glue layer over `passkey-prf` plus a WebCrypto
 * HKDF-SHA256 domain-separation step. Only the pieces that do NOT touch
 * `navigator.credentials` are reachable from Bun test env:
 *
 *   - `deriveWrapKey` (HKDF-SHA256)
 *   - the base64 <-> Uint8Array helpers
 *
 * `enablePasskeyForFile` / `unlockFileWithPasskey` both call into
 * `registerPasskey` / `evaluatePrf` which do a real WebAuthn ceremony;
 * those are covered by the Playwright virtual-authenticator spec that
 * SDET will add in Round 3.
 */

// kdbxweb mock shim — unused by the code path we exercise, but the
// top-level import of `passkey-unlock.ts` pulls it in.
mock.module('kdbxweb', () => ({
    ProtectedValue: {
        fromString: (s: string) => ({ _text: s, getText: () => s })
    }
}));

const { __testing__ } = await import(
    '../../../app/scripts/comp/passkey/passkey-unlock'
);
const { deriveWrapKey, HKDF_INFO_V1, bytesToBase64, base64ToBytes } = __testing__;

describe('passkey-unlock: deriveWrapKey (HKDF-SHA256 domain separation)', () => {
    test('returns exactly 32 bytes (AES-256 key size)', async () => {
        const prfOutput = crypto.getRandomValues(new Uint8Array(32));
        const key = await deriveWrapKey(prfOutput, 'file-abc');
        expect(key.byteLength).toBe(32);
    });

    test('is deterministic in (prfOutput, fileId)', async () => {
        const prfOutput = new Uint8Array(32).fill(0x42);
        const k1 = await deriveWrapKey(prfOutput, 'file-abc');
        const k2 = await deriveWrapKey(prfOutput, 'file-abc');
        expect(Array.from(k1)).toEqual(Array.from(k2));
    });

    test('differs per fileId (domain separation by HKDF salt)', async () => {
        // This is the critical security property: two files that reuse
        // the same passkey must produce independent wrap keys so a blob
        // from one file cannot be swapped into another.
        const prfOutput = new Uint8Array(32).fill(0x42);
        const kA = await deriveWrapKey(prfOutput, 'file-aaa');
        const kB = await deriveWrapKey(prfOutput, 'file-bbb');
        expect(Array.from(kA)).not.toEqual(Array.from(kB));
    });

    test('differs per prfOutput (binding to authenticator secret)', async () => {
        const fileId = 'file-xyz';
        const a = new Uint8Array(32).fill(0x11);
        const b = new Uint8Array(32).fill(0x22);
        const kA = await deriveWrapKey(a, fileId);
        const kB = await deriveWrapKey(b, fileId);
        expect(Array.from(kA)).not.toEqual(Array.from(kB));
    });

    test('HKDF info label is versioned (v1)', () => {
        // Guards against silent migration: if a future SWE changes
        // HKDF_INFO_V1 without bumping the version, this test fails
        // and forces them to audit existing wrapped blobs.
        expect(HKDF_INFO_V1).toBe('neokeeweb-passkey-unlock-v1');
    });
});

describe('passkey-unlock: base64 helpers round-trip', () => {
    test('empty array', () => {
        const r = base64ToBytes(bytesToBase64(new Uint8Array(0)));
        expect(r.byteLength).toBe(0);
    });

    test('random 64 bytes', () => {
        const original = crypto.getRandomValues(new Uint8Array(64));
        const roundtrip = base64ToBytes(bytesToBase64(original));
        expect(Array.from(roundtrip)).toEqual(Array.from(original));
    });

    test('handles non-ASCII byte values (0xFF etc)', () => {
        const original = new Uint8Array([0x00, 0x7f, 0x80, 0xfe, 0xff]);
        const b64 = bytesToBase64(original);
        const back = base64ToBytes(b64);
        expect(Array.from(back)).toEqual([0x00, 0x7f, 0x80, 0xfe, 0xff]);
    });
});
