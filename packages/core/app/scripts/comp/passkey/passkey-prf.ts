/**
 * WebAuthn PRF (Pseudo-Random Function) extension plumbing for the
 * Passkey Quick Unlock feature (#9, Phase 2 groundwork).
 *
 * This module is intentionally:
 *  - UI-less (no DOM beyond `navigator.credentials` + `crypto`)
 *  - Storage-less (caller decides where to persist credentialId +
 *    prfSalt — KeePass custom data, IndexedDB, whatever TL picks)
 *  - Model-less (no imports from `views/` or `models/`)
 *
 * It is the pure crypto/WebAuthn layer. The design ambiguity around
 * "where does the prfSalt live" and "who triggers registration" is
 * left to TL; this file only exposes the primitives:
 *
 *   - `isPasskeyPrfSupported()` — cheap best-effort feature check
 *   - `registerPasskey()`       — create() with PRF eval=create hint
 *   - `evaluatePrf()`           — get() with PRF eval=get, returns 32 B
 *   - `wrapKey()` / `unwrapKey()` — AES-256-GCM wrap of a key by PRF output
 *
 * WebAuthn PRF spec:
 *   https://www.w3.org/TR/webauthn-3/#prf-extension
 *
 * Notes
 * -----
 * 1. The PRF extension returns 32 bytes of HKDF-SHA256 output from an
 *    authenticator-held secret, deterministically keyed by a caller-
 *    supplied salt. That 32-byte output is exactly the size of an
 *    AES-256 key, so we use it directly as the key for wrap/unwrap.
 *
 * 2. Not all authenticators support PRF evaluation *at registration
 *    time* — some only support eval-at-get. When the create-time
 *    evaluation is absent, `registerPasskey` returns `prfOutput: null`
 *    and the caller must call `evaluatePrf` once with the same salt
 *    to materialize the key before it can wrap anything.
 *
 * 3. The `challenge` bytes passed to `navigator.credentials.create/get`
 *    are local-only — there is NO server to verify assertions because
 *    the whole point is local database unlock. We still generate 32
 *    random bytes per call so replay logs stay distinct and the API
 *    shape matches a real server flow byte-for-byte.
 *
 * 4. `userVerification: 'required'` forces the authenticator to prompt
 *    the user (PIN, biometric, touch), which is the security boundary
 *    for "is this the right human". For a password manager unlock
 *    this is non-negotiable.
 *
 * 5. `residentKey: 'preferred'` asks the authenticator to store a
 *    discoverable credential when possible (nicer UX — user does not
 *    need to type a username on unlock). Platform authenticators
 *    always honor this; security keys may degrade to non-resident.
 */

// WebCrypto AES-GCM: 12-byte IV, 16-byte tag (appended by SubtleCrypto).
const AES_GCM_IV_BYTES = 12;

/** PRF output length (bytes). WebAuthn PRF always returns 32. */
const PRF_OUTPUT_BYTES = 32;

/** AES-256 key length in bytes; matches PRF output by design. */
const AES_256_KEY_BYTES = 32;

/**
 * User-actionable message used by both `registerPasskey` and
 * `evaluatePrf` when the authenticator (or an intercepting browser
 * password-manager extension) silently refuses the WebAuthn PRF
 * extension. Surfaced verbatim by the open view via the locale key
 * `openPasskeyPrfUnsupported` so that the toast and the thrown
 * error.message stay in sync for log triage.
 *
 * Mentions both Chrome/Edge platform options and the Firefox
 * extension-interception failure mode in one string — we deliberately
 * do NOT browser-sniff and emit different copy. The check is the
 * same in both browsers; the message is the same in both browsers.
 */
const PRF_UNSUPPORTED_MESSAGE =
    "This authenticator did not enable the WebAuthn PRF extension needed for passkey unlock.\n\n" +
    "On macOS, third-party credential providers (Strongbox, 1Password, Bitwarden, etc.) can intercept " +
    "passkey creation and silently drop PRF support. Go to System Settings → Passwords → Password Options " +
    "and disable all providers except iCloud Keychain, then try again.\n\n" +
    "On Firefox, third-party password-manager browser extensions can also intercept — disable them " +
    "or use the built-in browser passkey flow.\n\n" +
    "Alternatively, use a YubiKey with firmware 5.2.3 or newer (PRF via hardware key works on any OS).";

