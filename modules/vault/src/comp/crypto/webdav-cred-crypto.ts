/**
 * AES-256-GCM encryption for WebDAV credentials (#57).
 *
 * Replaces the insecure XOR obfuscation with proper authenticated
 * encryption. The key is derived via HKDF-SHA256 from the master
 * password hash + fileId, so the stored ciphertext is only
 * recoverable by someone who knows the master password.
 *
 * Design mirrors `comp/passkey/passkey-prf.ts` (pure crypto layer,
 * no UI, no model imports). Callers decide where to persist the
 * ciphertext.
 *
 * Wire format: "aesgcm:" + base64(iv[12] + ciphertext + tag[16])
 * The "aesgcm:" prefix distinguishes new-format from legacy XOR
 * (which is base64 without prefix).
 *
 * HKDF info string is a wire-format constant. NEVER change it after
 * initial deployment -- doing so would break all existing encrypted
 * credentials.
 */

/** AES-GCM initialization vector length in bytes. */
const AES_GCM_IV_BYTES = 12;

/**
 * HKDF info label. Wire-format constant -- baked into users' stored
 * WebDAV credentials. Must stay 'keewebx-webdav-cred-v1' forever.
 */
const HKDF_INFO = 'keewebx-webdav-cred-v1';

/** Prefix for AES-GCM encrypted values in storage. */
export const AESGCM_PREFIX = 'aesgcm:';

/**
 * Derive an AES-256-GCM key from a password hash + fileId.
 *
 * @param passwordHash - SHA-256 hash of the master password (32 bytes),
 *   obtained from `file.db.credentials.passwordHash.getBinary()`.
 * @param fileId - KDBX file UUID, used as HKDF salt for domain separation.
 * @returns AES-256-GCM CryptoKey usable for encrypt/decrypt.
 */
export async function deriveWebDavKey(
    passwordHash: Uint8Array,
    fileId: string
): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        'raw',
        passwordHash as unknown as ArrayBuffer,
        { name: 'HKDF' },
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: encoder.encode(fileId) as unknown as ArrayBuffer,
            info: encoder.encode(HKDF_INFO) as unknown as ArrayBuffer
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt a WebDAV password with AES-256-GCM.
 *
 * @param password - Plaintext WebDAV password.
 * @param passwordHash - SHA-256 hash of the KDBX master password (32 bytes).
 * @param fileId - KDBX file UUID.
 * @returns "aesgcm:" + base64(iv + ciphertext + tag), or null if
 *   crypto.subtle is unavailable.
 */
export async function encryptWebDavPassword(
    password: string,
    passwordHash: Uint8Array,
    fileId: string
): Promise<string | null> {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
        return null;
    }
    const key = await deriveWebDavKey(passwordHash, fileId);
    const iv = new Uint8Array(AES_GCM_IV_BYTES);
    crypto.getRandomValues(iv);
    const plaintext = new TextEncoder().encode(password);
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
            key,
            plaintext as unknown as ArrayBuffer
        )
    );
    // Concatenate iv + ciphertext (which includes the 16-byte GCM tag)
    const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(ciphertext, iv.byteLength);
    return AESGCM_PREFIX + bytesToBase64(combined);
}

/**
 * Decrypt a WebDAV password previously encrypted with AES-256-GCM.
 *
 * @param encrypted - The "aesgcm:..." string from storage.
 * @param passwordHash - SHA-256 hash of the KDBX master password (32 bytes).
 * @param fileId - KDBX file UUID.
 * @returns The plaintext WebDAV password, or null on decryption failure
 *   (wrong master password, corrupted data, or crypto.subtle unavailable).
 */
export async function decryptWebDavPassword(
    encrypted: string,
    passwordHash: Uint8Array,
    fileId: string
): Promise<string | null> {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
        return null;
    }
    try {
        const b64 = encrypted.startsWith(AESGCM_PREFIX)
            ? encrypted.slice(AESGCM_PREFIX.length)
            : encrypted;
        const combined = base64ToBytes(b64);
        if (combined.byteLength < AES_GCM_IV_BYTES + 16) {
            // Too short to contain iv + tag
            return null;
        }
        const iv = combined.subarray(0, AES_GCM_IV_BYTES);
        const ciphertext = combined.subarray(AES_GCM_IV_BYTES);
        const key = await deriveWebDavKey(passwordHash, fileId);
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
            key,
            ciphertext as unknown as ArrayBuffer
        );
        return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    } catch {
        // Decryption failure (wrong password, corrupted data, etc.)
        return null;
    }
}

// -----------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        s += String.fromCharCode(bytes[i]);
    }
    return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
        out[i] = s.charCodeAt(i);
    }
    return out;
}

// -----------------------------------------------------------------
// Test-only exports (convention: __testing__ for internal helpers)
// -----------------------------------------------------------------

export const __testing__ = {
    HKDF_INFO,
    AES_GCM_IV_BYTES,
    bytesToBase64,
    base64ToBytes
};
