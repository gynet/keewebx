# KeeWebX

**The only KeePass client you can run by double-clicking a `.html` file.**

Modern, web-only KeePass client — KDBX4, TypeScript, zero runtime dependencies. Browser extension autofill included.

**Demo:** https://keewebx.app/ · **Self-host:** [Releases](https://github.com/gynet/keewebx/releases)

Forked from [KeeWeb](https://github.com/keeweb/keeweb) (stalled since 2021), rebuilt for simplicity, security, and maintainability.

## Pure Local Mode — the killer feature

Download `keewebx-web-<version>.zip`, extract, **double-click `index.html`**. Done.

- ✅ No web server. No Python. No Node. No Docker. No nginx.
- ✅ All KDBX encryption/decryption runs in your browser (WebCrypto).
- ✅ **Browser extension autofill works on `file://`** — open your KDBX at `file:///.../index.html`, install [`keewebx-connect`](https://github.com/gynet/keewebx/releases), autofill works. No HTTPS setup, no localhost tunnel. (Firefox + Chrome + Edge.)
- ✅ Zero network calls — verify with your browser's network tab.
- ✅ Source-auditable: 1 monorepo, ~20 prod deps, TypeScript strict.

Your encrypted KDBX file never leaves your disk. The app loads from disk. The extension talks to the app over `window.postMessage`. Nothing phones home.

## What Changed from KeeWeb

| | KeeWeb | KeeWebX |
|---|---|---|
| Platform | Electron + Web | **Web only** |
| Language | JavaScript (Babel) | **TypeScript (strict)** |
| DB Format | KDBX3 + KDBX4 | **KDBX4 only** (ChaCha20 + Argon2id) |
| Build | Grunt + Webpack | **Bun + Webpack** |
| Repos | 3 separate | **1 monorepo** |
| Dependencies | ~80 packages | **~20 packages** |
| Desktop | Electron v13 | **Removed** |
| Storage | Dropbox, GDrive, OneDrive, WebDAV | **WebDAV + IndexedDB** |
| Unlock | Master password | Master password **+ WebAuthn passkey quick unlock** (Touch ID / Face ID / Windows Hello / YubiKey) |

## What's new since the fork

![colorful tag chips and tag sidebar](screenshots/colorful-tags.png)

- **Colorful tag chips.** Tags render as colored pills instead of comma-separated text. Color is derived from the tag string, so the same tag is the same color everywhere.
- **Tag cloud in the sidebar.** Tags flow-wrap as pills, or as a dot list — toggle in Settings → Appearance.
- **Bigger site icons.** Favicon picker reads Apple touch icons and web manifest icons (up to 128 px) instead of just `/favicon.ico`. Pick the size in Settings → Appearance.
- **AES-GCM WebDAV credentials.** Stored credentials are AES-256-GCM with a key derived from the master password. Upstream used XOR.
- **Passkey quick unlock.** Touch ID, Face ID, Windows Hello, YubiKey — after you've unlocked once on the device with your master password.
- **Browser extension works on `file://`.** Open the app by double-clicking `index.html`, autofill still works (Firefox, Chrome, Edge).
- **One icon registry.** Every Font Awesome glyph the app uses is listed in one TS file. The webpack build generates the font subset and CSS from it. Adding an icon is a one-line edit.
- **New logo and PWA splash screens.**

## Self-hosting

Grab the static self-host bundle from the
[Releases page](https://github.com/gynet/keewebx/releases) —
`keewebx-web-<version>.zip` / `.tar.gz` + `.sha256`. Same build as the
hosted demo; all KDBX handling runs 100% in the browser (WebCrypto).

### Option A — Pure local (`file://`, zero-dep)

Extract the zip, **double-click `index.html`**. See [Pure Local Mode](#pure-local-mode--the-killer-feature) above.

**Passkey quick unlock on `file://`** works on Firefox, not on Chrome / Edge / Safari. This is a spec-level restriction ([W3C WebAuthn #474](https://github.com/w3c/webauthn/issues/474)) — `file://` origins have no effective domain, so Chromium and Safari reject them. No browser flag or origin trial bypasses it. If you want passkey unlock on Chrome, use Option B (localhost or HTTPS). Master password unlock works everywhere on `file://`.

### Option B — Any static HTTP server

```bash
python3 -m http.server 8080
# or: bunx serve .
```

Serve from nginx, Caddy, GitHub Pages, S3+CloudFront, Netlify, etc. Under
HTTP(S) the PWA service worker registers and passkey quick unlock works in all browsers.

## Quick Start (development)

```bash
git clone https://github.com/gynet/keewebx.git
cd keewebx
bun install
bun test
bun run dev     # http://localhost:8085
```

## Monorepo

```
packages/
  core/         Web password manager UI
  db/           KDBX4 database library (@xmldom/xmldom, fflate — that's it)
  extension/    Browser autofill extension (Manifest V3, Chrome/Firefox/Edge)
```

Package deep-dives and API examples: see each package's own README.

## Storage

| Backend | Protocol | Use Case |
|---------|----------|----------|
| **WebDAV** | HTTPS + Basic Auth | Nextcloud, Synology, ownCloud, any WebDAV server |
| **IndexedDB** | Browser API | Local-only, offline access |

OAuth cloud providers (Google Drive / Dropbox / OneDrive) return in Phase 2 via BYOK — see [#36](https://github.com/gynet/keewebx/issues/36).

## Security

- KDBX4 only — no legacy crypto (Salsa20, AES-KDF removed)
- ChaCha20 + Argon2id, WebCrypto API
- Passwords as `ProtectedValue` (XOR-encrypted in memory)
- DOMPurify for XSS prevention
- tweetnacl for extension ↔ app encrypted protocol

## Roadmap

- **Phase 1** — foundation (TypeScript, Bun, KDBX4-only, tests + E2E). See [milestone 1](https://github.com/gynet/keewebx/milestone/1).
- **Phase 2** — passkey quick unlock (#9 shipped), BYOK OAuth (#36), iOS share workflow (#35). Passkey PRF compatibility matrix: [#9 comment](https://github.com/gynet/keewebx/issues/9). See [milestone 2](https://github.com/gynet/keewebx/milestone/2).
- **Phase 3** — per-field hardware encryption (YubiKey PRF, #25), quick autofill (#39), P2P device sync (WebRTC + KDBX native merge, #26).

## License

[MIT](LICENSE)

## Credits

Built on [KeeWeb](https://github.com/keeweb/keeweb) by Antelle and [kdbxweb](https://github.com/keeweb/kdbxweb). Original work MIT-licensed.
