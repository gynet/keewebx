import { describe, test, expect } from 'bun:test';

/**
 * Tests for the pure crypto half of `comp/passkey/passkey-prf`.
 *
 * Only the `wrapKey` / `unwrapKey` AES-256-GCM roundtrip is tested
 * here — it is pure WebCrypto and needs no WebAuthn mocking. The
 * `registerPasskey` and `evaluatePrf` paths touch
 * `navigator.credentials` which requires a user gesture and a real
 * authenticator; those are covered by E2E tests in a later phase of
 * #9 once the UI lands and the test harness has a virtual
 * authenticator configured.
 *
 * Bun ships a WebCrypto-compatible `crypto.subtle` polyfill, so
 * importing the module at the top level works without any globalThis
 * shims.
 */

const {
    wrapKey,
    unwrapKey,
    isPasskeyPrfSupported
} = await import('../../../app/scripts/comp/passkey/passkey-prf');

// Helper: deterministic Uint8Array filler so tests stay readable.
function bytes(len: number, fill = 0): Uint8Array {
    const b = new Uint8Array(len);
    b.fill(fill);
    return b;
}

describe('passkey-prf: wrapKey / unwrapKey roundtrip', () => {
    test('wraps and unwraps a 32-byte file key', async () => {
        const fileKey = crypto.getRandomValues(new Uint8Array(32));
        const prfOutput = crypto.getRandomValues(new Uint8Array(32));

        const wrapped = await wrapKey(fileKey, prfOutput);
        const unwrapped = await unwrapKey(wrapped, prfOutput);

        expect(Array.from(unwrapped)).toEqual(Array.from(fileKey));
    });

    test('wrapped blob layout is iv(12) || ciphertext+tag', async () => {
        const fileKey = bytes(32, 0xab);
        const prfOutput = bytes(32, 0x42);

        const wrapped = await wrapKey(fileKey, prfOutput);
        // AES-GCM adds a 16-byte tag to the ciphertext, so for a
        // 32-byte plaintext the total is 12 (iv) + 32 (ct) + 16 (tag).
        expect(wrapped.byteLength).toBe(12 + 32 + 16);
    });

    test('each wrap uses a fresh random IV', async () => {
        const fileKey = bytes(32, 0xcc);
        const prfOutput = bytes(32, 0xdd);

        const a = await wrapKey(fileKey, prfOutput);
        const b = await wrapKey(fileKey, prfOutput);

        // IV is the first 12 bytes; they MUST differ across calls.
        // Identical IV with GCM is a catastrophic key-recovery hazard
        // — this test is the regression guard against a future "use
        // a constant IV for determinism" refactor.
        expect(Array.from(a.subarray(0, 12))).not.toEqual(
            Array.from(b.subarray(0, 12))
        );
    });

    test('unwrap with wrong PRF output fails (AES-GCM tag mismatch)', async () => {
        const fileKey = bytes(32, 0x01);
        const goodPrf = bytes(32, 0x02);
        const badPrf = bytes(32, 0x03);

        const wrapped = await wrapKey(fileKey, goodPrf);

        // Bun's WebCrypto throws OperationError for a tag mismatch.
        // We assert on the promise rejection regardless of the
        // concrete error class.
        await expect(unwrapKey(wrapped, badPrf)).rejects.toBeDefined();
    });

    test('unwrap with tampered ciphertext fails', async () => {
        const fileKey = bytes(32, 0x10);
        const prf = bytes(32, 0x20);

        const wrapped = await wrapKey(fileKey, prf);
        // Flip one bit in the ciphertext region.
        const tampered = new Uint8Array(wrapped);
        tampered[20] ^= 0x01;

        await expect(unwrapKey(tampered, prf)).rejects.toBeDefined();
    });

    test('wrapKey rejects non-32-byte PRF outputs', async () => {
        const fileKey = bytes(16);
        await expect(wrapKey(fileKey, bytes(16))).rejects.toThrow(
            /PRF output must be 32 bytes/
        );
        await expect(wrapKey(fileKey, bytes(64))).rejects.toThrow(
            /PRF output must be 32 bytes/
        );
    });

    test('unwrapKey rejects truncated ciphertext', async () => {
        const prf = bytes(32, 0xee);
        // 12 bytes of iv + 15 bytes of body = 27, which is less than
        // the minimum valid payload (iv + tag = 28).
        await expect(unwrapKey(bytes(27), prf)).rejects.toThrow(/too short/);
    });

    test('roundtrip with empty plaintext', async () => {
        const empty = new Uint8Array(0);
        const prf = bytes(32, 0x77);

        const wrapped = await wrapKey(empty, prf);
        const unwrapped = await unwrapKey(wrapped, prf);

        expect(unwrapped.byteLength).toBe(0);
    });

    test('roundtrip with large plaintext (1 MiB)', async () => {
        const plain = crypto.getRandomValues(new Uint8Array(1024 * 1024));
        const prf = crypto.getRandomValues(new Uint8Array(32));

        const wrapped = await wrapKey(plain, prf);
        const unwrapped = await unwrapKey(wrapped, prf);

        // Cheap roundtrip equality — full Array.from on 1 MiB would be
        // slow to stringify in a test failure message. Compare byte
        // length + a sample of positions instead.
        expect(unwrapped.byteLength).toBe(plain.byteLength);
        expect(unwrapped[0]).toBe(plain[0]);
        expect(unwrapped[plain.byteLength - 1]).toBe(plain[plain.byteLength - 1]);
        expect(unwrapped[plain.byteLength >> 1]).toBe(
            plain[plain.byteLength >> 1]
        );
    });
});

describe('passkey-prf: isPasskeyPrfSupported', () => {
    test('returns a boolean', () => {
        // We cannot assert true/false here because Bun's test runtime
        // may or may not expose PublicKeyCredential. The contract is
        // that the check never throws and always returns a boolean.
        const result = isPasskeyPrfSupported();
        expect(typeof result).toBe('boolean');
    });
});