/**
 * Marker error thrown when the authenticator either refuses to enable
 * PRF at create() time or returns no PRF result at get() time.
 *
 * Distinct from a generic `Error` so callers (open-view, app-model)
 * can branch on `e.name === 'PasskeyPrfNotSupportedError'` and either
 * (a) auto-clear a now-useless persisted credential, or
 * (b) show a specific, actionable toast instead of the generic
 *     "Passkey registration failed" string.
 *
 * Distinct from `NotAllowedError` / `AbortError` (user cancel), which
 * are reported by the browser itself, NOT by us.
 */
export class PasskeyPrfNotSupportedError extends Error {
    constructor(message: string = PRF_UNSUPPORTED_MESSAGE) {
        super(message);
        this.name = 'PasskeyPrfNotSupportedError';
    }
}

/**
 * Best-effort check for WebAuthn PRF support in the current context.
 *
 * This can only return `true` probabilistically: the real PRF support
 * bit is only visible in the `getClientExtensionResults().prf.enabled`
 * field AFTER a credential has been created. We cannot verify it here
 * without consuming a user gesture. Callers should treat a `true`
 * result as "worth offering passkey unlock in the UI" and fall back
 * gracefully if `registerPasskey` later returns no PRF output.
 *
 * Returns false outside the browser or when WebAuthn is unavailable.
 */
export function isPasskeyPrfSupported(): boolean {
    if (typeof window === 'undefined') return false;
    if (typeof navigator === 'undefined') return false;
    if (!('credentials' in navigator)) return false;
    if (typeof PublicKeyCredential === 'undefined') return false;
    // `crypto.subtle` is the AES-GCM wrap/unwrap dependency; without
    // it the whole module is useless even if WebAuthn PRF works.
    if (typeof crypto === 'undefined' || !crypto.subtle) return false;
    return true;
}

/** Arguments for `registerPasskey`. */
export interface RegisterPasskeyOptions {
    /** Human-visible name of the relying party (e.g. 'KeeWebX'). */
    rpName: string;
    /**
     * RP ID — the effective domain the credential is scoped to.
     * Defaults to `location.hostname`. Override only when you know
     * what you are doing (subdomain rollout, testing, etc.).
     */
    rpId?: string;
    /** Display name for the user handle (e.g. file name). */
    userName: string;
    /**
     * Opaque user handle. Caller MUST generate 16 random bytes via
     * `crypto.getRandomValues` and persist them alongside the file.
     * Reusing the same handle re-associates future credentials with
     * the same user record on the authenticator.
     */
    userId: Uint8Array;
}

/** Result of a successful `registerPasskey` call. */
export interface RegisterPasskeyResult {
    /** Opaque credential identifier. Persist as-is for future get() calls. */
    credentialId: Uint8Array;
    /**
     * 32 random bytes the caller MUST persist. The PRF output is a
     * deterministic function of this salt + authenticator secret; if
     * you lose the salt, the wrapped file key can no longer be
     * unwrapped — equivalent to losing the passkey.
     */
    prfSalt: Uint8Array;
    /**
     * 32-byte PRF output if the authenticator evaluated PRF at
     * registration time; `null` if the authenticator enabled PRF
     * (the strict check passed) but did not honor eval-at-create.
     * In that case the caller must call `evaluatePrf` once with the
     * same salt to materialize the bytes before wrapping anything.
     *
     * NOTE: as of #9 round 5 we throw `PasskeyPrfNotSupportedError`
     * when `prf.enabled !== true`, so `null` here only signals the
     * narrow eval-at-get-only case — never "PRF was refused".
     */
    prfOutput: Uint8Array | null;
}

