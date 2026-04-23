# Chrome Web Store Listing — KeeWebX Connect

> Reference for Chrome Web Store Developer Dashboard submission.

## Extension Name

KeeWebX Connect

## Summary (132 chars max)

Password autofill for KeeWebX — a modern, open-source KeePass web client. End-to-end encrypted. No cloud. No tracking.

## Description (16,000 chars max)

KeeWebX Connect is the companion browser extension for KeeWebX, a modern open-source KeePass-compatible password manager that runs entirely in your browser.

🔑 SMART AUTOFILL
• One-click credential fill — click the toolbar button or press Ctrl+Shift+U
• Detects username and password fields automatically
• Works with multi-step login forms and iframes
• Right-click context menu for granular control (insert username only, password only, or both)

🔐 ONE-TIME PASSWORDS (TOTP/OTP)
• Insert 2FA codes directly from your KeePass database
• No need to switch apps or type codes manually

🛡️ END-TO-END ENCRYPTED
• All communication between the extension and KeeWebX is encrypted with NaCl (Curve25519 + XSalsa20 + Poly1305)
• Credentials are never stored by the extension — held in memory only during the fill operation
• No analytics, no telemetry, no data collection whatsoever

⌨️ KEYBOARD SHORTCUTS
• Ctrl+Shift+U — Smart autofill (detects what's needed)
• Fully customizable via chrome://extensions/shortcuts
• 9 distinct commands: insert/submit username, password, both, OTP, and custom fields

🌐 WEB-BASED — NO DESKTOP APP REQUIRED
• Connects to a KeeWebX tab in your browser — no native app installation needed
• Works with the official hosted version or your own self-hosted instance
• Configure your KeeWebX URL in the extension settings

🗣️ MULTILINGUAL
• Available in 11 languages: English, German, French, Spanish, Czech, Dutch, Japanese, Polish, Ukrainian, Chinese (Simplified & Traditional)

📖 OPEN SOURCE
• MIT licensed — fully auditable source code
• Built with TypeScript, Preact, and TweetNaCl
• https://github.com/gynet/keewebx

HOW IT WORKS
1. Open KeeWebX in a browser tab and unlock your database
2. Click the KeeWebX Connect toolbar button on any login page
3. Credentials are fetched, encrypted in transit, and filled into the form

REQUIREMENTS
• A KeeWebX instance with an unlocked KeePass (.kdbx) database
• KeeWebX hosted version: https://keewebx.app/

PRIVACY
KeeWebX Connect does not collect any data. No analytics. No telemetry. No cloud storage of credentials. All encryption happens locally. Full privacy policy: https://github.com/gynet/keewebx/blob/master/packages/extension/PRIVACY.md

## Category

Productivity

## Language

English (United States)

## Website

https://github.com/gynet/keewebx

## Privacy Policy URL

https://github.com/gynet/keewebx/blob/master/packages/extension/PRIVACY.md

## Single Purpose Description (required by Chrome Web Store)

This extension autofills passwords from a KeeWebX (KeePass-compatible) password manager into web page login forms.

## Permission Justifications (required by Chrome Web Store review)

### activeTab
Used to identify the currently active tab so the extension can inject credentials into the focused page's form fields.

### tabs
Used to find an open KeeWebX tab for communication and to query tab URLs for credential matching.

### contextMenus
Used to show a right-click context menu with autofill options (insert username, password, OTP, etc.) on input fields.

### storage
Used to persist the user's preferred KeeWebX instance URL (a single string value) in local storage.

### webNavigation
Used to enumerate frames (iframes) within a page so autofill works on login forms embedded in iframes.

### scripting
Used to inject the content script that performs form detection and credential filling into the active tab.

### host_permissions: <all_urls>
The extension must run on any website where the user wants to autofill credentials. Login forms exist on arbitrary domains, so the extension cannot pre-declare a fixed set of URLs.

## Screenshots

Use the existing images in `img/chrome/`:
1. `button.png` — Shows the extension toolbar button
2. `menu.png` — Shows the right-click context menu with autofill options

TODO: Create additional screenshots:
3. Options page showing connection settings
4. Autofill in action on a login form (1280x800 recommended)

## Icon

Use `icons/icon128.png` (128x128, already exists)
