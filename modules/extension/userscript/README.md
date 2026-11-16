# Userscripts on iOS: KeeWebX Connect 0.5.5

Authorize your unlocked KeeWebX app once, then select matching accounts beside
login fields on any website. Finding accounts and testing the connection never
open a page. Forms are filled only after an explicit account selection and are
never submitted automatically.

[Install keewebx-connect.user.js](https://raw.githubusercontent.com/gynet/keewebx/userscript-v0.5.5/modules/extension/userscript/keewebx-connect.user.js)

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
   Navigating to another website does not require another authorization.
   If a connection test times out, use the recovery action below.

For a self-hosted app, save its complete HTTPS URL in **Connection → KeeWebX
address**, then authorize that app. **Test connection** checks it without
reading credential fields. If the test times out, **Reconnect to existing tab**
opens or reuses a lightweight connection page and immediately checks the original
authorized app through native messages. This action does not open a second vault.
When the page confirms the existing app replied, choose **Back to website** and
find accounts. Keep this small connection page open while using the restored link.

## Upgrade from 0.5.0–0.5.4

Replace the one installed script. Save database changes, update/reload the existing
KeeWebX app, and reload the login website so both show **Connect 0.5.5**. This
release requires the updated app policy and app-side receiver. The script checks
that the app supports website-scoped matching before listing or filling. If it
asks for an app update, refresh the existing app after saving database changes.
The saved entries, signing identity and native vault permission are retained.

Keep a recovery connection page open while using its native link. Closing it
ends that link. If the private mailbox also fails to reply, an explicit
**Reconnect to existing tab** is needed to restore it; automatic recovery after
closing the relay has not been established on iOS. Use Safari's tab switcher if
**Back to website** does not switch tabs; keep the connection page open.

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

The app controls account matching. It binds each website connection to its
HTTPS origin, returns only matching account summaries, and binds temporary
entry handles to that site. Changing a URL or search query cannot enumerate
other websites through this connection. Before returning fields, the app checks
permissions, the current entry URLs, site binding, vault state and handle lifetime
again. The userscript displays the app's suggestions and checks the live page
and form destination; it contains no separate account-domain matcher.

The app treats a hostname and its leading `www.` alias as the same website. For example, an entry saved as `uscardforum.com` can be selected on
`https://www.uscardforum.com/login`. Matching still checks ports and excludes
unrelated hostnames, other subdomains, and URL user information. This account
matching rule does not change the exact message origin or form destination.
Primary and additional saved URLs follow the same app policy.

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
bun test modules/extension/userscript/tests/native-connect.test.ts modules/extension/userscript/tests/connect-mailbox.test.ts modules/extension/userscript/tests/connector-return.test.ts modules/vault/tests/website-matching.test.ts
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
Manual switching to the existing app may be needed. See the
[hidden iframe investigation](docs/iframe-relay.md) for the tested partitioning
limitation of embedding the relay instead of retaining its tab.