/** Arguments for `evaluatePrf`. */
export interface EvaluatePrfOptions {
    /** Previously-returned credentialId from `registerPasskey`. */
    credentialId: Uint8Array;
    /**
     * The 32-byte salt the caller persisted at registration. MUST be
     * the same bytes — PRF is deterministic in the salt, so any
     * mismatch produces a different output and unwrap will fail with
     * an AES-GCM tag error.
     */
    prfSalt: Uint8Array;
    /** Optional RP ID override. Defaults to `location.hostname`. */
    rpId?: string;
}

/**
 * Register a new passkey for local database unlock, and attempt to
 * evaluate the PRF extension at create time.
 *
 * Throws on user cancel, WebAuthn failure, or missing PRF support.
 * Callers should catch and fall back to password-only unlock.
 */
export async function registerPasskey(
    opts: RegisterPasskeyOptions
): Promise<RegisterPasskeyResult> {
    if (!isPasskeyPrfSupported()) {
        throw new Error('WebAuthn PRF is not supported in this environment');
    }

    const rpId = opts.rpId ?? location.hostname;
    const challenge = randomBytes(32);
    const prfSalt = randomBytes(PRF_OUTPUT_BYTES);

    const publicKey: PublicKeyCredentialCreationOptions = {
        // Cast at the bottom literal — `hints` is WebAuthn L3 and
        // not present in the older lib.dom shape this project uses.
        rp: { name: opts.rpName, id: rpId },
        user: {
            id: toBufferSource(opts.userId),
            name: opts.userName,
            displayName: opts.userName
        },
        challenge: toBufferSource(challenge),
        pubKeyCredParams: [
            { type: 'public-key', alg: -7 }, // ES256
            { type: 'public-key', alg: -257 } // RS256
        ],
        authenticatorSelection: {
            // No authenticatorAttachment constraint — allows both
            // platform (iCloud Keychain, Windows Hello) and cross-
            // platform (YubiKey) authenticators. Needed because:
            //   1. YubiKey 5.2.3+ supports PRF and is the only
            //      option on Linux and in Chrome PWA on macOS
            //   2. 'platform' silently filters out YubiKey from
            //      the browser's authenticator picker
            // The hints: ['client-device'] below still biases the
            // UI toward platform authenticators where available.
            residentKey: 'required',
            userVerification: 'required'
        },
        timeout: 60_000,
        attestation: 'none',
        extensions: {
            // WebAuthn PRF extension — request PRF capability check at
            // create time WITHOUT eval. Some authenticators (notably
            // Apple iCloud Keychain on macOS 15+) reject the entire PRF
            // extension when eval is present at create time. By passing
            // just `prf: {}` we ask "do you support PRF?" and get back
            // `prf.enabled: true/false`. The actual PRF eval happens in
            // a follow-up get() call via evaluatePrf().
            prf: {}
        } as unknown as AuthenticationExtensionsClientInputs,
        // WebAuthn L3 `hints` array — biases the browser UI toward
        // the client-device's own platform authenticator over any
        // hooked browser extension or roaming security key. Widely
        // honored as of Chrome 122 / Firefox 122 / Edge 122. Older
        // TS DOM lib doesn't know this field yet — see the
        // post-construction cast assignment below.
    };
    // Attach `hints` after the literal so we don't have to satisfy
    // the older lib.dom `PublicKeyCredentialCreationOptions` shape
    // for an L3 field. WebAuthn L3 spec:
    //   https://www.w3.org/TR/webauthn-3/#dom-publickeycredentialcreationoptions-hints
    (publicKey as unknown as { hints: string[] }).hints = ['client-device'];

    const credential = (await navigator.credentials.create({
        publicKey
    })) as PublicKeyCredential | null;

    if (!credential) {
        throw new Error('navigator.credentials.create returned null');
    }

    const credentialId = new Uint8Array(credential.rawId);
    const clientExtensions = credential.getClientExtensionResults() as {
        prf?: {
            enabled?: boolean;
            results?: { first?: ArrayBuffer };
        };
    };

    // Strict PRF-enabled check. Per WebAuthn spec, when we pass
    // `extensions.prf.eval` to create(), the authenticator can:
    //
    //   (a) Accept PRF: `prf.enabled === true`, optionally with
    //       `prf.results.first` if it supports eval-at-create.
    //   (b) Refuse PRF: `prf.enabled === false`, OR the `prf` field
    //       is omitted entirely. The credential is signed and stored
    //       on the authenticator but is *useless* for our wrap/unwrap
    //       flow forever — no future get() call can recover PRF on a
    //       credential that wasn't enabled at create() time.
    //
    // Before this strict check we silently fell through case (b) and
    // tried to rescue with `evaluatePrf()` at the call site, which
    // would also fail with the cryptic "did not return a PRF result"
    // error AND leave a garbage credential persisted on FileInfo.
    // We now throw fast, with an actionable message, BEFORE the
    // caller has a chance to write anything to FileInfoModel.
    if (clientExtensions.prf?.enabled !== true) {
        const prfDump = JSON.stringify(clientExtensions.prf ?? null);
        const allExt = JSON.stringify(clientExtensions);
        const attachment = credential.authenticatorAttachment ?? 'unknown';
        throw new PasskeyPrfNotSupportedError(
            `${PRF_UNSUPPORTED_MESSAGE}\n\n` +
            `authenticator: ${attachment}\n` +
            `prf field: ${prfDump}\n` +
            `all extensions: ${allExt}`
        );
    }

    // prfOutput is always null from create — we no longer pass eval at
    // create time. The caller (enablePasskeyForFile) will do a follow-up
    // evaluatePrf() get() call to materialize the 32-byte PRF output.
    return { credentialId, prfSalt, prfOutput: null };
}

