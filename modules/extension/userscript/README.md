# Userscripts on iOS: KeeWebX Connect 0.4.1

The experimental Connect userscript lets login websites reuse one authorized
KeeWebX app tab through the Userscripts manager's private GM storage. Authorize
the app once, then tap the key beside a login field and select an account.
Normal lookup and fill keep you on the website and do not open another tab.
The default flow has no helper page, tab discovery, BroadcastChannel or
per-website pairing.

Download [keewebx-connect.user.js](https://raw.githubusercontent.com/gynet/keewebx/userscript-v0.4.1/modules/extension/userscript/keewebx-connect.user.js).

Version 0.4.1 fixes storage serialization compatibility and the Connection
controls. Test connection shows progress and always has a deadline. Open
KeeWebX contacts the authorized app instead of navigating its unlocked page.
After updating, reload the app and login website tabs once so that both use
this version; an old app script is detected before an incompatible request.

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
`getTab`/`saveTab` state preserves the app tab's host ID across reloads.
Connect session encryption keys stay in memory.

Transient signed request/reply records carry routing metadata and Connect
messages. Credential payloads are encrypted with the existing Connect protocol;
plaintext usernames, passwords and database contents are not stored in GM
storage. Queue records are deleted after consumption or expiry; cleanup runs
while the participating scripts can execute. There is no credential relay server.

While enabled, the app polls its GM request keys about every 500 ms when idle
and every 60 ms after recent activity. A website polls only its pending reply
key, about every 80 ms; it has no idle reply polling. These intervals do not
guarantee execution while Safari suspends a tab.

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
