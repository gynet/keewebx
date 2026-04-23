# Phase 2 — Passkey Design (umbrella)

**Status:** Design. Feature A shipped; Feature B not yet implemented.
**Tracking issue:** [#9](https://github.com/gynet/keewebx/issues/9)
**Milestone:** [Phase 2: Quick Unlock + Passkey](https://github.com/gynet/keewebx/milestone/2)
**Author:** TL agent, 2026-04-14
**Related docs:**
- [`phase2-passkey-unlock-design.md`](./phase2-passkey-unlock-design.md) — Feature A deep dive (shipped)
- [`phase2-interfaces.md`](./phase2-interfaces.md) — TypeScript interface contracts between `core`, `db`, and `extension`

---

## 0. TL;DR

Phase 2 ships WebAuthn passkey support in two independent features.

| | Feature A: Quick Unlock | Feature B: Passkey Authenticator |
|---|---|---|
| **Location** | `packages/core` (the web app) | `packages/extension` + optional KDBX helpers in `packages/db` |
| **Touches KDBX file?** | **No.** Wrapper stored in IndexedDB. | **Yes.** Private key lives as a KDBX entry field; the KDBX file itself is still a standard KDBX4 file (no schema changes). |
| **Who uses it?** | The vault owner, on their own device, to skip typing master password. | Any website, when the user chooses to register/login with a passkey and the extension wins the `navigator.credentials.*` call. |
| **Status** | **Shipped 2026-04-11** (commits `ffdf5399`/`a1de7bab`/`34403462`/`6ca49366`/`ee7b0dbe`). | Designed, not implemented. Broken out into sub-issues — see §7. |
| **Compat risk** | Low — KDBX untouched. | **Medium.** KDBX stays valid but entries gain a reserved custom-field namespace; unknown tools that touch custom data must not corrupt it. Must interop with KeePassXC as a password-manager (can see username/notes) even though KeePassXC can't use the stored private key. |

Feature B is **the user story in #9 that is not yet shipped.** This umbrella doc exists to split it into reviewable sub-issues and lock down the interfaces before any SWE writes code.

Phase 2 **also** contains two unrelated feature tracks already in the milestone (BYOK OAuth #36, iOS share Phase 2 subset #35). Those have their own design docs and are **out of scope of this document** — this doc is strictly about the passkey half of Phase 2 (#9).

---

## 1. User stories

### 1.1 Feature A (shipped, recap)

> As a vault owner on a personal laptop, I want to open my KDBX file by pressing my Touch ID / YubiKey instead of typing a 30-character master password every time, while keeping my KDBX file 100% compatible with KeePassXC on my other devices.

Shipped path: register PRF passkey once → PRF output derives wrap key → stores `AES-GCM(wrapKey, masterPassword)` ciphertext per-file in IndexedDB → on next open, tap passkey → unwrap → hand recovered `ProtectedValue` to `kdbxweb.Credentials` → unlock. Master password remains the unconditional fallback. See `phase2-passkey-unlock-design.md` §5 for the full protocol.

### 1.2 Feature B (this design)

> As a vault owner, I want my password manager to act as a **passkey authenticator** for websites: when a site says "register a passkey", the extension offers to store the new private key inside my KDBX entry for that site; when the site says "sign in with passkey", the extension signs the challenge with that stored key and returns an assertion. This lets me use passkeys across every browser on every device that can open my KDBX, instead of being locked to iCloud Keychain / Google Password Manager / a specific YubiKey.

Constraints the user explicitly cares about:

- **C1. KDBX stays valid.** KeePassXC opening the same file must not see corruption; it just sees a few extra custom fields on some entries. No KDBX4 schema additions.
- **C2. Origin binding is real.** A malicious page must not be able to harvest a passkey by mimicking another site's origin, and a passkey registered on `github.com` must never sign for `githob.com`. This is the entire point of WebAuthn and we must not weaken it.
- **C3. User verification is enforced.** Signing requires user presence + verification (UV=true), delegated to the underlying OS / hardware passkey that unlocks the vault — we do **not** invent our own PIN UI.
- **C4. The private key is protected by the master password** (directly, via KDBX4's inner stream cipher on `ProtectedValue` fields). If the KDBX file is exfiltrated, the attacker still has to break Argon2id — same threat model as any stored password.
- **C5. No silent operation.** The extension never auto-signs. Every `navigator.credentials.get()` shows a consent UI naming the RP, the entry, and the origin before the private key is touched.

---

## 2. Feature A — what shipped (recap only)

Already covered in `phase2-passkey-unlock-design.md`. One-paragraph summary for the umbrella doc:

- `packages/core/app/scripts/comp/passkey/passkey-prf.ts` — pure WebAuthn+AES-GCM primitives (`isPasskeyPrfSupported`, `registerPasskey`, `evaluatePrf`, `wrapKey`, `unwrapKey`). No storage, no models.
- `packages/core/app/scripts/comp/passkey/passkey-unlock.ts` — HKDF-SHA256 over PRF output with `info='neokeeweb-passkey-unlock-v1'` and `salt=fileId`, domain-separated so Phase 3 #25 and #39 can reuse the same credential with different `info` strings.
- `packages/core/app/scripts/models/file-info-model.ts` — new descriptor fields `passkeyCredentialId` / `passkeyPrfSalt` / `passkeyWrappedKey` / `passkeyCreatedDate`, round-tripped through `settings-store` (the persistence layer repaired in the 2026-04-09 warroom).
- `packages/core/app/scripts/views/open-view.ts` — checkbox "Enable passkey unlock for this file" on first open; tap-to-unlock affordance on subsequent opens.
- `e2e/core/passkey-unlock.spec.ts` — CDP virtual authenticator end-to-end.

Escape hatch: any persisted file without `passkeyCredentialId` falls through to the classic password form. Removal flow clears all 4 fields + wrapped ciphertext in one `settings-store` write.

---

## 3. Feature B — architecture

### 3.1 Processes and isolation boundaries

WebAuthn calls happen on the **page**, so the extension must intercept there. Manifest V3 forbids injecting code into the page's main world from a content script's isolated world without an explicit `"world": "MAIN"` script, which Chrome 101+ supports.

```
   PAGE WORLD (site origin)                 ISOLATED WORLD               EXTENSION SW
  +----------------------+   postMessage   +---------------+   port    +--------------+
  | page JS              | -------------> | content-auth  | -------> | background   |
  | calls                |                 | -script.ts    |           | auth-bridge  |
  | navigator.credentials|                 | (relay)       |           | +            |
  | .create / .get       |                 +---------------+           | vault access |
  |                      |                         ^                   +------+-------+
  | passkey-shim.ts      |                         |                          |
  | (MAIN world, shims   |                         |                          v
  |  navigator.creds)    |                                                 open KDBX in
  +----------------------+                                                 core web app
                                                                         (via existing
                                                                         NaCl protocol)
```

Files and their world:

| File | World | Purpose |
|---|---|---|
| `packages/extension/src/content/passkey-shim.ts` | **MAIN** (page) | Override `navigator.credentials.create` / `.get`. Post request to isolated world. Await response. Resolve/reject the original Promise. |
| `packages/extension/src/content/content-passkey.ts` | ISOLATED | Relay between page and background. Validates `event.origin === window.location.origin`. |
| `packages/extension/src/background/passkey/passkey-authenticator.ts` | SW | Orchestrator. Looks up the vault entry for `rp.id`, asks vault (via existing NaCl protocol) for the private key, signs, returns assertion. |
| `packages/extension/src/background/passkey/passkey-crypto.ts` | SW | `SubtleCrypto` wrappers: generate ES256/EdDSA key pair, sign authenticator data + client data hash, build attestation object. |
| `packages/extension/src/background/passkey/passkey-store.ts` | SW | Thin adapter over the NaCl protocol verbs that talk to the core app (`passkey-create-entry`, `passkey-get-by-rp`, `passkey-update-counter`). Does **not** touch KDBX directly — the SW does not hold vault credentials. |
| `packages/core/app/scripts/comp/passkey/passkey-authenticator-bridge.ts` | core web app | Server side of the protocol verbs above. Reads/writes the KDBX entries. |

**Why the SW must not hold the master password / key:** the background SW in MV3 is short-lived and persisted only in `chrome.storage`. Putting raw `ProtectedValue` there would be a significant regression vs the current NaCl protocol where the vault-side process holds the key and the extension just asks for values.

### 3.2 `navigator.credentials` shim strategy

The shim replaces the two methods with wrappers that:

1. Check if there is an entry in the open vault matching `rp.id`.
2. If yes and user accepts the consent prompt → route via background.
3. If no (or user declines) → call the saved original method (stored before override) so native / other authenticators still work.

```
// pseudocode — real code in passkey-shim.ts, not this doc
const original = { create: navigator.credentials.create.bind(navigator.credentials),
                   get:    navigator.credentials.get.bind(navigator.credentials) };
navigator.credentials.create = async (options) => {
  if (!options?.publicKey) return original.create(options);
  const verdict = await askExtension('create', options.publicKey);
  if (verdict.mode === 'keewebx') return verdict.credential;
  if (verdict.mode === 'native')    return original.create(options);
  throw verdict.error;                         // user cancelled or vault locked
};
```

**Fallback order** when extension cannot serve:
1. Vault locked → ask user to unlock → retry.
2. No matching entry for `rp.id` → surface "No passkey stored for {rp.id} in your vault. Use native authenticator?" prompt; user picks.
3. User declines → return `NotAllowedError` per spec (same shape as a user-cancelled native prompt).

This keeps compatibility with sites that test for multi-authenticator flows.

### 3.3 KDBX schema (no format changes)

KDBX4 entries already support arbitrary **string fields** and **binary attachments**, both of which can be `ProtectedValue` (inner-stream-cipher encrypted). We reuse that existing capability.

**Per-entry custom fields for a stored passkey:**

| Field name | Protected? | Content |
|---|---|---|
| `NKW.Passkey.Version` | no | `"1"` schema version. Required. |
| `NKW.Passkey.RpId` | no | Relying party ID (eDNS-1.1), e.g. `"github.com"`. Required. |
| `NKW.Passkey.RpName` | no | Relying party name as supplied at `create()`. Display only. |
| `NKW.Passkey.CredentialId` | no | base64url of 32-byte random credential ID. Required. |
| `NKW.Passkey.UserHandle` | yes | base64url of user handle chosen by RP at registration (per-site pseudonymous ID). Required. Protected because it can be user-identifying. |
| `NKW.Passkey.Alg` | no | IANA COSE algorithm identifier: `"-7"` (ES256) or `"-8"` (EdDSA). Required. |
| `NKW.Passkey.PrivateKey` | **yes** | base64url of PKCS#8 (ES256) or raw seed (Ed25519) private key. **Never leaves the vault-side process in plaintext** except as a signing input inside SubtleCrypto. |
| `NKW.Passkey.PublicKey` | no | base64url of SPKI. Useful for recovery & re-publishing the credential. |
| `NKW.Passkey.SignCount` | no | 32-bit unsigned decimal string. Incremented on every successful `get()`. |
| `NKW.Passkey.CreatedDate` | no | ISO 8601 UTC. Display only. |
| `NKW.Passkey.LastUsedDate` | no | ISO 8601 UTC. Display only. |
| `NKW.Passkey.BackupState` | no | `"device-bound"` or `"backed-up"`. We always write `"device-bound"` because the key only lives where the KDBX lives. |
| `NKW.Passkey.Transports` | no | JSON array: `["internal","hybrid"]` or similar; used to satisfy `authenticatorAttachment`. |

**Why string fields, not attachments:** KDBX4 attachments are indexed by binary pool — fine, but attachments can't be marked protected in KeePassXC's UI. Protected string fields work everywhere, and PKCS#8 for ES256 is ~150 bytes — well under any reasonable field size.

**Why a `NKW.Passkey.*` namespace:** avoids colliding with KeePassXC's `KPH: *` browser integration fields or any existing custom field a user might have. The `NKW.` prefix is reserved for KeeWebX-specific extensions going forward.

**URL binding:** we do **not** set the entry's `URL` field from `rp.id` automatically — the user might already have a login entry for `https://github.com/` and we don't want to clobber it. Instead:
- On `create()`: if the active entry (or an entry matching the current domain) exists, offer "Attach passkey to this entry". Otherwise create a new sibling entry named `"🔑 github.com passkey"` in the same group.
- On `get()`: lookup is by `NKW.Passkey.RpId`, **not** by URL. RP ID is the only authoritative binding per WebAuthn.

**Resident/discoverable credential:** supporting `residentKey: 'required'` is mandatory — that's what lets the user sign in without typing a username. We implement this by storing `UserHandle` in the entry and returning it in the `get()` response; lookup by `rp.id` alone is sufficient.

### 3.4 Signing flow (Web Crypto API)

```
# register (create)
  1. page: navigator.credentials.create({publicKey: {rp, user, challenge, pubKeyCredParams, ...}})
  2. shim: forward to background via isolated world
  3. bg:   verify options.publicKey.rp.id matches the origin's effective domain
  4. bg:   pick alg: ES256 preferred (widest support), EdDSA if only -8 offered
  5. bg:   SubtleCrypto.generateKey({name:'ECDSA', namedCurve:'P-256'}, extractable=true, ['sign'])
  6. bg:   build AuthenticatorData (rpIdHash | flags(UP=1,UV=1,BE=0,BS=0,AT=1) | signCount=0 | attestedCredData)
  7. bg:   build AttestationObject (fmt='none', attStmt={}, authData) — self-attestation none is allowed per spec §6.5.4
  8. bg:   call passkey-store.ts → core-app protocol verb 'passkey-create-entry'
           payload: {rpId, rpName, userHandle, credentialId, alg, privateKeyPkcs8, publicKeySpki}
           core exports private key once, writes protected fields, clears plaintext
  9. bg:   return PublicKeyCredential-shaped object to shim
 10. shim: hand to page's original Promise

# sign (get)
  1. page: navigator.credentials.get({publicKey: {challenge, allowCredentials?, rpId?, ...}})
  2. shim: forward to background
  3. bg:   look up entry by rpId via protocol verb 'passkey-get-by-rp'
           if allowCredentials provided, intersect with stored credentialId
  4. bg:   show consent UI (extension popup or in-page overlay): RP, origin, entry name
  5. bg:   on consent → protocol verb 'passkey-sign' passes (rpId, credentialId, authenticatorData, clientDataHash)
           core-side: import PKCS#8 → SubtleCrypto.sign('ECDSA', {hash:'SHA-256'}, privKey, data) → return DER-encoded signature
           core-side also: increment SignCount, update LastUsedDate, mark file dirty
  6. bg:   assemble AuthenticatorAssertionResponse {clientDataJSON, authenticatorData, signature, userHandle}
  7. shim: hand to page
```

**SignCount handling:** WebAuthn L3 §6.1.1 makes RPs free to detect cloned authenticators via counter regression. We always return a monotonically increasing counter *per credential* and persist it on every successful sign **before** returning the assertion. Failing to persist = counter regression on next use = RP may lock the credential. Must be a synchronous KDBX write via the core protocol verb.

**Clock skew / drift:** counters are not timestamps; they're pure counters. No clock source involved.

**Algorithms:** ES256 (`-7`, ECDSA P-256 + SHA-256) is mandatory. EdDSA (`-8`, Ed25519) is optional; browsers don't universally support Ed25519 in `SubtleCrypto` yet (Safari lags, Chrome shipped 2023, Firefox 2024), so Phase 2 ships ES256-only; EdDSA is a follow-up once `CryptoKey` interop is universal.

### 3.5 Origin verification

The shim runs **in the page**, which means the page can tamper with its own JS. We cannot trust `window.location.origin` as reported to the background directly. Instead:

- The content script (isolated world) reads `window.location.origin` **itself** (not via postMessage payload from the page).
- The background additionally has access to `sender.url` from `chrome.runtime.onMessage`, which Chrome guarantees reflects the actual frame. We cross-check: `new URL(sender.url).origin === isolatedOriginFromContentScript` else reject.
- We then check that `rp.id` is a registrable-domain suffix of the origin's effective domain per WebAuthn §5.1.4.1.3, using the PSL (Public Suffix List) rules. An embedded PSL via the `psl` npm package.

This is the **same** logic a native authenticator performs; we must not deviate.

### 3.6 Consent UI

For Phase 2 the consent UI is:
- `navigator.credentials.create()` → extension popup (`browser.action.openPopup()`) with: origin, RP ID, RP name, user name, "This will create a new entry in your vault" + entry picker dropdown, "Create" / "Cancel".
- `navigator.credentials.get()` → in-page overlay (injected by the content script into a closed ShadowRoot) with: origin, RP ID, entry name, "Sign in" / "Cancel". In-page because the page is waiting on a Promise and popping the extension popup mid-flow is jarring.

Overlay style follows existing extension autofill UI (reuse `packages/extension/src/content/overlay/` if present; otherwise new module in Preact to match existing code style).

### 3.7 Degradation and compatibility matrix

| Browser | MAIN-world script injection | `navigator.credentials.create` override | `ECDSA P-256` in SubtleCrypto | Verdict |
|---|---|---|---|---|
| Chrome 120+ | ✅ (MV3 world:MAIN) | ✅ | ✅ | supported |
| Edge 120+ | ✅ | ✅ | ✅ | supported |
| Firefox 128+ | ✅ (MV3 via `world: "MAIN"` landed ~126) | ✅ | ✅ | supported (test matrix required; Firefox lagged Chrome ~18mo on MV3) |
| Safari | ❌ (no `world: "MAIN"` in Safari Web Extensions as of 2026-04) | — | — | not supported — extension installs but shim is a no-op; users fall through to Safari's native authenticator (acceptable per #38 non-goals) |
| Mobile Chrome (Android) | ✅ but extension distribution limited | ✅ | ✅ | supported via sideload |
| Mobile Safari (iOS) | ❌ | — | — | out of scope per #38 |

Interop with KeePassXC:
- KeePassXC sees `NKW.Passkey.*` as unknown custom fields and preserves them on save.
- KeePassXC cannot **use** the private key for signing — it has no passkey authenticator. That is by design.
- KeePassXC's XC-Browser integration uses `KPH:*` fields — we don't touch that namespace, so browser-integration fields continue to work for the same entry.
- keepass-rs interop tests must be extended to read + preserve an `NKW.Passkey.*` entry without data loss (SDET task — see §7.6).

Interop with KeeWeb upstream: same as KeePassXC — preserved but unused.

### 3.8 Threat model (Feature B specific)

| Threat | Mitigation |
|---|---|
| Malicious page tries to call `get()` against an unrelated `rp.id` | RP ID must be registrable-domain suffix of origin; shim rejects otherwise. Same rule as native authenticators. |
| XSS on a legitimate site tries to trigger `get()` silently | Consent UI is always shown; user must click. In-page overlay is in a closed ShadowRoot the page's JS cannot style/hide/click-jack (we use `pointer-events` isolation + `element.focus()` capture). |
| Extension script compromised / supply-chain attack | Unavoidable in the MV3 model. Mitigated by: private key never leaves core app, background only receives DER signatures. Even a hostile background SW cannot exfiltrate the raw key without the user having already unlocked the vault — and at that point the attacker can exfiltrate everything anyway. This is the standard password-manager extension threat model. |
| Attestation privacy | We emit `fmt: 'none'` (self-attestation is not implemented; spec §6.5.4 allows `none`). No device-identifying data leaks. |
| Cloning resistance | SignCount is persisted before the assertion is returned. If an attacker exfiltrates the KDBX file and signs in parallel from a second device, the RP will see counter regression and can lock the credential. This is best-effort — SignCount is well-known to be unreliable in practice (cloud-synced authenticators all use 0 forever) — but we provide it as RPs may check. |
| Backup state / device binding signal | We always emit `BS=0, BE=0` (not eligible for backup, not backed up) because the key is pinned to the specific KDBX file. Honest signaling. If the user syncs the KDBX via WebDAV, that's the user's choice — but from the authenticator's POV, this credential is device-bound. |
| User reuses passkey entry across multiple vaults (export/import) | SignCount will skip / rewind and RP may lock credential. Documented caveat; same as re-importing a cloud-synced passkey dump. |
| Vault never unlocked during `get()` → infinite wait | Shim timeout: WebAuthn spec allows up to `options.publicKey.timeout` (default 60s). We respect it. On timeout, throw `NotAllowedError`. User unlocks vault and retries. |

### 3.9 Acceptance criteria (Feature B)

- [ ] **AC-B1.** Registration: visiting `https://webauthn.io` → "Register" → "Platform" selects KeeWebX → consent UI shows `webauthn.io` origin + RP ID → user clicks "Create" → a new KDBX entry is created in the configured target group with the 13 `NKW.Passkey.*` custom fields → site reports registration success → public key in site's backend matches what was stored.
- [ ] **AC-B2.** Authentication: same site → "Sign in with passkey" (no username typed) → KeeWebX overlay shows origin + entry name → user clicks "Sign in" → SignCount in KDBX entry increments by exactly 1 → LastUsedDate updates → site reports auth success.
- [ ] **AC-B3.** RP mismatch: simulated malicious page at `evil.com` calls `get({rpId:'github.com'})` → shim rejects with `SecurityError` before touching vault.
- [ ] **AC-B4.** Vault locked: `get()` call arrives while vault is locked → background returns "locked" → shim shows overlay "Unlock KeeWebX to use passkey" → on unlock, sign completes (within timeout).
- [ ] **AC-B5.** Fallback: user declines KeeWebX → original `navigator.credentials.get()` is called → native authenticator prompt appears.
- [ ] **AC-B6.** KeePassXC interop: the KDBX file opens in KeePassXC → passkey entry visible with all 13 fields → KeePassXC saves the file → reopening in KeeWebX → `get()` still works → SignCount preserved.
- [ ] **AC-B7.** Counter regression: tamper with SignCount in KDBX (decrement) → site's backend can detect (manual test; this is RP-side behavior we just document).
- [ ] **AC-B8.** E2E: Playwright CDP + WebAuthn virtual authenticator spec (`e2e/extension/passkey-authenticator.spec.ts`) simulates a full create + get round-trip against a local test RP, asserts on KDBX contents after.
- [ ] **AC-B9.** Unit tests: `passkey-crypto.ts` (keypair gen, auth-data encode, signature DER shape) + `passkey-store.ts` (lookup-by-rp, counter increment) reach ≥85% line coverage.
- [ ] **AC-B10.** No `@ts-ignore` / `@ts-expect-error` / `no-explicit-any` introduced (keeps the 0-escape-hatch baseline the strict-mode session achieved for core; extension has its own baseline).

---

## 4. Ownership and package responsibilities

| Package | Feature A (shipped) | Feature B (new) |
|---|---|---|
| `packages/core` | owns PRF wrap/unwrap, FileInfoModel fields, open-view UI, E2E spec | owns `passkey-authenticator-bridge.ts` (NaCl protocol verbs for the extension to reach vault), entry schema, entry create/read/update, KeePassXC round-trip tests |
| `packages/db` | **no changes** | **no changes to format code.** Possibly add a helper `packages/db/lib/helpers/passkey-entry.ts` for reading/writing the `NKW.Passkey.*` field set with type safety — owned by SWE-DB. Purely optional sugar; core can also use raw `KdbxEntry.fields.set()`. |
| `packages/extension` | not involved | owns `passkey-shim.ts` (MAIN world), `content-passkey.ts` (isolated), `passkey-authenticator.ts` / `passkey-crypto.ts` / `passkey-store.ts` (SW), in-page consent overlay, option-page UI for "default target group" |
| `e2e/` | `passkey-unlock.spec.ts` done | new `e2e/extension/passkey-authenticator.spec.ts` (CDP virtual authenticator against a local fixture RP) |

Cross-package work for Feature B is the **NaCl protocol extension** — new message verbs defined in §5.1 of [`phase2-interfaces.md`](./phase2-interfaces.md). These are owned jointly by SWE-Core (server side) and SWE-Ext (client side) — the SDET agent should gate their integration with the new E2E spec.

---

## 5. Out of scope / deferred to Phase 3

| Item | Tracking | Why deferred |
|---|---|---|
| **Per-field** hardware encryption | #25 | Requires Phase 2's PRF primitive shipped (done), per-field UX design, migration story for existing KDBX files, interop impact analysis. Genuinely a separate feature. |
| Quick Autofill per-URL PRF-gated cache | #39 | Depends on #25 storage format. |
| CTAP2 external authenticator protocol | none | We are an **internal** authenticator (WebAuthn only, shim inside the browser). CTAP2 would make KeeWebX act as a **roaming** authenticator visible to other browsers — requires BLE/USB/NFC transport, Chrome-only hybrid flow support, and has no web-only implementation path in 2026. Defer indefinitely. |
| Passkey-only vault (no master password) | none | No safe recovery story; breaks KDBX interop. Not planned. |

---

## 6. Risks and mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Chrome changes MV3 main-world script rules, breaks shim | High | Low | Pin to manifest V3 `world: "MAIN"` which is stable since Chrome 111; have a test in CI that boots Chromium headful and runs a virtual-authenticator spec against a local page — catches breakage immediately. |
| SubtleCrypto ECDSA signature format not matching WebAuthn spec | High | Medium | Spec requires ASN.1 DER; SubtleCrypto returns IEEE P1363 raw (r||s). **Must convert** — easy bug to miss. E2E spec asserts on signature shape against a real RP that verifies. |
| SignCount lost on crash between sign and KDBX save | Medium | Low | Always save KDBX **before** returning the assertion. Accept the latency hit (IndexedDB write + WebDAV sync if configured). Sign without saving = user-facing failure (return `NotAllowedError`, ask user to retry). |
| Content script load ordering — page JS runs before shim installs | Critical | Medium | Declare content script as `"run_at": "document_start"` + MAIN-world injection. Tested in E2E. If the shim misses a `create()` that fires at page-load, user can't register — acceptable failure mode (they reload). |
| User has multiple unlocked vaults, ambiguous which one owns an entry | Medium | Low | At most one vault is "active" in the core app at a time (current architecture). Extension queries the active vault only. Documented limitation. |
| Keypair export succeeds but re-import fails on a different browser opening same KDBX | High | Medium | PKCS#8 is standardized; test matrix: keypair created on Chrome/Win → KDBX synced to Firefox/Mac → `get()` works. Covered by E2E. |

---

## 7. Task breakdown (sub-issues under #9)

The following sub-issues implement Feature B. Each is an independently reviewable unit with its own acceptance test. They run in dependency order but multiple can be parallelized.

| # | Title | Owner | Depends on | Parallelizable |
|---|---|---|---|---|
| B-1 | Define NaCl protocol verbs `passkey-create-entry`, `passkey-get-by-rp`, `passkey-sign`, `passkey-update-counter` + extend `packages/extension/src/background/protocol/types.ts` + write contract tests | SWE-Core + SWE-Ext | — | no (blocks all others) |
| B-2 | `passkey-crypto.ts` in extension SW: keypair gen, AuthenticatorData encode, ES256 DER conversion, AttestationObject (fmt=none) | SWE-Ext | B-1 | yes (with B-3) |
| B-3 | `passkey-authenticator-bridge.ts` in core: handle the 4 new verbs, read/write `NKW.Passkey.*` fields, SignCount persistence, mark file dirty | SWE-Core | B-1 | yes (with B-2) |
| B-4 | `passkey-shim.ts` (MAIN world) + `content-passkey.ts` (isolated): override `navigator.credentials.*`, origin verification, fallback to native | SWE-Ext | B-2 | no |
| B-5 | Consent UI: popup for `create()`, in-page overlay (closed ShadowRoot) for `get()`. Preact, match existing extension UX | SWE-Ext | B-4 | no |
| B-6 | Optional `packages/db/lib/helpers/passkey-entry.ts` typed accessor | SWE-DB | B-3 (schema locked) | yes (anytime after B-3) |
| B-7 | Options page: "Default target group for new passkeys" + "Enable passkey authenticator" toggle | SWE-Ext | B-4 | yes |
| B-8 | E2E spec `e2e/extension/passkey-authenticator.spec.ts` — CDP virtual authenticator, local fixture RP, full create+get+kdbx-inspect | SDET | B-5 | no |
| B-9 | KeePassXC interop test: create passkey in KeeWebX → save → open in KeePassXC (via keepass-rs harness) → fields preserved → re-save → KeeWebX `get()` still works | SDET | B-8 | no |
| B-10 | Docs: README section on passkey authenticator, security model writeup, supported browsers table | TL | B-8 done | yes |

Milestone target: all 10 sub-issues closed before Phase 2 milestone closes. Stretch: parallel with #36 BYOK OAuth.

Acceptance test ownership = the owner of each issue writes the test; SDET reviews.

---

## 8. Open questions (for user / domain review)

1. **Target group selection UX.** Current plan: popup asks "pick group" on each `create()`. Alternative: one global "default passkey group" in options, silent on register. User preference? → my recommendation: default group in options + a "save to different group" opt-in in the popup — best of both.
2. **Multiple passkeys per RP.** WebAuthn allows multiple credentials per RP. If a user already has a passkey for `github.com` and registers another, do we: (a) create a second entry, (b) refuse with an error, (c) offer to replace. → recommendation: (a) — matches native authenticator behavior.
3. **Vault-lock UX during `get()`.** Popup unlock flow adds 1-2 clicks. Acceptable for Phase 2; revisit if telemetry shows friction.
4. **Algorithm support.** ES256 only for Phase 2, or also ES256 + EdDSA? → recommendation: ES256 only; add EdDSA in Phase 2.1 once Safari's SubtleCrypto ships Ed25519.

These are called out in the GitHub sub-issues so the user can answer them before SWE implementation starts.

---

## 9. References

- WebAuthn L3 — https://www.w3.org/TR/webauthn-3/
- PRF extension — https://www.w3.org/TR/webauthn-3/#prf-extension
- COSE algorithms — https://www.iana.org/assignments/cose/cose.xhtml
- MV3 `world: "MAIN"` — https://developer.chrome.com/docs/extensions/reference/api/scripting#type-ExecutionWorld
- Public Suffix List — https://publicsuffix.org/
- Phase 2 unlock design (shipped) — [`phase2-passkey-unlock-design.md`](./phase2-passkey-unlock-design.md)
- Phase 2 interfaces — [`phase2-interfaces.md`](./phase2-interfaces.md)