/**
 * Evaluate the PRF extension against a previously-registered passkey
 * to produce 32 deterministic bytes suitable for AES-256 unwrap.
 *
 * Throws on user cancel, missing credential, or PRF eval failure.
 * The 32-byte return value should be treated as key material: zero
 * it out of memory as soon as the derived operations are done.
 */
export async function evaluatePrf(opts: EvaluatePrfOptions): Promise<Uint8Array> {
    if (!isPasskeyPrfSupported()) {
        throw new Error('WebAuthn PRF is not supported in this environment');
    }

    const rpId = opts.rpId ?? location.hostname;
    const challenge = randomBytes(32);

    const publicKey: PublicKeyCredentialRequestOptions = {
        challenge: toBufferSource(challenge),
        rpId,
        allowCredentials: [
            {
                type: 'public-key',
                id: toBufferSource(opts.credentialId),
                transports: ['internal', 'usb', 'nfc', 'ble', 'hybrid']
            }
        ],
        userVerification: 'required',
        timeout: 60_000,
        extensions: {
            prf: {
                eval: {
                    first: toBufferSource(opts.prfSalt)
                }
            }
        } as unknown as AuthenticationExtensionsClientInputs
    };

    const assertion = (await navigator.credentials.get({
        publicKey
    })) as PublicKeyCredential | null;

    if (!assertion) {
        throw new Error('navigator.credentials.get returned null');
    }

    const clientExtensions = assertion.getClientExtensionResults() as {
        prf?: { results?: { first?: ArrayBuffer } };
    };
    const firstResult = clientExtensions.prf?.results?.first;
    if (!firstResult) {
        // Same disease as the create-time refusal in registerPasskey:
        // the authenticator either was never PRF-capable for this
        // credential, OR a browser password-manager extension hooked
        // the get() call and returned an assertion without PRF data.
        // Either way the stored wrappedKey can never be unwrapped on
        // this authenticator — caller (passkey-unlock.ts) handles the
        // auto-clear-and-tell-user-to-re-enroll path.
        throw new PasskeyPrfNotSupportedError();
    }
    if (firstResult.byteLength !== PRF_OUTPUT_BYTES) {
        throw new Error(
            `PRF output length ${firstResult.byteLength} != expected ${PRF_OUTPUT_BYTES}`
        );
    }
    return new Uint8Array(firstResult);
}

