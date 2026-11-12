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

Install from the official stores:

- [Chrome Web Store](https://chrome.google.com/webstore/detail/keewebx-connect/) *(coming soon)*
- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/keewebx-connect/) *(coming soon)*

Or load the unpacked extension for development (see below).

## Building

Requires [Bun](https://bun.sh) runtime.

```sh
# Install dependencies (from monorepo root)
bun install

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
