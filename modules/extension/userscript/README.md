# Userscripts on iOS: KeeWebX Connect 0.5.2

Authorize your unlocked KeeWebX app once, then select matching accounts beside
login fields on any website. Finding accounts and testing the connection never
open a page. Forms are filled only after an explicit account selection and are
never submitted automatically.

[Install keewebx-connect.user.js](https://raw.githubusercontent.com/gynet/keewebx/userscript-v0.5.2/modules/extension/userscript/keewebx-connect.user.js)

## Install and use

1. Open the installer in Safari. Open Safari’s extension menu, choose
   **Userscripts**, then **Tap to Install**. JavaScript source on the download
   page is expected. Alternatively save the `.user.js` file to the script
   directory selected in the Userscripts app. Keep one installed Connect script
   and disable old diagnostic scripts. Allow Userscripts on KeeWebX and your
   login websites.
2. Open your existing `https://keewebx.app/app` tab and unlock a database. In the
   script’s key panel, choose **Authorize Connect**, then **Allow** account
   listing in KeeWebX. That one grant is shared across websites.
3. On a login website, focus a username or password field, tap the key, and
   select a matching account. Use **Find accounts** to refresh the list.
   Navigating to another website does not require another authorization or
   another connection page.

For a self-hosted app, save its complete HTTPS URL in **Connection → KeeWebX
address**, then authorize that app. **Test connection** checks it without
reading credential fields. **Open connection page** is an optional, explicit
native-window setup action; normal lookup and recovery do not use this button.

## Upgrade from 0.5.0 or 0.5.1

Replace the one installed script. Save database changes, then reload the
existing app and website once so both run **Connect 0.5.2**. Both the app receiver
and website client must run the updated lifecycle and recovery checks. Existing
signing identity and vault permission are retained. Close obsolete connection pages; they are not
required for normal filling. Do not repeatedly open a connection page to retry.

Replace the same filename in Userscripts. A renamed copy has a separate private
storage namespace and cannot share the original script's authorization. Keep
only one enabled Connect installation.

## Recovery and permissions

Keep the authorized app open. If it stops responding, visit that same tab,
unlock if needed, then return to the website and retry. A pending connection
check or account lookup can continue while you visit the app. Switching away
during an actual credential fill cancels that fill. Navigation, closing the
panel, changed form targets and expired sessions also cancel pending fills.

One website protocol session uses the app’s native port at a time. A fresh
lookup replaces obsolete account handles. A locked app rejects requests; an
unlocked app reuses the existing grant. **Disconnect** in the app stops serving
requests. Remove the script’s vault permission in browser extension settings to
revoke database access.

## Transport and security

0.5.0 retained a window reference only in the current website document and
opened another page when that reference was absent. Navigation can invalidate
window associations even while an old window reports that it is open. The new
flow never treats opening another page as automatic recovery.

A live native window connection uses `postMessage` and same-origin
`BroadcastChannel`. Without that association, signed Connect envelopes use a
private Userscripts mailbox addressed to the same selected app. Both paths use
the same host, single-session ownership, replay checks, exact website origin,
request deadline and encrypted Connect protocol. This is a transport fallback,
not a second authorization flow. There is no remote relay server.

The script requests `GM.getValue`, `GM.setValue`, `GM.deleteValue`,
`GM.listValues`, `GM.getTab` and `GM.saveTab`. Persistent storage contains the
signing identity, app address and public routing metadata. Short-lived mailbox
records contain signed routing metadata and encrypted credential messages,
never plaintext usernames or passwords. Records are consumed or expired;
cancellation stops response readers even when cleanup fails. Native storage
notifications wake readers where available, with bounded polling and app-return
checks otherwise. The app’s lock policy is unchanged.

Changing the selected app uses the browser's Web Locks API to prevent competing
tabs or delayed cleanup from replacing a newer choice. Current Safari supports
this API. If it is unavailable or blocked, authorization reports an error and
does not make an unsafe selection.

## Verification

Build with Bun 1.3.11:

```sh
bun modules/extension/userscript/build-connect.ts
bun test modules/extension/userscript/tests/native-connect.test.ts modules/extension/userscript/tests/connect-mailbox.test.ts
modules/extension/node_modules/.bin/tsc --project modules/extension/userscript/tsconfig.json
```

After building the app and installing Playwright Chromium, serve it in another
terminal and run the real browser acceptance:

```sh
KEEWEBX_E2E_PORT=8085 bun e2e/serve-app.ts
```

```sh
KWX_APP_SERVER=http://127.0.0.1:8085 node modules/extension/userscript/tests/native-connect.mjs
```

Run the same acceptance without optional storage notifications:

```sh
KWX_DISABLE_STORAGE_EVENTS=1 KWX_APP_SERVER=http://127.0.0.1:8085 node modules/extension/userscript/tests/native-connect.mjs
```

The fixture uses the exact installer in Chromium extension isolation, real
window messages, BroadcastChannel and extension storage through a small GM API
adapter, a real encrypted KDBX and the native permission dialog. It tests both
independent website tabs and repeated cross-origin navigation within one tab,
with no new page during normal lookup or connection tests. It also audits
signed, encrypted native and mailbox traffic.

See the [release report](docs/release-report.md) and
[0.5.2 audit](docs/audit-0.5.2.md). Desktop browser results do not
certify the installed iOS Userscripts manager. Native phone acceptance, long
suspension and standalone Home Screen PWA communication remain unverified.
Manual switching to the existing app may be needed.