/**
 * Wrap (encrypt) an arbitrary-length key with AES-256-GCM keyed by
 * the 32-byte PRF output. The returned buffer is:
 *
 *     [ iv (12) | ciphertext | tag (16) ]
 *
 * The IV is fresh-random per call; the tag is appended by
 * SubtleCrypto automatically. The return value is safe to store at
 * rest — an attacker cannot unwrap without a fresh PRF evaluation,
 * which requires user verification on the original authenticator.
 */
export async function wrapKey(
    keyBytes: Uint8Array,
    prfOutput: Uint8Array,
    aad?: Uint8Array
): Promise<Uint8Array> {
    assertPrfOutputLength(prfOutput);

    const iv = randomBytes(AES_GCM_IV_BYTES);
    const aesKey = await importAesGcmKey(prfOutput);
    const params: AesGcmParams = { name: 'AES-GCM', iv: toBufferSource(iv) };
    if (aad) {
        params.additionalData = toBufferSource(aad);
    }
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(params, aesKey, toBufferSource(keyBytes))
    );
    const out = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    out.set(iv, 0);
    out.set(ciphertext, iv.byteLength);
    return out;
}

/**
 * Inverse of `wrapKey`. Throws on tag mismatch (wrong key, tampered
 * ciphertext, or wrong PRF salt at caller).
 */
export async function unwrapKey(
    wrapped: Uint8Array,
    prfOutput: Uint8Array,
    aad?: Uint8Array
): Promise<Uint8Array> {
    assertPrfOutputLength(prfOutput);

    if (wrapped.byteLength < AES_GCM_IV_BYTES + 16) {
        throw new Error(
            `unwrapKey: input too short (${wrapped.byteLength} bytes) to contain iv + ciphertext + tag`
        );
    }

    const iv = wrapped.subarray(0, AES_GCM_IV_BYTES);
    const body = wrapped.subarray(AES_GCM_IV_BYTES);
    const aesKey = await importAesGcmKey(prfOutput);
    const params: AesGcmParams = { name: 'AES-GCM', iv: toBufferSource(iv) };
    if (aad) {
        params.additionalData = toBufferSource(aad);
    }
    const plaintext = await crypto.subtle.decrypt(
        params,
        aesKey,
        toBufferSource(body)
    );
    return new Uint8Array(plaintext);
}

// ---------------------------------------------------------------------
// Internal helpers — not exported. Keeping them private makes the
// public surface minimal for the TL design review.
// ---------------------------------------------------------------------

/**
 * Generate `n` random bytes via `crypto.getRandomValues`. Thin
 * wrapper so the call sites read as intent instead of ceremony.
 */
function randomBytes(n: number): Uint8Array {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
}

/**
 * WebCrypto AES-GCM import. The PRF output is already a uniformly-
 * random 32-byte string, so we can feed it directly as raw key
 * material with no KDF step.
 */
function importAesGcmKey(prfOutput: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'raw',
        toBufferSource(prfOutput),
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Guard against callers accidentally passing a short/long PRF output.
 * The module-wide invariant is "PRF output == 32 bytes == AES-256 key".
 */
function assertPrfOutputLength(prfOutput: Uint8Array): void {
    if (prfOutput.byteLength !== AES_256_KEY_BYTES) {
        throw new Error(
            `passkey-prf: PRF output must be ${AES_256_KEY_BYTES} bytes, got ${prfOutput.byteLength}`
        );
    }
}

/**
 * Convert a Uint8Array to a concrete ArrayBuffer that WebAuthn /
 * WebCrypto typings accept. Uint8Array's backing buffer may be a
 * SharedArrayBuffer or a view-window over a larger allocation, which
 * some TS DOM lib versions reject on `BufferSource` parameters.
 * Copying into a fresh ArrayBuffer is cheap for key-sized inputs and
 * keeps the type narrowing honest.
 */
function toBufferSource(b: Uint8Array): ArrayBuffer {
    const out = new ArrayBuffer(b.byteLength);
    new Uint8Array(out).set(b);
    return out;
}
