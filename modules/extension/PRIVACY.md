# Privacy Policy — KeeWebX Connect

**Last updated:** 2026-04-12

KeeWebX Connect is an open-source browser extension that connects to a KeeWebX instance to autofill passwords. This policy explains what data the extension accesses and how it is handled.

## Data Collection

**KeeWebX Connect does not collect, transmit, or store any personal data.** The extension does not have analytics, telemetry, crash reporting, or any form of data collection.

## Data Access

The extension accesses the following data solely to perform autofill:

| Data | Purpose | Storage |
|------|---------|---------|
| Page URL and title | Sent to KeeWebX to match credentials for the current site | Not stored by the extension |
| Credentials (username, password, TOTP) | Retrieved from KeeWebX and injected into form fields | Never stored — held in memory only for the duration of the fill operation |
| KeeWebX instance URL | User-configured URL for connecting to KeeWebX | Stored locally in `chrome.storage.local` on the user's device |
| Encryption key pair | NaCl (Curve25519) key pair for encrypted communication with KeeWebX | Generated per session, never persisted to disk |

## Communication

All communication between the extension and KeeWebX is encrypted end-to-end using **TweetNaCl** (Curve25519 + XSalsa20 + Poly1305). The extension communicates exclusively with the user's own KeeWebX instance — either the official hosted version or a self-hosted deployment. No data is sent to any third-party server.

## Permissions

| Permission | Why it's needed |
|------------|----------------|
| `activeTab` | Focus the active tab for autofill |
| `tabs` | Find and communicate with the KeeWebX tab |
| `contextMenus` | Show autofill options in the right-click menu |
| `storage` | Save the user's KeeWebX URL preference |
| `webNavigation` | Detect frames (iframes) in pages for autofill |
| `scripting` | Inject the autofill content script into pages |
| `<all_urls>` | Autofill works on any website the user visits |

## Third-Party Services

The extension does not use any third-party services. No data leaves the user's browser except to communicate with the user's own KeeWebX instance.

## Open Source

The complete source code is available at [github.com/gynet/keewebx](https://github.com/gynet/keewebx) under the MIT license. The cryptographic implementation uses the audited [TweetNaCl.js](https://tweetnacl.js.org) library.

## Changes

If this policy changes, the update will be reflected in this file in the repository with an updated date.

## Contact

For questions about this policy, open an issue at [github.com/gynet/keewebx/issues](https://github.com/gynet/keewebx/issues).
