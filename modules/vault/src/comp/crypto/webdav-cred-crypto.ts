import { BinaryStream, ByteUtils, Credentials, KeyEncryptorKdf, VarDictionary } from 'kdbxweb';

// Legacy ciphertext is only read to migrate existing connections. New
// ciphertext uses the KDBX KDF output and a separate HKDF context.
/** AES-GCM initialization vector length in bytes. */
const AES_GCM_IV_BYTES = 12;

/**
 * HKDF info label. Wire-format constant -- baked into users' stored
 * WebDAV credentials. Must stay 'keewebx-webdav-cred-v1' forever.
 */
const HKDF_INFO = 'keewebx-webdav-cred-v1';

/** Prefix for AES-GCM encrypted values in storage. */
export const AESGCM_PREFIX = 'aesgcm:';
export const KDF_AESGCM_PREFIX = 'aesgcm-v2:';
const KDF_HKDF_INFO = 'keewebx-webdav-cred-v2';

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
    fileId: string,
    info = HKDF_INFO
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
            info: encoder.encode(info) as unknown as ArrayBuffer
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
    fileId: string,
    info = HKDF_INFO
): Promise<string | null> {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
        return null;
    }
    const key = await deriveWebDavKey(passwordHash, fileId, info);
    const iv = new Uint8Array(AES_GCM_IV_BYTES);
    crypto.getRandomValues(iv);
    const plaintext = new TextEncoder().encode(password);
    let ciphertext: Uint8Array;
    try {
        ciphertext = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer }, key, plaintext as unknown as ArrayBuffer
        ));
    } finally {
        plaintext.fill(0);
    }
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
    fileId: string,
    info = HKDF_INFO
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
        const key = await deriveWebDavKey(passwordHash, fileId, info);
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
            key,
            ciphertext as unknown as ArrayBuffer
        );
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
        } finally {
            ByteUtils.zeroBuffer(plaintext);
        }
    } catch {
        // Decryption failure (wrong password, corrupted data, etc.)
        return null;
    }
}

async function withTransformedKey<T>(
    credentials: Credentials, parameters: VarDictionary, use: (key: Uint8Array) => Promise<T>
): Promise<T> {
    await credentials.ready;
    if (!credentials.passwordHash && !credentials.keyFileHash) throw new Error('Missing vault credentials');
    const composite = await credentials.getHash();
    let key: ArrayBuffer | undefined;
    try {
        key = await KeyEncryptorKdf.encrypt(composite, parameters);
        return await use(new Uint8Array(key));
    } finally {
        ByteUtils.zeroBuffer(composite);
        if (key) ByteUtils.zeroBuffer(key);
    }
}

export async function encryptWebDavPasswordWithKdf(
    password: string, credentials: Credentials, parameters: VarDictionary, fileId: string
): Promise<{ encpass: string; encpassKdf: string } | undefined> {
    if (!globalThis.crypto?.subtle) return undefined;
    const stream = new BinaryStream();
    // Keep the exact KDBX KDF settings so the connection can be unlocked
    // before downloading the database, even when offline caching is disabled.
    parameters.write(stream);
    const encpassKdf = bytesToBase64(new Uint8Array(stream.getWrittenBytes()));
    const snapshot = VarDictionary.read(new BinaryStream(stream.getWrittenBytes()));
    const encrypted = await withTransformedKey(credentials, snapshot, key =>
        encryptWebDavPassword(password, key, fileId, KDF_HKDF_INFO));
    return encrypted ? {
        encpass: KDF_AESGCM_PREFIX + encrypted.slice(AESGCM_PREFIX.length),
        encpassKdf
    } : undefined;
}

export async function decryptWebDavPasswordWithKdf(
    encrypted: string, credentials: Credentials, encodedParameters: string, fileId: string
): Promise<string | null> {
    if (!globalThis.crypto?.subtle || !encrypted.startsWith(KDF_AESGCM_PREFIX) || encodedParameters.length > 2048) {
        return null;
    }
    try {
        const parameters = VarDictionary.read(new BinaryStream(ByteUtils.arrayToBuffer(base64ToBytes(encodedParameters))));
        return await withTransformedKey(credentials, parameters, key =>
            decryptWebDavPassword(encrypted.slice(KDF_AESGCM_PREFIX.length), key, fileId, KDF_HKDF_INFO));
    } catch {
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
