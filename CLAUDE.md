# KeeWebX

Modern KeePass web client. Forked from [keeweb](https://github.com/keeweb/keeweb), rewritten as a TypeScript monorepo.

## Quick Reference

```bash
bun install              # Install all workspace dependencies
bun run dev              # Dev server (core web app)
bun run build            # Build all packages
bun run test             # Test all packages
bun run test:db          # Test database package only
bun run test:core        # Test core web app only
bun run test:extension   # Test browser extension only
```

## Monorepo Structure

```
packages/
  core/       @keewebx/core       Web-based password manager UI (JS -> TS migration in progress)
  db/         @keewebx/db         KDBX4 database library (TypeScript, already mature)
  extension/  @keewebx/extension  Browser extension for autofill (TypeScript, Preact)
```

## CI/CD Workflows

- `.github/workflows/ci.yml` — test + typecheck + extension E2E (Chromium + Firefox).
- `.github/workflows/deploy-pages.yml` — build + deploy `packages/core/dist/` to GitHub Pages, then verify the live URL.
- `.github/workflows/release.yml` — self-host release bundle. On tag push `v*` it builds, packages `packages/core/dist/` into `keewebx-web-<tag>.{zip,tar.gz}` + sha256, and attaches to the GitHub Release. On `workflow_dispatch` it uploads the same bundle as a workflow artifact (versioned `dev-<short-sha>`) so it's testable without cutting a tag. Same build path as `deploy-pages.yml`, so the SHA-drift guarantee holds.

## Architecture Decisions

- **Web-only**: No Electron/desktop. PWA-first approach.
- **KDBX4 only**: Dropped KDBX3 (Salsa20 + AES-KDF). Only ChaCha20 + Argon2id.
- **Bun workspace**: Monorepo with `bun` as package manager and runtime.
- **TypeScript everywhere**: `packages/db` and `packages/extension` are already TS. `packages/core` is being migrated from JS.

## Key Dependencies

| Package | Core deps |
|---------|-----------|
| db | `@xmldom/xmldom`, `fflate` (gzip) |
| core | `kdbxweb` (-> `@keewebx/db`), `jquery`, `morphdom`, `handlebars`, `argon2-browser` |
| extension | `preact`, `tweetnacl` (NaCl crypto) |

## Crypto

- **AES-256-CBC**: Database encryption via WebCrypto
- **ChaCha20**: Database encryption + inner stream cipher (KDBX4)
- **Argon2id**: Key derivation (pluggable, user must provide impl)
- **SHA-256/512**: Key hashing, HMAC
- **tweetnacl**: Extension <-> app encrypted communication

## Development Rules

- Commit directly to `master`. PRs only when explicitly requested.
- Always run tests before committing.
- Never add npm packages without checking if Bun built-ins or existing deps cover it.
- All new code must be TypeScript with strict mode.

## Architectural Decisions

- **Web-only**: No Electron, no desktop wrapper, no native iOS/Android app. PWA-first.
- **KDBX4 only**: ChaCha20 + Argon2id. No KDBX3.
- **Storage**: WebDAV + IndexedDB in Phase 1. Phase 2 adds BYOK OAuth (Dropbox/Google Drive) via #36. No upstream OAuth secrets, ever.
- **Non-goals** (see #38): KeeWebX will NOT become an iOS Safari extension (PWA/extension isolation + App Store friction) and will NOT attempt to be an OS-level system password manager (credential provider APIs are native-only by design). The browser-boundary is the intended scope. Differentiation comes from Phase 3 hardware-backed encryption, not system integration.

## Phase 1 Checklist

See milestone: https://github.com/gynet/keewebx/milestone/1

- [x] Merge 3 repos into monorepo
- [x] Strip Electron/desktop code (#1 closed)
- [x] Drop KDBX3, keep KDBX4 only (#3 closed)
- [x] Strip OAuth providers, keep WebDAV + IndexedDB (#8 closed — replacement tracked by #36 BYOK OAuth)
- [x] Modernize build: Grunt -> Bun + Webpack (#5 closed)
- [x] CI/CD with GitHub Actions (#7 closed)
- [x] Playwright E2E framework (config + spec stubs)
- [x] keepass-rs interop tests (607 tests passing)
- [x] Remove dead desktop/plugin/YubiKey code (33 files, -1500 lines)
- [x] Legacy deps cleaned (#6 — lodash + bourbon removed; baron + pikaday kept as feature-backing; jquery kept)
- [x] TypeScript migration for packages/core (#2 — 58 → 0 @ts-nocheck files)
- [x] CRUD regression guard E2E (#34 — entry + group CREATE/UPDATE/DELETE, `e2e/core/crud.spec.ts`)
- [x] CRUD persistence regression guard E2E (`e2e/core/crud-persistence.spec.ts` — IndexedDB cache roundtrip)
- [x] Runtime persistence restored (settings-store + settings-manager fully restored; 2026-04-09 warroom regressions verified fixed via TL protocol)
- [x] **TS strict-mode baseline → 0** (368 → 306 → 204 → 82 → 74 → 0 in one session, -100%). `transpileOnly: true` dropped from `packages/core/webpack.config.js`, ts-loader now does real type-checking at bundle time. Full rewrite of `app-model.ts` / `entry-model.ts` / `file-model.ts` types. Module augmentation for kdbxweb `ProtectedValue` in `packages/core/app/scripts/kdbxweb.d.ts` eliminates ~14 casts. **Two real upstream-inherited bugs found and fixed during migration**: `protected-value-ex.isFieldReference` (number vs string compare, papered over by downstream regex) + `protected-value-ex.forEachChar` 3-byte UTF-8 branch missing `continue` (corrupted iteration over CJK / emoji / IPA chars, silent data loss in password search and strength analysis for non-ASCII users).
- [x] **Escape hatch cleanup phase 1** (186 → 119 `@ts-ignore`/`@ts-expect-error`/`no-explicit-any`, -35%). Further cleanup is view-layer generics work.
- [ ] E2E test scenarios (#4 — roundtrip + clipboard + import + NaCl + OTP + CRUD + CRUD persistence done; remaining gaps tracked by #40)
- [ ] iOS share workflow Phase 1 subset (#35 — Mode A `navigator.share` + Mode E/F docs, clipboard hygiene UX)
- [ ] WebDAV CORS diagnostic UI (#37)

## Phase 2 Checklist

See milestone: https://github.com/gynet/keewebx/milestone/2

- [x] Passkey quick unlock (WebAuthn PRF, Feature A) — #9 — `comp/passkey/passkey-prf.ts` (pure WebAuthn+AES-GCM primitives) + `comp/passkey/passkey-unlock.ts` (HKDF-SHA256 wrap, `info='neokeeweb-passkey-unlock-v1'`, `salt=fileId`) + `FileInfoModel` descriptor fields (`passkeyCredentialId` / `passkeyPrfSalt` / `passkeyWrappedKey` / `passkeyCreatedDate`) + `open-view` enable-at-open checkbox + passkey-icon unlock button. Touch ID `saveEncryptedPassword` stub in `app-model.ts:1640` deliberately left as a no-op (web-only mode, superseded by passkey). E2E spec tracked by SDET.
- [ ] BYOK OAuth storage adapters (Dropbox + Google Drive) — #36
- [ ] iOS share workflow Phase 2 subset (#35 — Mode B `share_target`, Mode C/D URL scheme + Shortcut docs, Mode G QR handoff)

## Phase 3 Checklist

- [ ] **Per-field** hardware encryption (YubiKey + WebAuthn PRF) — #25 (was mistitled "per-entry"; corrected to per-field for search/autofill compatibility)
- [ ] Quick Autofill — per-URL scoped cache with PRF gating — #39

## Future

- [ ] Mobile app — Capacitor iOS/Android, native autofill (CredentialProvider + AutofillService), YubiKey NFC, Face ID. Web app runs in WebView, zero frontend rewrite. — #59
- [ ] Lightweight desktop bridge — thin native process bridging OS-level autofill APIs (macOS/Windows/Linux) to KeeWebX browser extension. Not a desktop app, just a credential provider bridge (~500 LOC). — #60
