import { describe, test, expect } from 'bun:test';
import { box, randomBytes } from 'tweetnacl';

/**
 * Tests for the NaCl box encryption used in the extension <-> app protocol.
 * The protocol uses tweetnacl's box (x25519-xsalsa20-poly1305) for
 * authenticated encryption between the extension and the web app.
 */

// Helpers (mirror src/background/utils.ts)
function toBase64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

function fromBase64(str: string): Uint8Array {
    return Uint8Array.from(atob(str), (ch) => ch.charCodeAt(0));
}

// Nonce increment (mirrors protocol-impl.ts validateNonce, from libsodium)
function incrementNonce(nonce: Uint8Array): Uint8Array {
    const out = new Uint8Array(nonce);
    let c = 1;
    for (let i = 0; i < out.length; i++) {
        c += out[i];
        out[i] = c & 0xff;
        c >>= 8;
    }
    return out;
}

describe('base64 encoding', () => {
    test('round-trips random bytes', () => {
        const original = randomBytes(32);
        const encoded = toBase64(original);
        const decoded = fromBase64(encoded);
        expect(decoded).toEqual(original);
    });

    test('handles empty array', () => {
        const empty = new Uint8Array(0);
        const encoded = toBase64(empty);
        const decoded = fromBase64(encoded);
        expect(decoded).toEqual(empty);
    });

    test('handles known values', () => {
        const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
        const encoded = toBase64(bytes);
        expect(encoded).toBe('SGVsbG8=');
        expect(fromBase64(encoded)).toEqual(bytes);
    });
});

describe('nonce increment', () => {
    test('increments a zero nonce', () => {
        const nonce = new Uint8Array(24);
        const incremented = incrementNonce(nonce);
        expect(incremented[0]).toBe(1);
        for (let i = 1; i < 24; i++) {
            expect(incremented[i]).toBe(0);
        }
    });

    test('carries over on overflow', () => {
        const nonce = new Uint8Array(24);
        nonce[0] = 0xff;
        const incremented = incrementNonce(nonce);
        expect(incremented[0]).toBe(0);
        expect(incremented[1]).toBe(1);
    });

    test('carries over multiple bytes', () => {
        const nonce = new Uint8Array(24);
        nonce[0] = 0xff;
        nonce[1] = 0xff;
        nonce[2] = 0xff;
        const incremented = incrementNonce(nonce);
        expect(incremented[0]).toBe(0);
        expect(incremented[1]).toBe(0);
        expect(incremented[2]).toBe(0);
        expect(incremented[3]).toBe(1);
    });

    test('does not modify original', () => {
        const nonce = new Uint8Array(24);
        nonce[0] = 5;
        incrementNonce(nonce);
        expect(nonce[0]).toBe(5);
    });
});

describe('tweetnacl box encryption', () => {
    test('encrypts and decrypts a message', () => {
        const senderKeys = box.keyPair();
        const receiverKeys = box.keyPair();
        const nonce = randomBytes(24);

        const message = new TextEncoder().encode('{"action":"ping","data":"test123"}');

        const encrypted = box(message, nonce, receiverKeys.publicKey, senderKeys.secretKey);
        expect(encrypted.length).toBeGreaterThan(0);

        const decrypted = box.open(encrypted, nonce, senderKeys.publicKey, receiverKeys.secretKey);
        expect(decrypted).not.toBeNull();
        expect(decrypted).toEqual(message);
    });

    test('decryption fails with wrong key', () => {
        const senderKeys = box.keyPair();
        const receiverKeys = box.keyPair();
        const wrongKeys = box.keyPair();
        const nonce = randomBytes(24);

        const message = new TextEncoder().encode('secret data');
        const encrypted = box(message, nonce, receiverKeys.publicKey, senderKeys.secretKey);

        const decrypted = box.open(encrypted, nonce, wrongKeys.publicKey, receiverKeys.secretKey);
        expect(decrypted).toBeNull();
    });

    test('decryption fails with wrong nonce', () => {
        const senderKeys = box.keyPair();
        const receiverKeys = box.keyPair();
        const nonce = randomBytes(24);
        const wrongNonce = randomBytes(24);

        const message = new TextEncoder().encode('secret data');
        const encrypted = box(message, nonce, receiverKeys.publicKey, senderKeys.secretKey);

        const decrypted = box.open(
            encrypted,
            wrongNonce,
            senderKeys.publicKey,
            receiverKeys.secretKey
        );
        expect(decrypted).toBeNull();
    });

    test('produces different ciphertext for same plaintext with different nonces', () => {
        const senderKeys = box.keyPair();
        const receiverKeys = box.keyPair();
        const nonce1 = randomBytes(24);
        const nonce2 = randomBytes(24);

        const message = new TextEncoder().encode('same message');
        const encrypted1 = box(message, nonce1, receiverKeys.publicKey, senderKeys.secretKey);
        const encrypted2 = box(message, nonce2, receiverKeys.publicKey, senderKeys.secretKey);

        expect(toBase64(encrypted1)).not.toBe(toBase64(encrypted2));
    });
});

