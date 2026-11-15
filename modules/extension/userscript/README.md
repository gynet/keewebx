# Userscripts on iOS: transport experiments

## Post-robot probe — current experiment

Install **`diagnostics/post-robot-probe.user.js`** to test event-driven
cross-origin requests with the actual bundled `@krakenjs/post-robot` 11.0.1.
The script does not read a database, passwords, form fields, or vault unlock
state. It has no GM grants or runtime CDN dependencies.

1. Stop and disable the older **KeeWebX background connection probe** so its
   polling and controls do not affect the new experiment.
2. Install the new script in Userscripts, and allow it on KeeWebX and the
   chosen test website. Save database changes before the one-time page reload
   needed to inject a newly installed script.
3. In the original `https://keewebx.app/app` tab, open **Post-robot 测试**.
   Leave the test URL as `https://example.com/` and tap **关联并打开网站**.
4. In the newly opened website tab, open **Post-robot 测试** and tap
   **测试后台回包**. This action sends messages without requesting tab focus.
5. Stay on the website. Repeat after one and five minutes without visiting
   KeeWebX in between. Note the elapsed time, `visible`/`hidden`, and page
   marker shown in the result. A timeout is a test result, not a cue to
   repeatedly switch tabs. A marker is not proof of an unlocked vault.

The initial association opens a tab; subsequent test buttons do not open or
focus windows. Both documents must run the script, and the website must retain
its `window.opener` relationship. Independent tabs cannot be discovered this
way. Address-bar cross-site navigation, `noopener`, or site isolation policies
can break the association. Following an ordinary link may preserve it.

The app-side **撤销关联** button rejects future requests without closing the
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
an unlocked vault. Native iPhone results remain unverified.

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
