# Phase 2 Passkey Unlock — Design

**Status:** Design, not code. No implementation yet.
**Tracking issue:** [#9](https://github.com/gynet/keewebx/issues/9)
**Depends on:** Nothing. Phase 2 is foundational.
**Unblocks:** [#25](https://github.com/gynet/keewebx/issues/25) per-field hardware encryption, [#39](https://github.com/gynet/keewebx/issues/39) Quick Autofill.
**Author:** Architect agent, 2026-04-09.

---

## 1. Executive summary

Phase 2 Passkey Unlock lets a user open a KeeWebX vault by tapping a passkey (Face ID, Touch ID, Windows Hello, or a YubiKey) instead of typing the KDBX master password. A WebAuthn credential is registered once per vault with the PRF extension enabled; on unlock the browser evaluates PRF against that credential to produce a deterministic 32-byte secret, which is run through HKDF to derive a wrapping key, which unwraps a stored ciphertext blob to recover the real KDBX master password. The KDBX file on disk is **unchanged** — the passkey layer is a convenience wrapper around the existing `kdbxweb.Credentials(ProtectedValue)` open path, so the vault remains interoperable with KeePassXC and other KDBX4 clients. Master password remains the recovery path; there is no "passkey-only" vault in Phase 2. The PRF wrapper is the same WebAuthn credential that Phase 3 (#25) and Phase 3+ (#39) will reuse with different salts for per-field and per-URL key derivation.

---

## 2. Goals and non-goals

### Goals

- G1. Replace the master password entry step with a single passkey tap on supported browsers and authenticators.
- G2. Support both platform authenticators (Face ID, Touch ID, Windows Hello, Android biometrics) and roaming authenticators (YubiKey 5 / Bio series, Titan).
- G3. Leave the KDBX4 file on disk **byte-identical** to what a non-passkey client would produce — full interop with KeePassXC, keepass-rs, upstream KeeWeb.
- G4. Build the WebAuthn PRF primitive that #25 and #39 will reuse in Phase 3+. One credential, multiple salt namespaces.
- G5. Preserve master password as a fallback so losing the passkey never means losing the vault.
- G6. Work with pure web platform — no server, no native wrapper, no Electron. Static hosting (current gh-pages target) remains sufficient.

### Non-goals (explicit)

- N1. **Per-field encryption** — that is Phase 3 (#25), uses the same PRF credential with a different salt, but is a separate feature shipped later.
- N2. **Quick autofill per-URL cache** — that is Phase 3+ (#39).
- N3. **Passkey-authenticator-mode for the browser extension** (the "Feature B" in #9 — storing website passkeys inside a KDBX entry and intercepting `navigator.credentials.get()` on target sites). This document covers **Feature A** only (quick unlock). Feature B is independently shippable and should be split into a separate sub-issue under #9.
- N4. **iOS native credential provider** — non-goal per #38.
- N5. **Replacing the master password entirely** — a passkey-only vault with no master password has no safe recovery story for us in 2026 and conflicts with KDBX interop.
- N6. **Multi-user / multi-account unlock** — one user's set of passkeys unlocks one vault. Multi-user sharing is out of scope.
- N7. **Biometric-only confirmation without PRF** — vanilla WebAuthn `userVerification: required` only proves user presence, it produces no key material. We must use PRF; if the authenticator doesn't support PRF we refuse registration and tell the user why.

---

## 3. Threat model

### What this defends against (compared to current master-password-only)

| Attack | Master password only | + Passkey unlock (this design) |
|---|---|---|
| Shoulder surfing master password | vulnerable | neutralized (no typing) |
| Keystroke logger on client | vulnerable | neutralized for unlock (password never typed after setup) |
| Password reuse / weak master password | vulnerable | neutralized (random 32-byte key can be used as master; see §5) |
| KDBX file exfiltrated from cloud sync + offline brute force | Argon2id cost only | Argon2id + 32-byte random master key (if Option B chosen) |
| Phishing site impersonating KeeWebX to harvest master password | vulnerable | neutralized (WebAuthn RP ID binding) |

### What this does NOT defend against (honest)

- **Device theft + biometric bypass.** If an attacker has your unlocked phone, they can unlock the vault with the same tap you would. The passkey does not add anti-coercion; it is a usability primitive.
- **Malware on the client with the vault unlocked in memory.** Post-unlock the vault is plaintext in `EntryModel` just like today. Phase 3 (#25) is what addresses the in-memory threat for genuinely sensitive fields, not Phase 2.
- **Attacker with the unlocked vault in a browser tab.** Same as today — if the attacker sits down at your unlocked laptop, game over.
- **An attacker who can read both the KDBX file and the wrapped-master-key blob from localStorage AND has the authenticator.** That is effectively the same person as the vault owner, and WebAuthn is the gate.
- **Attacker with a full RAM dump of the browser during unlock.** PRF output will be in JS heap briefly. We cannot mitigate this in pure JS.
- **Quantum attacker with capture-now-decrypt-later.** KDBX4 + ChaCha20 + Argon2id + WebAuthn (ECDSA) are all pre-quantum. Phase 2 does not change this; it is a whole-industry problem.
- **Authenticator manufacturer compromise.** A backdoored YubiKey or a compromised iCloud Keychain can make PRF output predictable, breaking the wrap. We are trusting FIDO alliance certification the same way Bitwarden and 1Password do.
- **Salt tampering at rest.** If the attacker can modify `passkeyPrfSalt` in localStorage, PRF output changes, the unwrap will fail — but that is a DoS, not a confidentiality break. We bind the salt into an HKDF `info` string so tampering is detectable.

### Summary

Passkey unlock is strictly **≥** master-password-only on every axis, and strictly **>** on UX, phishing resistance, and offline brute-force resistance against a weak master password. It does not change the post-unlock attack surface. That is Phase 3's job.

---

## 4. WebAuthn PRF primer

### What PRF is and why we need it

Vanilla WebAuthn (`navigator.credentials.get()`) only proves "the user possesses credential X and passed user verification." It returns an attestation / assertion — a yes/no answer. For a password manager we need **deterministic key material** that is:

- Bound to a specific authenticator (so a different authenticator can't unlock the vault).
- Bound to a specific RP ID (so a phishing site can't get the same output).
- Reproducible across sessions (so we can deterministically unwrap a stored key).
- Not derivable by the browser or JS — must come from the authenticator's own key material.

That is exactly what the PRF extension provides. Under the hood, PRF wraps CTAP2's `hmac-secret` extension: the authenticator holds a credential-specific HMAC key, the browser passes in a salt, and the authenticator returns `HMAC-SHA256(credential_key, salt_transform(input))`. The output is a 32-byte deterministic pseudorandom value that only that authenticator, holding that credential, can produce.

### Browser-side input transform

Per the spec, the browser does **not** pass the raw `eval.first` bytes to the authenticator. It computes:

```
effective_input = SHA-256( "WebAuthn PRF" || 0x00 || eval.first )
```

and sends that as the CTAP2 `hmac-secret` salt. This context-string prefix is what partitions web PRF outputs from any other hmac-secret caller on the same authenticator — critical for us because it means we don't have to worry about an OS-level tool that also uses hmac-secret colliding with our key derivation. For our design, treat the browser transform as opaque: we decide the `eval.first` bytes, the browser hashes, the authenticator does HMAC, we get 32 bytes back.

### First / second eval slots

```js
extensions: {
  prf: {
    evalByCredential: {
      [credIdBase64]: {
        first:  saltA,   // always present
        second: saltB    // optional, second HMAC eval in the same ceremony
      }
    }
  }
}
```

A single WebAuthn ceremony can evaluate PRF twice with two different salts. This matters in two cases:

1. **Phase 3 (#25) batch decrypt.** Unlocking an entry's password AND its OTP seed in one tap uses `first=entryUuid||"Password"` and `second=entryUuid||"otp"`, decrypting both in a single biometric prompt.
2. **Phase 2 seamless salt rotation.** We can rotate the master-key wrapping salt without re-registering the credential, by using both slots during a transition window.

Phase 2 Unlock itself only needs `first`. `second` is reserved for Phase 3.

### PRF at registration vs assertion

PRF at `navigator.credentials.create()` time is a **capability probe**: the browser returns `{prf: {enabled: true|false}}` telling you whether the authenticator supports PRF, but it does **not** give you any PRF output during registration. To derive a key, you must do a follow-up `navigator.credentials.get()` immediately after create, passing `evalByCredential` with the freshly-created credential ID. As of 2026, Chrome on Windows (147+) supports PRF-on-create which returns output in the create response itself, but this is not portable. **Our design assumes create returns only `enabled`, and a separate get() is required** — matches all browsers.

### Browser support matrix (as of April 2026)

| Platform | Browser | Authenticator | PRF status |
|---|---|---|---|
| macOS 15+ | Safari 18+ | iCloud Keychain | Works |
| macOS 15+ | Chrome 132+ | iCloud Keychain | Works |
| macOS 15+ | Firefox 139+ | iCloud Keychain | Works |
| Windows 11 25H2+ | Chrome 147+ | Windows Hello | Works |
| Windows 11 25H2+ | Firefox 148+ | Windows Hello | Works |
| Windows 11 25H2+ | Edge (Chromium) | Windows Hello | Works (follows Chrome) |
| Android 14+ | Chrome | Google Password Manager | Works (most mature) |
| Android 14+ | Firefox | Google Password Manager | **No PRF** |
| iOS 18+ | Safari | iCloud Keychain | Works (iOS 18.4+; 18.0–18.3 has a cross-device bug) |
| iOS 18+ | Chrome (WKWebView) | iCloud Keychain | Works |
| any desktop | any browser | YubiKey 5 / Bio (FIDO2) | Works on Chrome/Firefox/Edge |
| Safari desktop | Safari 18+ | YubiKey 5 / Bio (FIDO2) | **BROKEN**: Safari returns the raw AES-256-CBC hmac-secret blob instead of decrypting it. Unusable. Track webkit bug. |

**Implications for Phase 2:**

- We must feature-detect PRF and gate the "Enable passkey unlock" UI accordingly.
- Safari-on-desktop + YubiKey is a blacklist: if we detect Safari and the user attempts to register a cross-platform (roaming) authenticator, we refuse with a clear error message pointing at the webkit bug.
- Firefox on Android is a blacklist for platform-authenticator passkeys.
- Everything else is supported.

### Authenticator support

| Class | Example | PRF support |
|---|---|---|
| Platform (Apple) | Touch ID, Face ID via iCloud Keychain | Yes (macOS 15 / iOS 18+) |
| Platform (Microsoft) | Windows Hello | Yes (Windows 11 25H2+) |
| Platform (Google) | Android Credential Manager | Yes (Android 14+) |
| Platform (ChromeOS) | Fingerprint | Yes (follows Chrome) |
| Roaming (Yubico) | YubiKey 5, YubiKey Bio, Security Key NFC | Yes, on Chromium/Gecko. Broken on WebKit. |
| Roaming (Google) | Titan Security Key | Yes (hmac-secret supported) |
| Roaming (SoloKeys, Nitrokey) | Solo 2, Nitrokey 3 | Yes (hmac-secret supported) |

---

## 5. Key derivation design

### Primitives used (all already in deps)

- WebCrypto `SubtleCrypto` — HKDF, SHA-256, AES-GCM.
- tweetnacl — already in `packages/extension`; available if we decide on ChaCha20-Poly1305.
- argon2-browser — not strictly needed here (PRF is the source of entropy), but noted for completeness.

We **do not introduce new crypto libraries**. No new dependencies.

### Core derivation

```
prf_output          = WebAuthn.PRF.eval(credential, salt = FILE_UUID || "keewebx-unlock-v1")   // 32 bytes
master_wrapping_key = HKDF-SHA-256(
                         ikm   = prf_output,
                         salt  = file.passkeyKdfSalt (16 random bytes, stored per file),
                         info  = "keewebx-master-unlock-v1",
                         L     = 32
                      )
```

- `FILE_UUID` is the same `id` field KeeWebX already uses on `FileInfoModel`.
- The `"keewebx-unlock-v1"` string is the Phase 2 salt namespace. Phase 3 uses a different string (see §12).
- The HKDF extract salt `passkeyKdfSalt` is **not** the PRF eval input — it is a secondary 16-byte random salt stored alongside the wrapped blob. Its purpose is to rotate derivation without re-registering the credential (just pick a new salt and re-wrap).

### Two paths to evaluate

#### Option A — PRF wraps the existing master password (the Bitwarden model)

```
ciphertext = AES-GCM(master_wrapping_key, nonce, plaintext = master_password_bytes)
stored:     { nonce, ciphertext, passkeyCredentialId, passkeyPrfSalt, passkeyKdfSalt }
```

On unlock:
1. User taps passkey → PRF output → HKDF → `master_wrapping_key`.
2. Decrypt ciphertext → recover the real master password bytes.
3. Pass `ProtectedValue` to `kdbxweb.Credentials(…)` exactly as today.

**Pros**
- KDBX file is unmodified.
- Migration is trivial: an existing user keeps their master password, enables passkey, we wrap their current password. No re-encryption of the vault.
- Losing the passkey is recoverable: master password still works directly.
- Cross-client compat: KeePassXC opens the file with the same master password. Nothing on disk knows about the passkey.

**Cons**
- The master password is still a crypto-relevant secret. A weak master password (`hunter2`) is still the weakest link for offline brute force against the KDBX file itself. Passkey wrapping does not strengthen the at-rest protection of the vault; it only protects the wrapping.
- If the user has a weak master password, the vault is as brute-forceable as before.

#### Option B — PRF wraps a random 32-byte master key that *replaces* the master password

On setup:
1. Generate 32 random bytes → `new_master_key`.
2. Re-encrypt the KDBX file with `new_master_key` (user enters old master password once to authorize).
3. Wrap `new_master_key` with `master_wrapping_key` as in Option A.
4. Store only the wrapped blob; the new master key itself is never written.

On unlock:
1. Tap passkey → PRF → HKDF → `master_wrapping_key`.
2. Decrypt wrapped blob → `new_master_key`.
3. Pass directly into `kdbxweb.Credentials`.

**Pros**
- The effective vault key is now the full 256-bit entropy of the PRF output, not a human-memorizable string. Offline brute force against a stolen KDBX file is cryptographically infeasible.

**Cons**
- **Recovery is catastrophic if the passkey is lost.** There is no memorizable fallback. The user must either keep a 32-byte paper backup of the master key (bad UX, huge error surface) or register a second passkey before losing the first (only works if they do it).
- **Cross-client compat shifts.** A KeePassXC user on another machine can no longer open the vault by typing a password; they would need the raw 32-byte key exported as a key file. That is a real KDBX4 feature (key file auth), but it is a major UX regression.
- **Migration is lossy**. Existing users would be forced to abandon their current master password. Users who only occasionally sync from a mobile client that doesn't speak PRF are stuck.

### Recommendation: **Option A**

Rationale:
- Option A respects the KeeWebX architectural commitment to KDBX4 interop. A user must always be able to pick up their `.kdbx` file and open it in KeePassXC. Option B breaks that for anyone who enables passkey.
- Option A gives us 100% of the **usability** win of passkey unlock (tap instead of type) with ~0% of the migration and recovery risk.
- The "weak master password" concern is real but is **out of scope** for Phase 2. We address it the right way in Phase 3 (#25) by moving genuinely sensitive fields to PRF-derived per-field keys that are not protected by the master password at all. That is strictly better than Option B, and it keeps KDBX interop.
- Option B is not ruled out forever — it can ship later as an opt-in "advanced" mode in Phase 2.1 or Phase 4, but not as the default first experience.
- Bitwarden ships an A-equivalent model and it has stood up to real production threat models.

Phase 2 ships Option A. All later text in this document assumes Option A.

---

## 6. Credential registration flow

### User journey

```
Settings → Security → Passkey unlock
├── "Enable passkey unlock for this vault"  [button]
│
├── (user clicks)
│
├── Step 1 — Verify master password
│   ┌────────────────────────────────────┐
│   │ Enter your master password to      │
│   │ authorize passkey registration.    │
│   │ [  ••••••••  ] [Continue]          │
│   └────────────────────────────────────┘
│
├── Step 2 — Browser WebAuthn create prompt
│   (OS-native dialog: Face ID / Touch ID / YubiKey tap)
│
├── Step 3 — Immediate WebAuthn get for PRF eval
│   (same authenticator, same ceremony-style dialog)
│
├── Step 4 — Name your passkey
│   ┌────────────────────────────────────┐
│   │ Name this passkey:                 │
│   │ [  MacBook Pro Touch ID  ]         │
│   │ [Save]                             │
│   └────────────────────────────────────┘
│
└── Done. A green "Passkey enabled" badge appears. Master password
    remains as fallback.
```

### Why two WebAuthn ceremonies (create then immediate get)?

Because PRF output is not reliably returned on create across browsers (§4), we must do a follow-up get. Most authenticators present this as a single continuous user flow — Face ID asks once, Touch ID asks once. On a YubiKey the user taps twice. We document this and plan the UI to show "registering… now tap again to verify" so the second tap is not surprising.

### WebAuthn parameters

**`navigator.credentials.create()`**
```js
{
  publicKey: {
    rp: { id: location.hostname, name: "KeeWebX" },
    user: {
      id:        sha256(file.id),          // per-vault stable pseudonym, not a user account
      name:      file.name,
      displayName: file.name
    },
    challenge:   crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [ { type: "public-key", alg: -7 }, { type: "public-key", alg: -257 } ],
    authenticatorSelection: {
      userVerification:   "required",
      residentKey:        "preferred",     // discoverable credential → easier unlock UX
      authenticatorAttachment: undefined   // allow both platform and roaming
    },
    extensions: { prf: {} }                // capability probe only
  }
}
```

**`navigator.credentials.get()` (immediate PRF eval after create)**
```js
{
  publicKey: {
    rpId:     location.hostname,
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [ { type: "public-key", id: newCredentialId, transports: [...] } ],
    userVerification: "required",
    extensions: {
      prf: {
        evalByCredential: {
          [base64url(newCredentialId)]: { first: prfEvalInput }
        }
      }
    }
  }
}
```

Where:
```
prfEvalInput = SHA-256(
  "keewebx-unlock-v1" || 0x00 || file.id
)
```

We hash our own context string because the browser will hash again with `"WebAuthn PRF\0"`. The double hash is fine (the goal is domain separation, not secrecy), and it keeps the PRF eval input a fixed 32 bytes regardless of file.id length.

### Data stored per file

Extend `FileInfoProperties` in `packages/core/app/scripts/models/file-info-model.ts`:

```ts
interface FileInfoProperties {
  // ... existing fields ...
  passkeys: PasskeyEntry[] | null;  // NEW — array so multiple credentials per vault are supported
}

interface PasskeyEntry {
  credentialId:    string;   // base64url of the WebAuthn credential ID
  credentialName:  string;   // user-friendly label, e.g. "MacBook Pro Touch ID"
  transports:      string[]; // ["internal"] or ["usb", "nfc"]
  wrappedKey:      string;   // base64 of AES-GCM(wrapping_key, nonce, masterPassword)
  wrapNonce:       string;   // base64 of 12-byte nonce
  kdfSalt:         string;   // base64 of 16-byte HKDF salt
  prfEvalInput:    string;   // base64 of the input we pass as eval.first  (opaque to us on unlock)
  createdAt:       string;   // ISO8601
  lastUsedAt:      string | null;
}
```

Stored as-is in `localStorage` via the existing `SettingsStore` (the `fileInfo` key, now restored from the 2026-04-09 settings-store regression). No schema version bump needed because existing fields are untouched; missing `passkeys` field means "no passkey registered."

**Why store all of this per file, not in `AppSettingsModel`?**

A single KeeWebX installation can open multiple vaults (personal, work, shared). Each vault has its own master password and should have its own passkey registration. The natural scope is `FileInfoModel`, and that's already persisted by the same `SettingsStore` we trust today.

**Why an array instead of a single credential?**

- Backup authenticator story: users should register a second device (another platform authenticator, or a YubiKey) as recovery before losing the first. See §9.
- Multi-device: a user with a work laptop and a personal laptop needs to register each one separately if they're not using iCloud Keychain sync.

### Handling multiple registered credentials

On unlock, if the file has >1 passkey:

- If all are platform authenticators, the OS picker selects the right one automatically (discoverable credentials work via `allowCredentials: []`).
- If mix of platform + roaming, KeeWebX shows a "Which passkey?" list before firing `navigator.credentials.get()`. The chosen credential ID's entry is passed as the only member of `allowCredentials` so the browser targets it directly.
- `evalByCredential` always passes **only** the salt for the credentials in `allowCredentials` — never leak salts for credentials the user didn't select.

---

## 7. Unlock flow

### Happy path

```
1. User loads KeeWebX in browser.
2. Recent files list renders. Next to each file, a passkey icon if passkey
   is registered.
3. User clicks their "work.kdbx" row.
4. open-view renders. The "Unlock with passkey" button is primary when
   fileInfo.passkeys is non-empty. Master password field is still visible,
   collapsed behind a "Use master password instead" link.
5. User clicks "Unlock with passkey".
6. KeeWebX calls navigator.credentials.get() with evalByCredential for
   all registered passkeys.
7. OS-native dialog. User taps / looks.
8. Browser returns PRF output.
9. HKDF → wrapping key → AES-GCM decrypt → master password bytes.
10. Existing openFile() path continues unchanged: kdbxweb.Credentials →
    Kdbx.load(fileData, credentials) → readModel() → fileOpened().
11. Master password bytes zeroed from memory after credential construction.
```

### Failure modes

| Failure | Detection | UX |
|---|---|---|
| User cancels biometric prompt | `NotAllowedError` on `get()` | "Unlock cancelled." Fall back to master password field focused. |
| Credential not found on this authenticator | `NotAllowedError` with no matching credential | "This device doesn't have the passkey for this vault. Use master password, or register this device in Settings." |
| PRF output missing from response | `getClientExtensionResults().prf` empty | "Your browser / authenticator doesn't support passkey unlock. Use master password." Log telemetry if we ever add it. |
| PRF decrypts but AEAD tag fails | `OperationError` from WebCrypto | "Stored key is corrupted. Please re-register this passkey in Settings." Offer to clear just the bad entry. |
| Browser doesn't support WebAuthn at all | `PublicKeyCredential` undefined | Passkey button is never shown. Fall back to master password UI (current behavior). |
| Safari + YubiKey (broken PRF) | Detected at registration time | Refuse registration up front; don't let the user get into a state they can't unlock from. |

### Fallback: master password is always available

The master-password text input is always rendered on `open-view`, just visually de-emphasized when a passkey is registered. At any point the user can click "Use master password instead" and type, and the unlock proceeds along the unchanged code path. This is the recovery backstop (see §9).

### Integration points in existing code

| File | Change |
|---|---|
| `packages/core/app/scripts/views/open-view.ts` | Add a new `unlockWithPasskey()` method alongside existing `openDb()`. Render a new template block that shows passkey name(s) and the tap button. Gate visibility on `fileInfo.passkeys && window.PublicKeyCredential`. |
| `packages/core/app/scripts/models/app-model.ts` | `openFileWithData()` already accepts `password: ProtectedValue`. New wrapper: after passkey PRF eval returns the master password bytes, build the `ProtectedValue` and call the existing path. Minimal surface change. |
| `packages/core/app/scripts/models/file-info-model.ts` | Add the `passkeys` field as described in §6. Round-trip through `SettingsStore` with no custom serializer (it's plain JSON). |
| `packages/core/app/scripts/models/file-model.ts` | **No change required for unlock itself** — `file.open(password, ...)` takes a `ProtectedValue` today. We reconstruct that ProtectedValue from the unwrapped bytes. |
| New: `packages/core/app/scripts/util/webauthn-prf.ts` | New module: `registerCredential()`, `evalPrf()`, `wrapKey()`, `unwrapKey()`. All pure functions on top of WebCrypto and `navigator.credentials`. Tested in isolation. |

---

## 8. Multi-device and cross-device scenarios

### Case: Apple-only user (iPhone + MacBook)

- iCloud Keychain syncs the passkey across both devices.
- User registers once on either device; the same credential ID is usable on the other.
- Works transparently.

### Case: Apple + Android + Windows user

- iCloud Keychain doesn't sync to non-Apple devices.
- Google Password Manager doesn't sync to non-Google devices.
- Windows Hello is per-device only.
- **Solution:** user registers one credential **per ecosystem** after first unlocking on that ecosystem with the master password. `FileInfoModel.passkeys[]` holds 2-3 entries, one per device.

### Case: user has a YubiKey they want to use everywhere

- Single roaming authenticator, works on Chrome + Firefox + Edge on all desktop OSes.
- **Does not work on Safari desktop** (webkit bug, §4).
- Register once, use everywhere except Safari.
- If the user is a Safari primary user, they must use Safari's platform authenticator (iCloud Keychain) as their main credential and reserve the YubiKey for desktop Chrome/Firefox backup.

### Case: FIDO2 hybrid / caBLE cross-device

The WebAuthn spec supports cross-device sign-in: user on a desktop without a local authenticator scans a QR code with their phone, phone does the biometric, desktop gets the assertion. This works for authentication. **For PRF it works in the assertion response** on current Chrome — tested on Android phones against Chrome desktop. Safari desktop still has the cross-device PRF bug, but on Chromium it works.

We do not need to do anything special: if the user lands on a Chrome desktop that doesn't have a local credential and they registered only an iPhone passkey, Chrome natively offers the "Use another device" option, the user scans a QR, Face ID on phone, PRF comes back. This is a free capability from the browser.

### Case: user wants to register a second device after Phase 2 ships

Flow:
1. On device #2, user opens the vault with the master password (no passkey on device #2 yet).
2. Settings → Security → "Add another passkey". Same as §6 registration flow, but the vault is already open so no master-password re-auth is needed (the recent auth counts).
3. A new `PasskeyEntry` is appended to `fileInfo.passkeys[]`.
4. The `wrappedKey` for the new entry wraps the same underlying master password with a fresh key derived from **device #2's** authenticator PRF output. Each entry is independent.
5. `fileInfos.save()` persists. When the file syncs via WebDAV, the updated sidecar also syncs (see §11 for sidecar vs localStorage discussion).

### Case: user loses their only device

See §9 — recovery story.

---

## 9. Recovery story

This is the load-bearing section. "Lose phone, lose vault" is not acceptable.

### Recovery paths (in order of priority)

#### R1 — Master password (always available, Phase 2 default)

- The master password is the KDBX master password and opens the vault regardless of whether a passkey is registered.
- Even if `passkeyWrappedKey` is corrupted, deleted, or the device is gone, the user types their master password and the existing open path works. Nothing on the KDBX file has changed.
- **This is the primary recovery path for Phase 2.**

#### R2 — Backup passkey (user choice)

- Users are nagged at registration time: "Register a second passkey as a backup. Without a backup, losing this device means using your master password to recover."
- Settings UI has a "Add backup passkey" button.
- Anyone who registers 2+ credentials (e.g. iPhone + YubiKey) has R2.

#### R3 — Recovery phrase (NOT in Phase 2)

A BIP39-style recovery phrase that derives the wrapping key is a nice feature but has tradeoffs:

- Adds a second secret that the user must not lose. Many people lose them.
- If the phrase is weaker than the master password, it's a downgrade.
- If stored with the other backups, it's no better than a written-down master password.

**Recommendation:** Do not ship R3 in Phase 2. Revisit if users on Option B (paid / advanced mode) want it.

#### R4 — Escrow-to-second-party (NOT considered)

We don't have a server, and we're not going to build one. Social recovery / 2-of-3 Shamir is an interesting future, but not Phase 2.

### Phase 2 recovery policy summary

- Master password is always the ground truth. The vault file is a valid KDBX4 file openable in any KDBX client with the master password. If the user loses the passkey, they recover by typing the master password. This is not optional; we do not allow a passkey-only mode in Phase 2.
- The registration UI strongly encourages adding a backup passkey.
- The recovery UX is: "Forgot your passkey? Use master password." Click. Type. Done.

### Comparison to Bitwarden

Bitwarden's passkey login requires the master password as a fallback for exactly the same reason we do. Their doc literally says: *"your master password is required to unlock your vault, so it must be strong and memorable."* We are not the first to make this tradeoff.

---

## 10. UX wireframes (text, not images)

### 10.1 Enable passkey flow (Settings → Security)

```
 ┌─────────────────────────────────────────────────────────┐
 │ Security                                                │
 ├─────────────────────────────────────────────────────────┤
 │                                                         │
 │  Passkey unlock                                         │
 │  ──────────────                                         │
 │  Tap a passkey instead of typing your master password.  │
 │                                                         │
 │   ▸ No passkeys registered for this vault.              │
 │                                                         │
 │   [  Enable passkey unlock  ]                           │
 │                                                         │
 │   Your master password will still work as a backup.     │
 │                                                         │
 └─────────────────────────────────────────────────────────┘
```

Clicking **Enable passkey unlock**:

```
 ┌─────────────────────────────────────────────────────────┐
 │ Enable passkey unlock                        [×]        │
 ├─────────────────────────────────────────────────────────┤
 │                                                         │
 │  Step 1 of 3 — Confirm your identity                    │
 │                                                         │
 │  Enter your current master password to authorize        │
 │  registering a passkey for this vault.                  │
 │                                                         │
 │  Master password                                        │
 │  [ ••••••••••••••• ]                                    │
 │                                                         │
 │  [Cancel]                            [Continue →]       │
 └─────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────┐
 │ Enable passkey unlock                        [×]        │
 ├─────────────────────────────────────────────────────────┤
 │                                                         │
 │  Step 2 of 3 — Register your passkey                    │
 │                                                         │
 │         (•)  Please tap your authenticator.             │
 │                                                         │
 │         Use Face ID, Touch ID, Windows Hello, or         │
 │         a security key. You may be asked to tap twice   │
 │         in quick succession.                            │
 │                                                         │
 │  [Cancel]                                               │
 └─────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────┐
 │ Enable passkey unlock                        [×]        │
 ├─────────────────────────────────────────────────────────┤
 │                                                         │
 │  Step 3 of 3 — Name this passkey                        │
 │                                                         │
 │  Passkey name                                           │
 │  [ MacBook Pro Touch ID          ]                      │
 │                                                         │
 │  ⓘ Suggestion: name it by device so you can tell        │
 │    them apart if you add more later.                    │
 │                                                         │
 │  ⚠ Recommended: after this, add a second passkey       │
 │    (e.g. on your phone, or a YubiKey) as backup.        │
 │                                                         │
 │  [Skip]                              [Save]             │
 └─────────────────────────────────────────────────────────┘
```

### 10.2 First-time unlock with passkey

On the recent-files / open screen:

```
 ┌─────────────────────────────────────────────────────────┐
 │                     KeeWebX                           │
 │                                                         │
 │   Recent files                                          │
 │   ─────────────                                         │
 │                                                         │
 │    🔑 work.kdbx            (WebDAV)      ● passkey      │
 │    🔑 personal.kdbx        (Local)                      │
 │    🔑 shared-family.kdbx   (WebDAV)      ● passkey      │
 │                                                         │
 └─────────────────────────────────────────────────────────┘
```

User clicks `work.kdbx`:

```
 ┌─────────────────────────────────────────────────────────┐
 │ work.kdbx                                    [×]        │
 ├─────────────────────────────────────────────────────────┤
 │                                                         │
 │                 🔐  Unlock work.kdbx                    │
 │                                                         │
 │            ┌──────────────────────────────┐             │
 │            │   Unlock with passkey        │             │
 │            └──────────────────────────────┘             │
 │                                                         │
 │            — or —                                       │
 │                                                         │
 │   Master password                                       │
 │   [                                        ]            │
 │   [ Open ]                                              │
 │                                                         │
 └─────────────────────────────────────────────────────────┘
```

Clicking "Unlock with passkey" triggers the native OS prompt. On success the vault opens.

### 10.3 Fallback mid-flow

If the passkey ceremony fails:

```
 ┌─────────────────────────────────────────────────────────┐
 │ Couldn't unlock with passkey                            │
 │                                                         │
 │ Passkey was cancelled or not recognized.                │
 │ You can try again or use your master password.          │
 │                                                         │
 │   [ Try passkey again ]     [ Use master password ]     │
 └─────────────────────────────────────────────────────────┘
```

Clicking "Use master password" focuses the existing input. Nothing else changes. Existing `openDb()` path runs unchanged.

### 10.4 Managing registered credentials

Settings → Security → Passkey unlock (with 2 registered):

```
 ┌─────────────────────────────────────────────────────────┐
 │  Passkey unlock                                         │
 │  ──────────────                                         │
 │                                                         │
 │  Registered passkeys for work.kdbx:                     │
 │                                                         │
 │   ● MacBook Pro Touch ID                                │
 │     Added 2026-03-14 · Last used today                  │
 │     [ Remove ]                                          │
 │                                                         │
 │   ● YubiKey 5C NFC                                      │
 │     Added 2026-03-20 · Last used 3 days ago             │
 │     [ Remove ]                                          │
 │                                                         │
 │   [  Add another passkey  ]                             │
 │                                                         │
 │   [  Disable passkey unlock entirely  ]                 │
 │                                                         │
 └─────────────────────────────────────────────────────────┘
```

"Remove" deletes that entry from `fileInfo.passkeys[]` and persists. It does not invalidate other entries.

"Disable passkey unlock entirely" clears the array and the user is back to master-password-only.

### 10.5 Add backup passkey (nag dialog)

If user has exactly one passkey, the settings page shows a non-dismissable warning strip:

```
 ┌─────────────────────────────────────────────────────────┐
 │ ⚠ Single passkey registered                             │
 │                                                         │
 │ You have only one passkey. If you lose this device,    │
 │ you'll need your master password to recover your vault.│
 │                                                         │
 │ Recommended: register a backup passkey on another      │
 │ device or a hardware security key.                     │
 │                                                         │
 │   [ Register backup passkey ]       [ I understand ]   │
 └─────────────────────────────────────────────────────────┘
```

---

## 11. Migration path

### Existing users (master password only)

- Upgrade is non-destructive. On first load after the Phase 2 build ships, `FileInfoModel.passkeys` is missing → treated as `null` → UI shows "No passkeys registered" and the current master-password-only open path is unchanged.
- User opts in via Settings when they want to.
- Nothing on the KDBX file changes on disk. `kdbxweb.Kdbx.save()` is not called as part of enabling passkey unlock.

### Backwards compatibility

- A vault with passkeys registered opens fine in KeePassXC, keepass-rs, upstream KeeWeb, etc. They have no knowledge of the `passkeys` sidecar and will not touch it. Full interop preserved.
- The passkeys sidecar is per-browser-profile in localStorage. If the user clears browser data, the passkeys are gone, but the vault is still openable with the master password. This is correct failure.

### Where to store the wrapped key blob — three options evaluated

#### Option 1 — KDBX custom data (inside the vault)

Store the `PasskeyEntry[]` as a `kdbx4 KdbxCustomData` entry on the vault metadata.

Pros: syncs automatically with the vault file.
Cons: makes the KDBX file non-standard-ish. Other clients won't complain, but they'll carry an opaque blob they don't understand. Also, the wrapped key is only useful on devices that have the matching authenticator — syncing it to every device is pointless. Worst: if the user re-saves the vault from KeePassXC, the custom data is preserved, but any new vault state (entries added in KeePassXC) would need to be re-written-back by KeeWebX — there's no risk, just no reason.

#### Option 2 — Sidecar file in cloud storage next to the vault

E.g. `work.kdbx` gets a sibling `work.kdbx.neokeeweb-passkeys.json`.

Pros: syncs across devices on cloud storage. Losing the local browser profile doesn't lose passkeys.
Cons: makes the user's cloud folder messier. The sidecar can get out of sync with the vault (rename vault → sidecar orphaned). WebDAV and future OAuth providers would need awareness. **Not worth the complexity in Phase 2.**

#### Option 3 — Browser localStorage via existing SettingsStore (recommended)

Store `passkeys[]` on `FileInfoModel`, persisted via `SettingsStore` as part of the `fileInfo` key, same place as `chalResp`, `encryptedPassword`, and other per-file metadata that already live there.

Pros:
- Zero new storage mechanism. Piggybacks on the freshly-restored settings-store.
- Per-browser-profile is **correct** semantics — passkeys are device-bound (except iCloud Keychain), so the wrapping blob should also be device-bound.
- No impact on KDBX file on disk. No impact on cloud sync. No impact on other clients.
- Deleting browser profile wipes the passkey unlock shortcut but leaves the vault openable (master password path).

Cons:
- Users who clear browser storage frequently will need to re-register. Document this.
- Users who use KeeWebX in incognito will not persist their passkey. Document this.

**Recommendation: Option 3.** This is what `FileInfoModel` was designed for and it matches how `encryptedPassword` (the Touch ID variant) already works today.

### Sync story

- Vault file itself: synced via WebDAV (Phase 1) / BYOK OAuth (Phase 2 #36).
- Passkey metadata: **local per browser profile**. To use the vault on another device, the user opens it once with the master password there, then Settings → Add another passkey.
- If the user wants zero-touch passkey sync across devices, they should choose an authenticator that syncs (iCloud Keychain, Google Password Manager, 1Password). WebAuthn inherits the sync from the authenticator.

---

## 12. Integration with Phase 3 (#25) and Phase 3+ (#39)

Phase 2 is the foundation. Phase 3 and Phase 3+ both want to evaluate PRF against the same authenticator the user already registered, but with different salts, to derive different keys for different scopes. This section pins down the salt namespace so the three features can coexist without any risk of cross-feature key collision.

### Key derivation tree

```
                    WebAuthn credential (per file, per device)
                              │
                    PRF eval (browser-hashed with "WebAuthn PRF\0")
                              │
        ┌─────────────────────┼────────────────────────┐
        │                     │                        │
   Phase 2 slot         Phase 3 slot             Phase 3+ slot
   (master unlock)      (per-field)              (quick autofill)
        │                     │                        │
  eval.first =         eval.first / second =      eval.first =
  sha256(              sha256(                    sha256(
   "keewebx-          "keewebx-field-enc-v1"   "keewebx-quick-
    unlock-v1"          || 0 || entry.uuid         autofill-v1"
   || 0 || file.id)     || 0 || field.name)        || 0 || entry.uuid
                                                   || 0 || url_pattern)
        │                     │                        │
        ▼                     ▼                        ▼
   HKDF(info=              HKDF(info=                HKDF(info=
   "keewebx-            "keewebx-field-         "keewebx-quick-
    master-unlock-v1")     enc-v1")                  autofill-v1")
        │                     │                        │
        ▼                     ▼                        ▼
   wrapping_key          field_key                 cache_key
   unwraps master        decrypts                  decrypts
   password              Layer 2 ciphertext        cache blob
```

### Non-colliding salt namespaces

Every PRF eval input in KeeWebX follows this shape:

```
sha256( <feature_namespace_ascii> || 0x00 || <feature_specific_bytes> )
```

Feature namespaces (frozen):

| Feature | Namespace string |
|---|---|
| Phase 2 master unlock | `"keewebx-unlock-v1"` |
| Phase 3 per-field (issue #25) | `"keewebx-field-enc-v1"` |
| Phase 3+ quick autofill (issue #39) | `"keewebx-quick-autofill-v1"` |

These are distinct bytes → distinct SHA-256 → distinct PRF inputs → distinct PRF outputs → distinct keys. A compromise of one namespace's key tells you nothing about any other's. The `v1` suffix is there so we can rotate later without collision.

### HKDF `info` parameters (also frozen)

| Feature | HKDF info |
|---|---|
| Phase 2 master unlock | `"keewebx-master-unlock-v1"` |
| Phase 3 per-field | `"keewebx-field-enc-v1"` |
| Phase 3+ quick autofill | `"keewebx-quick-autofill-v1"` |

### Single credential, multiple uses — recommended

The same WebAuthn credential the user registers in Phase 2 will be reused by Phase 3 and Phase 3+. One registration, three features. Rationale:

- Registering more credentials would multiply biometric prompts for no security benefit. Salt namespaces give cryptographic isolation without needing per-feature credentials.
- The WebAuthn credential itself is just an HMAC key holder — it has no awareness of which feature is calling it.
- If a user loses the authenticator, all three features fail together, which is the expected behavior (the phone is gone).

The alternative — one credential per feature — has no concrete benefit and triples the registration UX cost.

### What Phase 2 must guarantee for Phase 3 to work

- PRF `enabled: true` verified at registration time and rejected if false. Phase 3 cannot retrofit PRF onto a non-PRF credential.
- `eval.second` slot is **not consumed** by Phase 2. Phase 2 uses `first` only, leaving `second` free for Phase 3 batch decrypts.
- Credential ID and transport list stored in `PasskeyEntry` so Phase 3 can construct the same `evalByCredential` shape without re-registering.
- Namespace `"keewebx-unlock-v1"` is Phase 2's forever. Phase 3 / 3+ must not reuse it.

---

## 13. Test strategy

### Unit tests (in `packages/core`)

Target file: `packages/core/test/webauthn-prf.test.ts` (new).

- **HKDF determinism.** Same PRF output + same salt + same info → same wrapping key. Different info → different wrapping key. Property-based test with a few hundred random inputs.
- **AES-GCM wrap/unwrap round-trip.** Wrap a known master password, unwrap, verify bytes match.
- **Wrong wrapping key rejects.** AEAD tag failure surfaces as a specific error type the UI can distinguish from "user cancelled".
- **Salt namespace collision check.** Hardcode the three namespace strings and assert `sha256(namespace || 0x00 || testFileId)` is distinct across Phase 2, Phase 3, Phase 3+. This is a regression guard for future refactors.
- **Eval input construction.** Given a known file.id, verify the `prfEvalInput` bytes match the spec exactly (byte for byte). Snapshot test.
- **PasskeyEntry schema round-trip.** Serialize → JSON.stringify → JSON.parse → rebuild object → identical. Regression guard against silent schema drift.

All of these run in `bun test` with zero browser dependency — they exercise the pure crypto and data-shape code, not the WebAuthn ceremony itself.

### E2E tests (Playwright)

Target file: `e2e/core/passkey-unlock.spec.ts` (new).

Playwright exposes Chromium's virtual authenticator via CDP. The happy-path registration + unlock test looks like:

```ts
test("register passkey and unlock", async ({ page, browser }) => {
  const context = await browser.newContext();
  const session = await context.newCDPSession(page);
  await session.send("WebAuthn.enable");
  const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol:    "ctap2",
      transport:   "internal",
      hasResidentKey:    true,
      hasUserVerification: true,
      isUserVerified:    true,
      // PRF support flag — CDP gained this post-Chrome 125
      hasPrf:            true,
    },
  });
  // ... navigate to KeeWebX, open a demo vault with a master password,
  // enter Settings, click Enable passkey unlock, provide password,
  // observe the virtual authenticator fires create + get,
  // close browser and reopen, click Unlock with passkey, assert vault is open.
});
```

**Known gap:** Chromium's `WebAuthn.addVirtualAuthenticator` started supporting `hasPrf` around Chrome 125 (mid 2024). We need to verify with `bun run test:e2e` during implementation that the flag is respected on our pinned Chromium version. If not, we file an issue to bump. WebKit / Firefox virtual authenticator do not support PRF at all as of April 2026 — E2E runs on Chromium only for passkey specs.

### Integration tests on local dev

Document in `docs/phase2-passkey-unlock-design.md` or a new `docs/passkey-dev-setup.md`:

1. Open `http://localhost:8085` (where `bun run dev` serves).
2. Chrome → DevTools → WebAuthn tab → Enable virtual authenticator → Add authenticator → ctap2 / internal / has resident key / has user verification / has large blob / **has PRF**.
3. Register passkey in KeeWebX settings.
4. Refresh browser.
5. Unlock with passkey.

This manual flow is the ground truth for "does a real human with a real YubiKey / Face ID get the same result as our test double."

### Cross-browser smoke

Before release, hit each supported browser on each supported OS with a YubiKey (for desktop Chrome/Firefox/Edge) and with Touch ID / Face ID / Windows Hello (for platform authenticator). Record pass/fail matrix in the release notes.

---

## 14. Open questions

None of these block starting implementation, but they need a decision before we ship Phase 2 RC.

| # | Question | Decision owner | Suggested default |
|---|---|---|---|
| Q1 | Do we allow registering a non-PRF authenticator and "just" use it as biometric presence, with master password still typed? | Main agent / user | No. If PRF is disabled, we show "This authenticator doesn't support passkey unlock; use master password." We don't want a second, weaker mode. |
| Q2 | Should removing the last passkey require the master password as a confirmation step? | Main agent | Yes. Mirrors the "remove 2FA" flow in most apps. |
| Q3 | Do we persist `lastUsedAt` across browser profiles? | Main agent | No — it's per-device UI metadata only. Not synced. |
| Q4 | Can a user share one `PasskeyEntry` across multiple files (same credential for all vaults)? | Main agent | No in Phase 2. One registration per file. Phase 2.1 could add a "same credential for all files on this device" shortcut if users ask. |
| Q5 | Do we rate-limit unlock attempts via passkey (e.g. exponential backoff after N failed PRF decrypts)? | Main agent | Not needed. Each failed unlock requires a full WebAuthn ceremony with user verification — the authenticator rate-limits us. |
| Q6 | What do we do on Safari + YubiKey when the user *already* registered on another browser and tries Safari? | Main agent | Detect at unlock time, show a clear "This browser can't use security keys for passkey unlock. Use Chrome/Firefox, or use a platform passkey, or use master password." Treat as a browser limitation, not a user error. |
| Q7 | Should we add a telemetry hook to measure how many users register a backup passkey? | Main agent / privacy | No, per project stance on no telemetry. |
| Q8 | Is there a reason to store `PasskeyEntry` encrypted at rest within localStorage (e.g. with a key derived from…what)? | Architect | No. The wrapped key is already a ciphertext, and the credential ID is not secret. The rest (name, timestamps) are not worth encrypting. |
| Q9 | Do we migrate the existing `encryptedPassword` + `deviceOwnerAuth` KeeWeb-inherited Touch ID plumbing, or leave it in place? | Main agent / SWE-Core | Leave it as dead code to delete later in a separate cleanup pass. The new passkey code lives alongside it to avoid a risky refactor inside a feature add. File a follow-up issue. |
| Q10 | Firefox on Android has no PRF. What do we tell those users? | Main agent | Detection → "Your browser doesn't support passkey unlock. Use Chrome on Android, or use your master password." No workaround. |

---

## 15. Implementation plan (high-level)

This is a sketch. Concrete sub-issues will be filed by main agent after this design is approved.

### Suggested sub-issues under #9 (do not file yet)

1. **#9.1 — WebAuthn PRF primitives module** (`packages/core/app/scripts/util/webauthn-prf.ts`) + unit tests. HKDF, wrap, unwrap, evalInput construction. Pure crypto, no UI. Ships self-contained.
2. **#9.2 — `FileInfoModel.passkeys` schema** + `SettingsStore` persistence round-trip + data model upgrade path. Ships self-contained, zero UI.
3. **#9.3 — Registration flow (Settings UI)**. Three-step modal described in §10.1. Calls into #9.1 and #9.2.
4. **#9.4 — Unlock flow (`open-view` integration)**. New "Unlock with passkey" button. Passkey-aware render state. Fallback to master password. Calls into #9.1 to produce `ProtectedValue`, then hands off to existing `openFile()` path.
5. **#9.5 — Manage registered passkeys UI**. List, remove, add another, disable entirely. §10.4.
6. **#9.6 — Backup passkey nag**. Single-credential warning strip + "register another" flow. §10.5.
7. **#9.7 — E2E test suite**. Playwright virtual authenticator with PRF, happy path + failure modes. §13.
8. **#9.8 — Docs**: user-facing README section + developer setup guide for the virtual authenticator. Update CLAUDE.md Phase 2 checklist.
9. **#9.9 — Feature B placeholder**. Split the issue-#9 "Store website passkeys" subfeature into its own tracking issue to avoid scope creep. (Not implemented here, just filed.)

### Sequencing

```
#9.1 ──┐
       ├── #9.3 (registration) ──┐
#9.2 ──┘                         ├── #9.5 (manage)
                                 ├── #9.6 (backup nag)
#9.4 (unlock) ───────────────────┤
                                 └── #9.7 (E2E) ── #9.8 (docs) ── ship
```

- #9.1 + #9.2 can ship in parallel (independent files, no integration).
- #9.3 and #9.4 both depend on #9.1 + #9.2 and can ship in parallel.
- #9.5, #9.6 layer on top of #9.3.
- #9.7 must come after #9.3 + #9.4 since there's no E2E to write without both.
- #9.8 last (docs reflect real behavior, not planned behavior).
- #9.9 is a meta-issue, file it anytime.

### Dependencies on other Phase 1 / Phase 2 items

- **Hard dependency**: `SettingsStore` must be non-stubbed. This was resolved in the 2026-04-09 warroom and is confirmed working.
- **Soft dependency**: Phase 2 BYOK OAuth (#36) is independent. No interaction.
- **Soft dependency**: Phase 2 iOS share (#35) is independent. No interaction.
- **Downstream**: #25 (per-field) and #39 (quick autofill) are gated on #9 landing. They consume §12's salt namespaces.

### Estimated scope

- **New code**: ~300 lines of `webauthn-prf.ts` + ~150 lines of model changes + ~400 lines of UI (registration modal + open-view integration + settings list).
- **Tests**: ~200 lines of unit tests + ~150 lines of E2E.
- **Total**: roughly 1200 LoC net add. Self-contained module surface, no touches to KDBX format or crypto primitives already in kdbxweb.

---

## Appendix A — Glossary

| Term | Meaning |
|---|---|
| Passkey | WebAuthn credential that authenticates a user without a password. Can be backed by platform biometrics or a hardware key. |
| PRF | Pseudo-Random Function extension to WebAuthn. Lets a client derive a 32-byte secret from an authenticator + a salt. Built on CTAP2 hmac-secret. |
| `eval.first` / `eval.second` | The two input slots of the PRF extension's single-call evaluation API. |
| HKDF | HMAC-based Key Derivation Function (RFC 5869). We use HKDF-SHA-256 to turn PRF output into a wrapping key. |
| Wrapping key | The AES-GCM key derived from PRF output, used to encrypt the vault's master password bytes. |
| KDBX4 | The KeePass 2 file format version 4. Uses ChaCha20 + Argon2id. KeeWebX is KDBX4-only. |
| RP ID | Relying Party ID in WebAuthn. Scoped to a hostname. Binds the credential to KeeWebX's domain. |
| Discoverable credential | A passkey that can be listed by the authenticator without the RP telling it which credential ID to look for. Improves UX on "forgot my username" screens. Not critical for Phase 2 but we set `residentKey: preferred`. |

## Appendix B — Minimum viable code sketch (illustrative only, not committed)

```ts
// packages/core/app/scripts/util/webauthn-prf.ts — sketch, not final

const PRF_NAMESPACE_UNLOCK   = "keewebx-unlock-v1";
const HKDF_INFO_UNLOCK       = "keewebx-master-unlock-v1";
const HKDF_SALT_BYTES        = 16;
const AES_GCM_NONCE_BYTES    = 12;

async function buildPrfEvalInput(fileId: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const prefix  = encoder.encode(PRF_NAMESPACE_UNLOCK);
  const sep     = new Uint8Array([0]);
  const id      = encoder.encode(fileId);
  const buf     = new Uint8Array(prefix.length + 1 + id.length);
  buf.set(prefix, 0);
  buf.set(sep,    prefix.length);
  buf.set(id,     prefix.length + 1);
  return crypto.subtle.digest("SHA-256", buf);
}

async function deriveWrappingKey(
  prfOutput: ArrayBuffer,
  kdfSalt:   ArrayBuffer
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw", prfOutput, "HKDF", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: kdfSalt,
      info: new TextEncoder().encode(HKDF_INFO_UNLOCK),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function wrapMasterPassword(
  masterPasswordBytes: ArrayBuffer,
  prfOutput:           ArrayBuffer
): Promise<{
  wrappedKey: ArrayBuffer;
  nonce:      ArrayBuffer;
  kdfSalt:    ArrayBuffer;
}> {
  const kdfSalt = crypto.getRandomValues(new Uint8Array(HKDF_SALT_BYTES));
  const nonce   = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const key     = await deriveWrappingKey(prfOutput, kdfSalt.buffer);
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    masterPasswordBytes
  );
  return { wrappedKey, nonce: nonce.buffer, kdfSalt: kdfSalt.buffer };
}

export async function unwrapMasterPassword(
  wrappedKey: ArrayBuffer,
  nonce:      ArrayBuffer,
  kdfSalt:    ArrayBuffer,
  prfOutput:  ArrayBuffer
): Promise<ArrayBuffer> {
  const key = await deriveWrappingKey(prfOutput, kdfSalt);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, wrappedKey);
}
```

That is the entire Phase 2 crypto surface. Everything else is UI plumbing and model persistence.

---

## Appendix C — Decisions summary (for the main agent's merge review)

| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Key wrap strategy | **Option A** (wrap master password) | Option B (random 32-byte master key) | Preserves KDBX interop, safe migration, safe recovery via master password. Option B's stronger at-rest security is better addressed in Phase 3 (#25) without breaking interop. |
| Recovery | **Master password always** + backup passkey encouraged | Recovery phrase, social recovery | Master password is already the KDBX trust root. Adding a second recovery secret is a net UX loss without meaningful gain. |
| Storage | **`FileInfoModel.passkeys` via `SettingsStore` (localStorage)** | KDBX custom data, cloud sidecar | Passkeys are device-bound; storage should be device-bound. Matches existing `encryptedPassword` Touch-ID-path behavior. No new storage mechanism. |
| Salt namespace | **Three frozen strings**, SHA-256 domain separation | Dynamic / per-install namespace | Determinism is required for re-unlock; rotation is handled via `v1` suffix. |
| Credential reuse | **One credential, three feature salts** (Phase 2 + #25 + #39) | Separate credential per feature | No security benefit from separate credentials; large UX cost for extra registrations. |
| Ship gate | **PRF required, no fallback to non-PRF "biometric presence" mode** | Allow non-PRF as a degraded mode | Two unlock modes is twice the test surface and user confusion. Master password is our one fallback. |

---

*End of document.*
