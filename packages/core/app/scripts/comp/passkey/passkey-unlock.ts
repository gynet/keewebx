/**
 * Passkey quick-unlock glue layer (#9, Phase 2).
 *
 * `passkey-prf.ts` is the pure primitive layer: it speaks WebAuthn PRF
 * and AES-GCM wrap/unwrap, but it is deliberately key-material-agnostic.
 * Tying it to "a stored KDBX master password string" lives here.
 *
 * Responsibilities of this module (intentionally small):
 *
 *   1. HKDF-SHA256 domain separation of the PRF output into an AES key,
 *      keyed by the file id. The version string in `info` is the
 *      forward-migration knob — a future `v2` can change the derivation
 *      shape without silent fall-through.
 *
 *   2. Wrap a UTF-8 master password string by the derived key and
 *      base64-encode the result for FileInfo persistence.
 *
 *   3. The mirror unwrap path. Both directions zero the PRF-derived
 *      bytes immediately after use so they do not linger in the heap
 *      beyond the async window.
 *
 *   4. High-level `enablePasskeyForFile()` and `unlockFileWithPasskey()`
 *      helpers that compose registerPasskey / evaluatePrf / wrap / unwrap
 *      into a single call so the view layer stays readable.
 *
 * Security posture: matches existing Touch ID `encryptedPassword` slot
 * behaviour — a local-storage attacker who also has passkey UV on the
 * user's device can decrypt. Not stronger, not weaker. Documented in
 * the TL brief.
 */

import * as kdbxweb from 'kdbxweb';

import {
    evaluatePrf,
    PasskeyPrfNotSupportedError,
    registerPasskey,
    unwrapKey,
    wrapKey
} from 'comp/passkey/passkey-prf';

// Re-export for view-layer error branching without forcing the view
// to import the prf primitive module directly. Keeps the seam at
// the unlock layer where the rest of the high-level surface lives.
export { PasskeyPrfNotSupportedError };

/**
 * HKDF `info` label. Bumping this is how we migrate the wrap derivation
 * without silent fallback — the v1 wrapped blobs become un-openable and
 * the user is forced to re-enable. Bake version into both wrap and
 * unwrap calls so a salt/info mismatch surfaces as a GCM auth error.
 */
// Wire-format constant — baked into users' passkey-encrypted databases.
// Must stay 'neokeeweb-*' forever regardless of product rebrand to KeeWebX.
const HKDF_INFO_V1 = 'neokeeweb-passkey-unlock-v1';

const AAD_VERSION = 'neokeeweb-passkey-wrap-v1';

function buildAad(fileId: string): Uint8Array {
    return new TextEncoder().encode(fileId + '|' + AAD_VERSION);
}

/** RP name for navigator.credentials.create() display. */
const PASSKEY_RP_NAME = 'KeeWebX';

/**
 * Length of the WebAuthn user handle (`user.id`) we generate per file.
 * 16 random bytes is within the 1..64 byte spec range and matches what
 * most platform authenticators expect for non-username-based flows.
 */
const USER_HANDLE_BYTES = 16;

/**
 * Persisted credential descriptor for the unlock path. Mirrors the
 * four base64-encoded fields on FileInfoModel added in commit 3.
 */
export interface PasskeyCredentialDescriptor {
    credentialId: string;
    prfSalt: string;
    wrappedKey: string;
}

/** Result of a successful enable-at-open flow. */
export interface PasskeyEnableResult {
    credentialIdBase64: string;
    prfSaltBase64: string;
    wrappedKeyBase64: string;
    createdDate: Date;
}

/**
 * Register a fresh passkey for a given KDBX file and wrap its master
 * password string under a PRF-derived AES-256 key. The returned base64
 * strings are the four values the caller must persist on FileInfoModel
 * (`passkeyCredentialId`, `passkeyPrfSalt`, `passkeyWrappedKey`,
 * `passkeyCreatedDate`).
 *
 * Throws on:
 *   - browser / authenticator cancels (`NotAllowedError`)
 *   - missing PRF support (`registerPasskey` throws)
 *   - authenticator registered the credential but refused PRF at both
 *     create and get time (surfaces as an explicit error string)
 *
 * @param fileId - KDBX file id, used as HKDF salt for domain separation.
 * @param fileName - Human-visible passkey user name for the prompt UI.
 * @param masterPasswordText - Plaintext password as the user typed it.
 */
export async function enablePasskeyForFile(
    fileId: string,
    fileName: string,
    masterPasswordText: string
): Promise<PasskeyEnableResult> {
    const userId = randomBytes(USER_HANDLE_BYTES);
    const registration = await registerPasskey({
        rpName: PASSKEY_RP_NAME,
        userName: fileName,
        userId
    });

    let prfOutput = registration.prfOutput;
    if (!prfOutput) {
        // Authenticator skipped create-time PRF evaluation. Per spec
        // this is legal (e.g. older YubiKey firmware) — do a second
        // get() with the same salt to materialize the bytes before we
        // try to wrap anything.
        prfOutput = await evaluatePrf({
            credentialId: registration.credentialId,
            prfSalt: registration.prfSalt
        });
    }

    try {
        const wrapKeyBytes = await deriveWrapKey(prfOutput, fileId);
        try {
            const passwordBytes = stringToUtf8Bytes(masterPasswordText);
            try {
                const aad = buildAad(fileId);
                const wrapped = await wrapKey(passwordBytes, wrapKeyBytes, aad);
                return {
                    credentialIdBase64: bytesToBase64(registration.credentialId),
                    prfSaltBase64: bytesToBase64(registration.prfSalt),
                    wrappedKeyBase64: bytesToBase64(wrapped),
                    createdDate: new Date()
                };
            } finally {
                zeroBytes(passwordBytes);
            }
        } finally {
            zeroBytes(wrapKeyBytes);
        }
    } finally {
        zeroBytes(prfOutput);
    }
}