describe('protocol message serialization', () => {
    test('serializes and deserializes a request payload through encryption', () => {
        const extensionKeys = box.keyPair();
        const appKeys = box.keyPair();
        const nonce = randomBytes(24);

        const payload = {
            action: 'get-logins',
            url: 'https://example.com'
        };

        const json = JSON.stringify(payload);
        const data = new TextEncoder().encode(json);

        // Extension encrypts with app's public key
        const encrypted = box(data, nonce, appKeys.publicKey, extensionKeys.secretKey);

        // App decrypts with extension's public key
        const decrypted = box.open(encrypted, nonce, extensionKeys.publicKey, appKeys.secretKey);
        expect(decrypted).not.toBeNull();

        const decryptedJson = new TextDecoder().decode(decrypted!);
        const decryptedPayload = JSON.parse(decryptedJson);

        expect(decryptedPayload.action).toBe('get-logins');
        expect(decryptedPayload.url).toBe('https://example.com');
    });

    test('handles unicode in message payloads', () => {
        const extensionKeys = box.keyPair();
        const appKeys = box.keyPair();
        const nonce = randomBytes(24);

        const payload = {
            action: 'get-logins',
            url: 'https://example.com/login',
            title: 'Login page \u2014 Example \u2022 \u4f60\u597d'
        };

        const json = JSON.stringify(payload);
        const data = new TextEncoder().encode(json);

        const encrypted = box(data, nonce, appKeys.publicKey, extensionKeys.secretKey);
        const decrypted = box.open(encrypted, nonce, extensionKeys.publicKey, appKeys.secretKey);
        expect(decrypted).not.toBeNull();

        const decryptedPayload = JSON.parse(new TextDecoder().decode(decrypted!));
        expect(decryptedPayload.title).toBe('Login page \u2014 Example \u2022 \u4f60\u597d');
    });

    test('nonce validation matches the protocol increment scheme', () => {
        const nonce = randomBytes(24);
        const nonceBase64 = toBase64(nonce);
        const incremented = incrementNonce(nonce);
        const incrementedBase64 = toBase64(incremented);

        // The response nonce should be the request nonce + 1
        expect(incrementedBase64).not.toBe(nonceBase64);

        // Verify re-incrementing the original gives the same result
        const incremented2 = incrementNonce(fromBase64(nonceBase64));
        expect(toBase64(incremented2)).toBe(incrementedBase64);
    });
});

describe('key pair generation', () => {
    test('generates unique key pairs', () => {
        const pair1 = box.keyPair();
        const pair2 = box.keyPair();

        expect(toBase64(pair1.publicKey)).not.toBe(toBase64(pair2.publicKey));
        expect(toBase64(pair1.secretKey)).not.toBe(toBase64(pair2.secretKey));
    });

    test('key pair has correct sizes', () => {
        const pair = box.keyPair();
        expect(pair.publicKey.length).toBe(32);
        expect(pair.secretKey.length).toBe(32);
    });
});
