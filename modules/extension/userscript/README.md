# Userscripts on iOS: KeeWebX Connect 0.4.5

The experimental Connect userscript lets login websites reuse one authorized
KeeWebX app tab through the Userscripts manager's private GM storage. Authorize
the app once, then tap the key beside a login field and select an account.
Normal lookup and fill keep you on the website and do not open another tab.
The default flow has no helper page, tab discovery, BroadcastChannel or
per-website pairing.

Download [keewebx-connect.user.js](https://raw.githubusercontent.com/gynet/keewebx/userscript-v0.4.5/modules/extension/userscript/keewebx-connect.user.js).

Version 0.4.5 adds event-driven request and reply delivery in Userscripts'
content execution environment. A change to this script's own storage keys
immediately triggers the existing signed GM reader, so delivery does not
have to wait for a background polling timer. Other managers or environments
without that event API retain bounded polling. Notification payloads never
authorize a connection and are not used as protocol data.

Replace the installed script, save database changes, then reload **both the
KeeWebX app and login website** so both run Connect 0.4.5. Unlock the app and
use its existing authorization; if the app asks to resume its saved permission,
choose Authorize Connect in that same tab. Keep one installed copy. This
update changes the app-side receiver, so updating only the website client
cannot enable event delivery in an older running app script.

The panel shows the running version. Test connection displays its stage and
elapsed seconds and has a 15-second total budget while the page can execute.
Storage events are not a guarantee that iOS will wake a fully frozen process;
native iPhone behavior remains to be confirmed.

## Install and authorize once

1. Open the script link above in **Safari**, then open Safari's extension menu,
   choose **Userscripts** and tap **Tap to Install**. Seeing source code is
   expected. Allow access to the raw.githubusercontent.com page if prompted.
   Open the **Userscripts** app once to choose its script directory if needed.
   As a manual alternative, save the `.user.js` file to that directory.
   Keep one installed Connect script; disable older diagnostic probes.
   Enable Userscripts in Safari and allow it on KeeWebX and the login websites.
   Use the same installed script on all of them so they share its private storage.
2. Open your KeeWebX app tab (`https://keewebx.app/app` by default) and unlock
   a database. Open the script's **KeeWebX Connect** panel, choose
   **Authorize Connect**, then select **Allow** for account listing in the
   KeeWebX dialog. This one global grant lets all login websites use this tab;
   another website does not need another Connect authorization.
3. Return to a login website. Focus a username or password field, tap the key
   and select a matching account from **Accounts**. Use **Find accounts** to
   retry. The script fills the form without submitting it.

For a self-hosted app, first enter its complete HTTPS URL in the script's
**Connection → KeeWebX address** field on a website and choose **Save address**.
Authorize that app tab once. If you need to open an app for setup, explicitly
choose **Open KeeWebX** in **Connection**. Normal lookup and fill never open it
automatically. The desktop extension's settings do not configure this script.

When upgrading from 0.3.x, replace the existing script file, close old helper
pages, and reload app and website tabs once after saving database changes.
Authorize the intended app tab using the steps above. Reinstalling Userscripts
or deleting its private identity is unnecessary.

## Use and recovery

Keep the authorized KeeWebX tab open. Only accounts matching the website's
exact HTTPS origin are offered, and reading credential fields requires an
explicit account selection. After navigation, switching away or an expired
selection, use **Find accounts** again. A locked database must be unlocked in
KeeWebX.

If a request times out, visit the original authorized app tab so Safari can
resume it, unlock if necessary, then return to the website and retry.
**Connection → Test connection** checks the authorized tab without filling.
Do not reinstall or rename the script as a normal recovery step.

The app's **Disconnect** button stops its queue handling and clears its selected
route. Remove the script's permission in KeeWebX's browser extension settings
to revoke vault access. After disconnecting, revoking access or intentionally
selecting another app tab, authorize the intended app again.

This remains an experimental workflow. Native iOS long suspension, screen
lock, memory pressure and standalone Home Screen PWAs remain unverified.
The script cannot force iOS to resume a suspended tab or guarantee automatic
OS wakeup.

## Storage and transport

The installer requests `GM.getValue`, `GM.setValue`, `GM.deleteValue`,
`GM.listValues`, `GM.getTab` and `GM.saveTab`.

Persistent manager-private data consists of the signing identity, settings
and approved route: a public host ID, app endpoint and public key. The manager's
`getTab`/`saveTab` state and a mirrored sessionStorage ID preserve the app tab's
host identity when either supported storage path is temporarily unavailable.
The host ID is public routing metadata, not a credential or authorization.
Connect session encryption keys stay in memory.

Transient signed request/reply records carry routing metadata and Connect
messages. Credential payloads are encrypted with the existing Connect protocol;
plaintext usernames, passwords and database contents are not stored in GM
storage. Queue records are deleted after consumption or expiry; cleanup runs
while the participating scripts can execute. There is no credential relay server.

When Userscripts exposes its WebExtension storage notifications in the content
world, requests and replies trigger immediate reads through the original GM
APIs. The listener examines only key names within the exact installed script
filename namespace and ignores other storage areas and event values. Existing
signature, identity, origin and lifetime validation remains authoritative.
Listeners are removed on pause, completion or cancellation.

Fallback polling remains about 500 ms when the app is idle, 60 ms during
activity, and 80 ms for a website's pending reply. A website has no idle reply
polling. Notifications and timers cannot guarantee execution during OS suspension.

## Build and verification

Build the installer from the repository root with Bun 1.3.11:

```sh
bun modules/extension/userscript/build-connect.ts
```

After building the app and installing Playwright Chromium, serve the app in
a separate terminal and run the GM transport acceptance:

```sh
KEEWEBX_E2E_PORT=8085 bun e2e/serve-app.ts
```

```sh
KWX_APP_SERVER=http://127.0.0.1:8085 node modules/extension/userscript/tests/gm-connect.mjs
node modules/extension/userscript/tests/form-guards.mjs chromium webkit
```

Install Playwright WebKit before requesting the WebKit form checks. The GM
acceptance uses the bundled installer, a real encrypted KDBX and the New
interface's native permission dialog, with simulated manager storage and
injection. Desktop checks do not verify native Userscripts or iOS suspension.

The [release report](docs/release-report.md) separates the current architecture
from historical 0.3.x results. The older `tests/connect.mjs`,
`tests/relay-transport.mjs` and [discovery design](docs/tab-discovery.md)
describe the old helper architecture. Scripts under `diagnostics/` are older
transport probes, not the 0.4.0 Connect installer; keep them disabled during use.

To exercise real Chromium extension storage and isolated content execution, use
`KWX_NATIVE_STORAGE=1` with the same `gm-connect.mjs` command. Add
`KWX_WITHHOLD_POLLS=1` to withhold the transport's 60/80/500 ms polling callbacks
while keeping actual WebExtension storage notifications enabled. This fixture
uses native storage APIs with a Userscripts-shaped adapter; it does not certify
the native iPhone extension.