/**
 * Inverse of `enablePasskeyForFile`. Runs a passkey get() ceremony
 * against the stored credentialId, derives the wrap key, and returns
 * the master password as a `kdbxweb.ProtectedValue` ready to hand to
 * the normal password-based open flow.
 *
 * The intermediate plaintext bytes are zero'd immediately after being
 * copied into `ProtectedValue.fromString`. This matches the lifetime
 * guarantee the rest of the codebase relies on for typed passwords.
 *
 * @param fileId - KDBX file id used as HKDF salt; MUST match the value
 *                 used when the passkey was enabled, or unwrap fails.
 * @param descriptor - base64 credentialId / prfSalt / wrappedKey from
 *                 FileInfoModel.
 */
export interface PasskeyUnlockResult {
    password: kdbxweb.ProtectedValue;
    migratedWrappedKey?: string;
}

export async function unlockFileWithPasskey(
    fileId: string,
    descriptor: PasskeyCredentialDescriptor
): Promise<PasskeyUnlockResult> {
    const credentialIdBytes = base64ToBytes(descriptor.credentialId);
    const prfSaltBytes = base64ToBytes(descriptor.prfSalt);
    const wrappedBytes = base64ToBytes(descriptor.wrappedKey);

    const prfOutput = await evaluatePrf({
        credentialId: credentialIdBytes,
        prfSalt: prfSaltBytes
    });

    try {
        const wrapKeyBytes = await deriveWrapKey(prfOutput, fileId);
        try {
            const aad = buildAad(fileId);
            let plaintextBytes: Uint8Array;
            let migrated = false;
            try {
                plaintextBytes = await unwrapKey(wrappedBytes, wrapKeyBytes, aad);
            } catch {
                // Legacy blob without AAD — retry without it and flag for migration
                plaintextBytes = await unwrapKey(wrappedBytes, wrapKeyBytes);
                migrated = true;
            }
            try {
                const text = utf8BytesToString(plaintextBytes);
                const password = kdbxweb.ProtectedValue.fromString(text);
                let migratedWrappedKey: string | undefined;
                if (migrated) {
                    const rewrapped = await wrapKey(plaintextBytes, wrapKeyBytes, aad);
                    migratedWrappedKey = bytesToBase64(rewrapped);
                }
                return { password, migratedWrappedKey };
            } finally {
                zeroBytes(plaintextBytes);
            }
        } finally {
            zeroBytes(wrapKeyBytes);
        }
    } finally {
        zeroBytes(prfOutput);
    }
}

/**
 * HKDF-SHA256(prfOutput, salt=UTF8(fileId), info=UTF8(HKDF_INFO_V1))
 * producing 32 bytes of AES-256 key material.
 *
 * The PRF output is already uniformly random, so strictly speaking we
 * could use it as the AES key directly. We still HKDF it because:
 *
 *   1. Domain separation per file — wrapping file A's password with
 *      file B's key would be impossible even if both files used the
 *      same passkey credential, because the HKDF salt differs.
 *   2. Versioning — HKDF_INFO_V1 is a future migration knob.
 *   3. Input stability — HKDF normalizes any byte length we ever
 *      decide to pass in (e.g. if we later feed it more than 32 B).
 */
async function deriveWrapKey(
    prfOutput: Uint8Array,
    fileId: string
): Promise<Uint8Array> {
    const salt = stringToUtf8Bytes(fileId);
    const info = stringToUtf8Bytes(HKDF_INFO_V1);
    const baseKey = await crypto.subtle.importKey(
        'raw',
        prfOutput as unknown as ArrayBuffer,
        { name: 'HKDF' },
        false,
        ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: salt as unknown as ArrayBuffer,
            info: info as unknown as ArrayBuffer
        },
        baseKey,
        256 // 32-byte AES-256 key
    );
    return new Uint8Array(bits);
}

// ---------------------------------------------------------------------
// Small internal helpers — kept local so the public surface of this
// module stays limited to `enablePasskeyForFile` + `unlockFileWithPasskey`
// + the `deriveWrapKey`-adjacent test exports below.
// ---------------------------------------------------------------------

function randomBytes(n: number): Uint8Array {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
}

function stringToUtf8Bytes(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

function utf8BytesToString(b: Uint8Array): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
}

function zeroBytes(b: Uint8Array): void {
    for (let i = 0; i < b.byteLength; i++) {
        b[i] = 0;
    }
}

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

// ---------------------------------------------------------------------
// Test-only exports. NOT exported from the module's natural public
// surface — `__testing__` is a convention we use elsewhere in the repo
// for "this is internals, but a unit test needs to poke it". The
// production callers should use `enablePasskeyForFile` /
// `unlockFileWithPasskey` and never reach for these.
// ---------------------------------------------------------------------

export const __testing__ = {
    deriveWrapKey,
    HKDF_INFO_V1,
    bytesToBase64,
    base64ToBytes
};
