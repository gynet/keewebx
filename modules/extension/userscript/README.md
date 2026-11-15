# Userscripts on iOS: Connect and transport diagnostics

## Native Connect (experimental)

Download [keewebx-connect.user.js](https://raw.githubusercontent.com/gynet/keewebx/master/modules/extension/userscript/keewebx-connect.user.js) for account lookup
and explicit autofill using native `window.postMessage` plus a same-origin
`BroadcastChannel` relay for independent app tabs. This installer
uses the existing encrypted Connect protocol and does not bundle post-robot.
The files under `diagnostics/` are separate transport tests, not the Connect
installer.

### Install and authorize

1. Open the **Userscripts** app once and choose its script directory. Disable
   the older diagnostic probes. Download `keewebx-connect.user.js` above and
   save it into that directory with **Save to Files**, keeping the `.user.js`
   filename. Enable Userscripts in Safari's extension settings and allow it
   on KeeWebX and the login website. Use the same installed script file on both sites;
   its private storage holds the shared Connect identity and app address.
   Save database changes before reloading a page to activate a new install.
2. On the login website, click a username or password field, open
   **KeeWebX Connect**, and choose **Connection**. The default app address
   is `https://keewebx.app/app`. For another deployment, enter its complete
   HTTPS app URL in **KeeWebX address** and click **Save address**.
3. Tap the key icon or **Open KeeWebX**. A small `connect.html` page first
   looks for cooperating KeeWebX tabs. Keep the connection page open. Its
   discovery messages contain no vault credentials.
4. If existing app tabs respond, visit the tab whose unlocked database you
   want to use. Its script panel shows the requesting website's exact HTTPS
   origin. Choose **Connect this tab**, approve account listing in KeeWebX,
   and wait for **Authorized**. Only the app that wins this confirmation is
   selected; another app's late confirmation cannot replace it.
5. If no app responds within the discovery window, the connection page
   navigates to the normal app. Open and unlock a database there, then choose
   **Authorize Connect** in the script panel and approve account listing.
   For self-hosting, deploy the built `connect.html` alongside the app.
6. Choose **Back to site**, or select the original website tab if Safari
   declines the focus request. Focus a login field and tap the key. Select
   a matching account from **Accounts**; use **Find accounts** to retry a
   lookup. **Filled** confirms success. The script does not submit the form.

Authorization is retained for the script identity. Normal lookups use fresh
encrypted sessions without repeating the initial approval. Renaming or
reinstalling the script can change its storage identity and require setup
again. A locked database must be unlocked in KeeWebX.

### Link a website from the app

You can also start in the configured KeeWebX app tab. Unlock the database
and complete **Authorize Connect**, then enter the website's HTTPS address
under **Or open a login website here** and click **Open linked website**.
In the new website tab, choose the login field and use **Find accounts**.
The app's **Disconnect** button removes its current website association.

Each helper keeps one selected app and one linked website window. Original
app tabs can be discovered without a prior opener relationship; they must
already run this installed Connect script and share the app's origin and
storage partition. Their original document, database and unlock state remain
in place. Keep both the selected app and connection page open. Closing or
reloading either can require discovery and confirmation again.

The website must retain its relationship with its helper. `noopener`,
Cross-Origin-Opener-Policy and browser isolation can break it. A previously
related named window is reused when the browser permits. This is not a
browser-wide tab enumeration API. A change to a different website origin
requires fresh discovery and confirmation. See the [discovery design](docs/tab-discovery.md)
for the transport, PWA boundaries and remaining native-device test gaps.

Only accounts matching the website's exact HTTPS origin are offered. Each
field read requires an explicit account selection. After switching away,
navigating, locking, restoring a cached page, or an expired selection, use
**Find accounts** again. **Test connection** in the website's **Connection**
tab checks the native bridge without filling a form.

This is an experimental, foreground-assisted workflow. Desktop checks and
individual phone results do not establish reliable long-term hidden-tab
execution, automatic wakeup, or support for every iOS/Safari configuration.

### Privacy and connection recovery

The script stores its Connect signing identity and configured app address in
Userscripts' script-private storage. Session encryption keys stay in memory.
It does not store database contents, usernames or passwords, and it does not
send credentials to a relay server. Remove the script's permission in KeeWebX
to revoke its vault access; **Disconnect** only clears the current tab link.

If lookup times out, check that the selected app is open and unlocked and
that its connection page is still open. Use **Connection → Open KeeWebX**
to reach the connection page. **Find app tabs again** restarts discovery;
confirm in the intended app, return to the site and **Find accounts** again. Do not reinstall or rename the script
as a normal reconnection step. Save unsaved database changes before any reload.

### Verification

Automated Chromium acceptance uses the actual installer, a real encrypted
KDBX fixture, the New interface, its native permission dialog and encrypted
Connect handshake. Only Userscripts' GM storage/injection is simulated; it
does not load the iOS manager. It checks explicit selection, exact-origin
filtering, username/password fill, no form submission, navigation invalidation
and absence of vault credentials in persistent script storage. Independent-tab
acceptance opens two original app tabs with distinct databases, confirms only
one, verifies that the other is never read, rejects its delayed confirmation,
and checks that locking the selected app never falls back to another vault.

Sixteen Chromium/WebKit form checks cover destination replacement, navigation,
expiry during input handlers and native form events. Protocol tests separately
cover encryption, nonce/key validation and suppression of credential logs.
These desktop checks do not certify the complete iPhone autofill workflow.

The earlier post-robot diagnostic received user-reported 2–3 ms replies from
a hidden, unfocused KeeWebX page in iPhone Safari with Userscripts. That result
supports linked-window message delivery at that moment; it did not access a
vault or establish reliable long-term background operation.

Build the native installer from the repository root with Bun 1.3.11 (also
pinned in the installer acceptance and release jobs):

```sh
bun modules/extension/userscript/build-connect.ts
```

After building the app and installing Playwright Chromium, run the real-app
acceptance with a static server in a separate terminal:

```sh
KEEWEBX_E2E_PORT=8085 bun e2e/serve-app.ts
```

```sh
node modules/extension/userscript/tests/connect.mjs
node modules/extension/userscript/tests/form-guards.mjs chromium webkit
node modules/extension/userscript/tests/relay-transport.mjs chromium webkit
```

The acceptance covers both app-first and website-first setup and preserves
the same unlocked app document during related named-window reuse. Set
`KWX_APP_SERVER` for another local server. Install WebKit before requesting
the WebKit form checks. Browser reports identify mocked GM and native iOS gaps.

## Older post-robot diagnostic (0.2.1)

Install **`diagnostics/post-robot-probe.user.js`** to test event-driven
cross-origin requests with the actual bundled `@krakenjs/post-robot` 11.0.1.
The script does not read a database, passwords, form fields, or vault unlock
state. It has no GM grants or runtime CDN dependencies.

1. Stop and disable the older **KeeWebX background connection probe** so its
   polling and controls do not affect the new experiment.
2. Install the new script in Userscripts, and allow it on KeeWebX and the
   chosen test website. Save database changes before the one-time page reload
   needed to inject a newly installed script.
3. In the original `https://keewebx.app/app` tab, open **Post-robot test**.
   Leave the test URL as `https://example.com/` and tap **Open linked website**.
4. In the newly opened website tab, open **Post-robot test** and tap
   **Test background reply**. This action sends messages without requesting tab focus.
5. Stay on the website. Repeat after one and five minutes without visiting
   KeeWebX in between. Note the elapsed time, `visible`/`hidden`, and page
   marker shown in the result. A timeout is a test result, not a cue to
   repeatedly switch tabs. A marker is not proof of an unlocked vault.

The initial association opens a tab; subsequent test buttons do not open or
focus windows. Both documents must run the script, and the website must retain
its `window.opener` relationship. Independent tabs cannot be discovered this
way. Address-bar cross-site navigation, `noopener`, or site isolation policies
can break the association. Following an ordinary link may preserve it.

The app-side **Disconnect** button rejects future requests without closing the
website. Refreshing KeeWebX deliberately loses the association. Delayed or
expired replies must not count as successful fresh requests. No polling or
heartbeat was added by this probe; post-robot uses its own request timeout and
window-closure detection timers.

Build the standalone installer with:

```sh
node modules/extension/userscript/build-post-robot-probe.mjs
```

Vendored distribution and license hashes are verified by the builder. Npm
tarball provenance/integrity is recorded in `vendor/post-robot-provenance.json`;
the installer includes the Apache-2.0 license. Authored source is in
`src/post-robot-probe.js`.

Actual post-robot round trips, linked cross-origin navigation, missing/revoked
associations, app reload and delayed/expired messages passed in desktop
Chromium, desktop WebKit, and a real Chromium isolated content-script world:

```sh
node modules/extension/userscript/tests/post-robot-probe.mjs chromium
node modules/extension/userscript/tests/post-robot-probe.mjs webkit
node modules/extension/userscript/tests/post-robot-probe.mjs chromium-extension
```

The desktop fixtures remained `visible`. The delay test intercepts native
MessageEvents temporarily; it is not an OS suspension test. These results do
not prove iPhone/Userscripts background replies, automatic process wakeup, or
an unlocked vault. The user-reported iPhone transport result is recorded above;
complete native iPhone autofill remains unverified.

## Older GM mailbox probe

This is a diagnostic prototype, **not KeeWebX Connect or an autofill release**.
It tests whether a Userscripts instance on another website can exchange a
random challenge with a Userscripts instance in an existing KeeWebX tab using
the manager's script-private `GM.*` storage. It never accesses the vault,
Connect protocol, usernames, passwords, or page form values. It cannot force
iOS to resume a suspended tab.

## Install and test on an iPhone

1. Install `diagnostics/background-probe.user.js` in **Userscripts**. Keep the
   same installed file/name for KeeWebX and other sites: Userscripts scopes
   stored values by installed filename.
2. Allow Userscripts on `https://keewebx.app/app` and a website to test.
3. In the original KeeWebX tab, tap **KeeWebX probe**, then **Start on this tab**.
4. Switch to a website. Tap **KeeWebX probe**, then **Test connection**.
5. A reply reports elapsed time and whether the KeeWebX document was visible
   or hidden when replying. If it does not reply after eight seconds, switch
   back to the **original** KeeWebX tab and return to the website. The queued
   request expires after two minutes.
6. Repeat after leaving KeeWebX in the background for one and five minutes,
   and after locking/unlocking the phone. Note iOS, Safari, and Userscripts
   versions with the observed results. A successful immediate reply does not
   prove reliable long-term background operation.

Tap **Stop probe** in KeeWebX to stop polling. Disable/delete the userscript
when finished. No production application files or settings are changed.
Expired request/reply records are pruned while the app-side probe is running.
Closing a page may leave a small expired record until that cleanup runs; the
manager owns the script's storage.

## What this establishes

The experiment deliberately separates **message transport** from **vault
access**. It can establish whether GM storage works across sites in the
installed manager, whether a hidden app-side script replies, and whether a
queued request survives a foreground switch. It does not establish that the
app's protocol handler or an unlocked vault remains usable, and no passwords
are involved. Delayed replies must not be interpreted as permission to fill.

The production design would still need the existing encrypted Connect
handshake, identity approval, serialized transactions, expiry fencing,
document/origin binding and explicit credential selection. App locks and
access revocation must continue to reject requests. A pure GM mailbox has no
documented API for waking or focusing an arbitrary old tab.

The probe sends only random IDs, timestamps and document visibility over GM
storage; it needs no server relay, network permission or Apple Developer
Program membership. Polling is 500 ms while the explicitly enabled app-side
probe is running, and only during an explicitly requested client test. It is
an experiment, not a recommended permanent background polling strategy.

Official manager API/source:

- https://github.com/quoid/userscripts/tree/release/4.x.x#api
- https://github.com/quoid/userscripts/blob/release/4.x.x/src/ext/content-scripts/api.js

## Automated checks

With the repository's Playwright dependencies and browsers installed, run:

```sh
node modules/extension/userscript/tests/background-probe.mjs chromium
node modules/extension/userscript/tests/background-probe.mjs webkit
```

Four scenarios passed in each desktop engine: cross-origin reply/cleanup,
explicit app-tab ownership, recovery after a simulated GM interruption, and
rejection of wrong-owner/expired replies. The harness supplies a simulated
GM store; it does **not** run the Userscripts extension, suspend an iOS
process, open a real vault, or prove automatic tab wakeup. Native iPhone
results remain unverified.
