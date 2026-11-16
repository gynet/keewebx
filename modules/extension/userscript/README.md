# Userscripts on iOS: KeeWebX Connect 0.5.0

Connect reuses an unlocked KeeWebX tab to fill matching login forms. Authorize
that app once for all websites. Select an account explicitly; forms are never
submitted automatically.

[Install keewebx-connect.user.js](https://raw.githubusercontent.com/gynet/keewebx/userscript-v0.5.0/modules/extension/userscript/keewebx-connect.user.js)

## Install and connect

1. Open the installer link in **Safari**, open Safari’s extension menu, choose
   **Userscripts**, then **Tap to Install**. Seeing JavaScript source is expected.
   If needed, open the Userscripts app once to choose a script directory. You can
   also save the `.user.js` file there manually. Keep only one installed Connect
   script and disable older diagnostic probes. Allow Userscripts on KeeWebX and
   your login websites.
2. In your existing `https://keewebx.app/app` tab, unlock a database. Open the
   script’s key panel, choose **Authorize Connect**, and **Allow** account listing
   in KeeWebX. This grants this installed script access across websites; each
   website still receives only accounts matching its exact HTTPS origin.
3. On a login website, focus a username or password field and tap the key.
   The first connection opens a small **KeeWebX Connect** page. Keep it open and
   choose **Back to website** (or select the original website tab in Safari).
4. Choose **Find accounts**, then select your account. Subsequent lookups on that
   website reuse the connection page and the same unlocked app, without another
   authorization. A different website establishes its own connection page.

**Connection → Test connection** checks the selected app without reading fields.
**Connect to KeeWebX** opens or focuses the connection page, preserving the
original vault document. It does not open or reload your database.

For a self-hosted app, save its complete HTTPS URL in **Connection → KeeWebX
address** first. That deployment must serve `connect.html` beside the app URL.
The browser extension’s settings are separate from this script’s settings.

## Upgrade from 0.4.x

Replace the installed script, save database changes, and reload the app and
website once so both show **Connect 0.5.0**. Authorize the intended app tab once.
The saved signing identity and native vault permission are reused; deleting
Userscripts data is unnecessary. Old GM queue receivers cannot serve this new
native-message transport. Close obsolete connection and diagnostic pages.

## Recovery and revocation

Keep the authorized app and connection page open. If a connection times out,
visit the existing app, unlock if needed, return to the website, and choose
**Find accounts** again. If you closed the connection page, use **Connect to
KeeWebX** to reopen it. Requests stop at their deadlines instead of waiting
indefinitely. A connection test has a 15-second total budget while it can run.

Switching away, changing the website, closing the account panel, selecting
another app, or locking the database invalidates a pending fill. A fresh lookup
starts a new encrypted session. Only one website protocol session is active at
a time; an old account list must be refreshed after using another website.

The app panel’s **Disconnect** stops serving requests and clears its selected
route. Revoke the script’s vault permission in KeeWebX’s browser extension
settings to remove database access.

## Transport and security

Version 0.5.0 replaces the GM request/reply queue with native `postMessage`
between the website and connection page, then same-origin `BroadcastChannel`
between that page and the selected app. There is no relay server, periodic GM
polling, tab-discovery list, or per-website approval dialog.

The script requests `GM.getValue`, `GM.setValue`, `GM.deleteValue`,
`GM.getTab` and `GM.saveTab`. The tab APIs preserve ownership across reload
without allowing duplicated sessionStorage to select another app. These store the signing identity, app address and selected app’s public routing
metadata. Requests, replies, account lists and credential fields are never
written to manager storage. The connection page forwards the existing encrypted
Connect payloads and cannot decrypt credential fields.

Native window identity and exact origin are pinned during setup. Messages are
signed and bound to the selected app, website document, session, operation and
deadline. Replayed or altered messages are rejected. Fields are read only after
an explicit account choice and the target form, origin and vault permission are
checked again before filling. The app’s normal lock policy remains in force.

## Verification

Build with Bun 1.3.11:

```sh
bun modules/extension/userscript/build-connect.ts
bun test modules/extension/userscript/tests/native-connect.test.ts
modules/extension/node_modules/.bin/tsc --project modules/extension/userscript/tsconfig.json
```

After building the app and installing Playwright Chromium, serve it in another
terminal and run the real browser acceptance:

```sh
KEEWEBX_E2E_PORT=8085 bun e2e/serve-app.ts
```

```sh
KWX_APP_SERVER=http://127.0.0.1:8085 node modules/extension/userscript/tests/native-connect.mjs
node modules/extension/userscript/tests/form-guards.mjs chromium webkit
```

The browser fixture uses the exact installer in a real Chromium extension’s
isolated world, native window messages and BroadcastChannel, native extension
storage behind a small GM API adapter, a real encrypted KDBX and the app’s native
permission dialog. It is not the installed iOS Userscripts manager. Native
phone acceptance, long suspension and standalone Home Screen PWA communication
remain unverified; manual switching to the existing app may be necessary.

See the [release report](docs/release-report.md). Older GM and discovery tests
and documents are historical; `tests/native-connect.mjs` is the current end-to-end
entry point.
