# KeeWebX Connect — Browser Extension

Browser extension for [KeeWebX](https://github.com/gynet/keewebx), a modern open-source KeePass-compatible password manager.

## Features

- **Smart Autofill** — one-click credential fill with automatic form detection
- **TOTP/OTP** — insert one-time 2FA codes directly
- **End-to-End Encrypted** — NaCl (Curve25519 + XSalsa20 + Poly1305) for all communication
- **Keyboard Shortcuts** — Ctrl+Shift+U (Cmd+Shift+U on macOS) + 8 more customizable commands
- **Context Menu** — right-click options for username, password, OTP, and custom fields
- **Web-Only Mode** — no native app required, connects to a KeeWebX tab
- **Self-Hostable** — works with any KeeWebX instance
- **11 Languages** — EN, DE, FR, ES, CS, NL, JA, PL, UK, ZH-CN, ZH-TW
- **Manifest V3** — modern extension architecture

## Installation

Download the matching Chrome, Edge or Firefox package from the
[Connect release](https://github.com/gynet/keewebx/releases/tag/v1.0.4-extension).
Store listings are not available yet. Extract Chrome/Edge packages and use
the unpacked installation steps below. A Firefox build package is unsigned;
use a temporary development installation unless a signed package is provided.
Renaming a ZIP to XPI does not sign it.

## Connect to the web app

1. Open the extension's options. Set the app address to `https://keewebx.app/app`,
   or your own KeeWebX installation, and save. Replace old `/preview/` addresses.
   Grant the requested site permission. In a build with a bundled vault, choose
   the mode that connects to a browser tab before configuring its address.
2. Open that address in the same browser and unlock your KDBX database.
3. Approve browser extension access when KeeWebX asks. Return to the login
   website, open the extension and select an account.
4. Manage allowed databases and revoke access in KeeWebX's browser extension
   settings. Locking the database prevents credential access.

If connection fails, check that the configured URL matches the open app and
that the database is unlocked. Check the extension's site permissions. Save
pending database changes before refreshing the app. The extension options
include setup and troubleshooting even while disconnected.

## iOS Safari with Userscripts

Use the separate experimental [KeeWebX Connect userscript](userscript/README.md)
with the **Userscripts** app. It has its own extension-style connection panel;
the desktop extension's settings do not configure it. Its small connection
page discovers cooperating app tabs, including independently opened tabs.
Confirm **Connect this tab** in the app you want to use and approve vault
access. If no app responds, the connection page opens the normal app instead.

The script uses native `window.postMessage` for linked tabs and reuses the
existing encrypted Connect protocol, permission checks and form-fill helpers.
The relay forwards encrypted messages without decrypting credentials. It
does not submit login forms. Keep the selected KeeWebX tab and connection page
open. Standalone Home Screen PWA sessions and reliable background execution
under iOS suspension remain unverified.

## Building

Requires [Bun](https://bun.sh) runtime.

```sh
# Install dependencies (from monorepo root)
bun install
cd modules/extension

# Build for all browsers
bun run start

# Build for a specific browser
bun run build-chrome
bun run build-firefox
bun run build-edge

# Development watch mode
bun run watch-chrome
bun run watch-firefox
```

Built output goes to `dist/{chrome,firefox,edge}/`.

The Firefox build also runs `web-ext build` to produce a `.zip` for AMO submission.

## Loading Unpacked (Development)

**Chrome**: Go to `chrome://extensions/`, enable Developer mode, click "Load unpacked", select `dist/chrome/`.

**Firefox**: Go to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", select `dist/firefox/manifest.json`.

## Protocol

KeeWebX implements [keepassxc-protocol](https://github.com/keepassxreboot/keepassxc-browser/blob/develop/keepassxc-protocol.md) with modifications listed in [docs/keeweb-connect-protocol.md](docs/keeweb-connect-protocol.md).

## Privacy

No data collection. No analytics. No telemetry. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](https://github.com/gynet/keewebx/blob/master/LICENSE)
