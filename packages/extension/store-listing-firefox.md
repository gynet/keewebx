# Firefox Add-ons (AMO) Listing — KeeWebX Connect

> Reference for addons.mozilla.org submission.

## Add-on Name

KeeWebX Connect

## Add-on URL (slug)

keewebx-connect

## Summary (250 chars max)

Password autofill for KeeWebX, a modern open-source KeePass web client. End-to-end encrypted communication via NaCl. No data collection. No cloud. Supports TOTP, keyboard shortcuts, and 11 languages.

## Description (AMO supports HTML subset)

<b>KeeWebX Connect</b> is the companion browser extension for <a href="https://github.com/gynet/keewebx">KeeWebX</a>, a modern open-source KeePass-compatible password manager that runs entirely in your browser.

<b>Features</b>

<ul>
<li><b>Smart Autofill</b> — Click the toolbar button or press Cmd+Shift+U (Ctrl+Shift+U on Linux/Windows) to auto-detect and fill login forms</li>
<li><b>TOTP/OTP</b> — Insert one-time 2FA codes directly from your KeePass database</li>
<li><b>End-to-End Encrypted</b> — NaCl encryption (Curve25519 + XSalsa20 + Poly1305) for all extension-to-app communication</li>
<li><b>Context Menu</b> — Right-click on any input for granular options: username, password, both, OTP, or custom fields</li>
<li><b>Keyboard Shortcuts</b> — 9 customizable commands for fast form filling</li>
<li><b>No Desktop App Required</b> — Connects to a KeeWebX tab in your browser</li>
<li><b>Self-Hostable</b> — Works with the official hosted version or your own deployment</li>
<li><b>11 Languages</b> — EN, DE, FR, ES, CS, NL, JA, PL, UK, ZH-CN, ZH-TW</li>
<li><b>Zero Data Collection</b> — No analytics, no telemetry, no tracking</li>
</ul>

<b>How It Works</b>

<ol>
<li>Open KeeWebX in a browser tab and unlock your KeePass database</li>
<li>Click the KeeWebX Connect button on any login page</li>
<li>Credentials are fetched over an encrypted channel and filled into the form</li>
</ol>

<b>Privacy</b>

KeeWebX Connect does not collect any data. Credentials are never stored by the extension. All encryption happens locally in your browser. Full privacy policy: https://github.com/gynet/keewebx/blob/master/packages/extension/PRIVACY.md

<b>Open Source</b>

MIT licensed. Source code: https://github.com/gynet/keewebx

## Category

Privacy & Security

## Tags

password-manager, autofill, keepass, totp, encryption

## Homepage

https://github.com/gynet/keewebx

## Support URL

https://github.com/gynet/keewebx/issues

## License

MIT

## Privacy Policy URL

https://github.com/gynet/keewebx/blob/master/packages/extension/PRIVACY.md

## Reviewer Notes (visible only to AMO reviewers)

This is a password autofill extension that communicates with a KeeWebX web app instance running in another browser tab.

Architecture:
- Background service worker manages the connection to the KeeWebX tab
- Content script (content-page.ts) detects login form fields and injects credentials
- Content script (content-keeweb.ts) is injected into the KeeWebX tab to relay encrypted protocol messages
- All credential data is encrypted end-to-end with TweetNaCl (NaCl box)

The `<all_urls>` host permission is required because autofill must work on any website where the user has a login. The extension cannot pre-declare which domains users will visit.

The extension does not minify/obfuscate its code — the built output in dist/firefox/js/ is readable webpack bundles.

Source code: https://github.com/gynet/keewebx/tree/master/packages/extension
Build instructions: `bun install && bun run build-firefox` (requires Bun runtime)
The `web-ext build` step in the build script produces the .zip for submission.

No remote code loading. No eval(). CSP is `default-src 'self'`.

## Screenshots

Use images in `img/firefox/`:
1. `button.png` — Toolbar button
2. `menu.png` — Context menu
3. `shortcuts.png` — Keyboard shortcuts settings

TODO: Create additional screenshot of the options page.
