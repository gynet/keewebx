# Userscripts on iOS: KeeWebX Connect 0.6.22

Authorize the unlocked KeeWebX App once, then choose matching accounts beside
login fields on other websites. Each trusted lookup or connection test gets a fresh direct MessagePort
to the same original App. A temporary connection page closes itself after the website verifies App readiness. The website
then verifies the App signature and completes the encrypted protocol handshake.
Choose an account to fill, or enable the optional single-match shortcut below.
Forms are never submitted automatically.

[Install in Safari](https://keewebx.app/connect-port/keewebx-connect.user.js?v=0.6.22)
· [Immutable source](https://raw.githubusercontent.com/gynet/keewebx/userscript-v0.6.22/modules/extension/userscript/keewebx-connect.user.js)
· [Architecture and lifecycle](docs/messageport-connect.md)
· [Current connection flow and diagrams](docs/connection-architecture.md)
· [State and recovery audit](docs/state-and-recovery.md)
· [0.6.22 release notes](docs/release-0.6.22.md)
· [0.6.11 transport acceptance](docs/release-0.6.11.md)

## Install or upgrade

1. Open the installer in Safari, open the Userscripts extension menu, and choose
   **Tap to Install**. Update the existing `keewebx-connect.user.js` filename.
   Keep one enabled Connect script; disable MessagePort Lab and old probes.
   Allow Userscripts on KeeWebX and your login websites, and allow the temporary
   connection popup when Safari requests permission.
2. Update the existing script, save pending database edits, and reload the original
   App and the login website to load **Connect 0.6.22** at both ends. The App reload
   replaces old receiver listeners; it does not open another App tab.
   Existing database entries, signing identity and stored App address are retained.
3. Unlock the original App. An existing grant resumes in the sole main New App
   after a reload; its saved database permissions still apply. For first setup,
   open the Connect key panel and choose **Authorize Connect**, then approve
   account listing in the native permission dialog. Explicit disconnect still
   requires authorization again.
4. On a login website, focus a username/password field, tap the key, and select
   a matching account. Each new lookup or connection test opens a small
   connection page, finds the original App, and automatically closes the page
   after handing off the port. The website verifies the App signature before
   using its connection. One lookup, account selection and fill share that port;
   the next lookup replaces it. App authorization is retained.

## Everyday use

In the App, drag the Connect key to keep it clear of the toolbar. Its position is
remembered on that App origin and kept inside the viewport after resizing. A tap
still opens the panel. With the key focused, arrow keys move it (Shift moves
farther). Website field icons stay anchored
to their login fields.

The key appears beside a recognized visible login field. Search boxes, newsletter
fields, verification codes and new-password forms do not display it. Dynamic login
forms are detected when they open; hiding or removing the form hides the key.
The KeeWebX App keeps its own Connect settings entry.

Tap the key to check the connection immediately. If you have not selected a login
field, the panel runs **Test connection** automatically and displays the result.
It opens a temporary handoff page and replaces any previous physical port.
The page closes after signed App readiness is verified. This check does not
list accounts or read credential fields.
After selecting a login field, tapping the key keeps the existing account lookup
behavior. Merely loading a page or detecting a form does not start a connection.

In **Connection**, enable **Fill a single matching account automatically** to skip
selection when exactly one account matches a trusted lookup. This optional switch
is off by default and saved in the script's private preferences. Reloaded websites
read the saved choice. Multiple matches always show the account list; no match
never fills. Disabling it restores manual selection. The App still matches URLs
and checks current vault permissions before any fields are returned. Filling never
submits the form and never happens just because a page loads.

The panel uses shared Preact components from
[`ui-kit/connect`](../../ui-kit/src/connect/README.md). Presentation, account
summaries and callbacks are independent of GM and browser-extension APIs; the
Userscript provides storage, trusted-event handling and login-field positioning.

A renamed script has a separate manager storage namespace and cannot reuse the
original filename's identity. For self-hosting, publish the built `connect-port/`
directory beside the App assets and save the App's full HTTPS address in the
script's Connection tab before authorizing it.

## Recovery and lifecycle

The handoff worker finds the explicitly authorized App boot. A browser-held
main-window lock does not select a Connect destination. Port signatures and the
encrypted protocol still enforce identity, website origin and vault permissions.
Websites refresh saved authorization on return and on manager change events;
connection actions wait until that read completes. A failed settings refresh
blocks new setup while an existing signed connection can finish its request.
Remote diagnostics and support-command polling were removed in 0.6.11.

A delayed discovery can resume on the same temporary page. A newly authenticated
port can retry a timed-out first handshake within that operation. Classified setup
failures can use the existing encrypted local mailbox after checking the saved App
grant. Each subsequent trusted lookup or test starts a new physical handoff; it
does not inherit an old port or a preference for mailbox recovery. Every lookup
also creates a new encrypted session and obtains a fresh account list. Expired
responses are ignored; credential deadlines and permission checks are unchanged.


Keep the original App tab open. **Test connection** checks its signed response
without reading credential fields. **Reconnect to existing tab** rebuilds a port
to that App. During local recovery, visit the existing App tab if it needs to
resume, then return to the website within one minute. The same operation
continues after return. Closing the panel cancels the request.

| Event | Result |
|---|---|
| Temporary page closes or handoff worker stops | Established direct ports continue |
| A new lookup or test starts | Previous port is closed; a temporary page hands off a new port |
| Website is hidden | Delivery depends on browser scheduling; a past reply is not proof of current liveness |
| Website refreshes, navigates or closes | Its old port is released; a new document needs a new handoff |
| App refreshes or closes | All old ports stop; reconnect to the selected App |
| Database locks | Credential operations stop; the transport can remain connected |
| Connect is revoked or the selected App changes | Old connections and in-flight operations are invalidated |
| Port is idle for ten minutes | It is reclaimed; the next trusted action rebuilds it |
| Account list is older than 120 seconds | Find accounts again before filling |

Closing the panel, navigation, changed form targets and switching away during
an actual fill cancel that operation. Each website has a separate physical
port. The existing App bridge runs one encrypted account-selection session at
a time; a fresh lookup replaces old handles, and busy requests fail safely.
Database permissions remain independently revocable in browser extension settings.

Lookups and selections display their current stage and use a 30-second operation
budget. The local recovery window is separate from account and fill deadlines.
Closing the panel cancels pending work, including the key toggle. Current
Apps can recover a lost request or reply using the original execution ID and
encrypted receipt; the same field query is never executed twice. Receipt reuse
rechecks current App permissions and is limited to the original session, port,
request and deadline. When upgrading from before 0.6.3, save pending edits and
reload both the App and script to load that receiver capability. The UI uses the same direct protocol and receiver capabilities.

## Transport and security

The [architecture guide](docs/messageport-connect.md) describes the handoff and
checks. The helper and narrowly scoped service worker only discover the selected
App and transfer a MessagePort. They never become password servers. Signed
requests and the existing encrypted Connect protocol run directly on the port.
There is no remote relay server and no GM request polling in the direct path.

The App pins the browser-observed HTTPS site origin. It alone matches primary
and additional entry URLs, including the leading `www.` alias, and checks vault
permissions, current entry URLs and temporary handles before returning selected
fields. The Userscript decrypts the selected Connect response and checks the
current page and form targets before filling. It contains no independent matcher.

GM storage holds the script identity, address and public routing metadata.
Foreground setup caches the selected App and keys before opening the helper.
The App uses a synchronous same-origin selection marker containing only the
public host ID, committed under the existing Web Lock. It checks that selection
before and after asynchronous work, without awaiting background extension
storage. Changing the selected App or revoking access cannot publish a late
credential response. Direct ports are the primary transport. Recovery uses a
short-lived local mailbox for signed packets and encrypted wire payloads.

## Local connection logs

In Connection log, enable **Record local connection events** in each affected
tab before reproducing a failure. **Copy connection log** includes up to 300
in-memory events with request IDs, port lifecycle and rejection reasons.
The recording preference is saved for future tabs and reloads; only this boolean
is persisted. Turn logging off or reload to clear the current tab's events. No logs are uploaded; credentials,
field contents and website addresses are excluded.

## Verification

```sh
bun modules/extension/userscript/build-connect.ts
bun test modules/extension/userscript/tests/app-authorization-cancel.test.ts modules/extension/userscript/tests/operation.test.ts modules/extension/userscript/tests/reply-receipt.test.ts modules/extension/userscript/tests/app-bridge-receipt.test.ts modules/extension/userscript/tests/native-hello-retry.test.ts modules/extension/userscript/tests/port-auth.test.ts modules/extension/userscript/tests/port-worker.test.ts modules/extension/userscript/tests/relay-close.test.ts modules/extension/userscript/tests/direct-ports.test.ts modules/extension/userscript/tests/native-connect.test.ts modules/extension/userscript/tests/connect-mailbox.test.ts modules/extension/userscript/tests/connector-return.test.ts modules/vault/tests/website-matching.test.ts
modules/extension/node_modules/.bin/tsc --project modules/extension/userscript/tsconfig.json
bun run --filter @keewebx/ui build
```

Serve the built assets and run browser acceptance with Playwright Chromium:

```sh
KEEWEBX_E2E_PORT=8085 bun e2e/serve-app.ts
```

```sh
KWX_APP_SERVER=http://127.0.0.1:8085 node modules/extension/userscript/tests/port-connect.mjs
KWX_BLOCK_HELPER_CLOSE=1 KWX_APP_SERVER=http://127.0.0.1:8085 node modules/extension/userscript/tests/port-connect.mjs
KWX_APP_GM_BLOCK=1 KWX_APP_SERVER=http://127.0.0.1:8085 node modules/extension/userscript/tests/port-connect.mjs
KWX_APP_SERVER=http://127.0.0.1:8085 node modules/extension/userscript/tests/native-connect.mjs
node modules/extension/userscript/tests/relay-lifecycle.mjs
```

The production-port fixture uses the exact installer in Chromium extension
isolation, real encrypted KDBX, native consent, and browser-owned service-worker
clients and transferred ports. A disposable TLS proxy serves the actual built
assets at the configured HTTPS origin. A separate run blocks App-side GM reads
after authorization. The older native/mailbox suite explicitly masks the new
capability in its fixture to retain coverage of that compatibility path.

The MessagePort Lab has been retired. Its [historical release](https://github.com/gynet/keewebx/releases/tag/messageport-poc-v0.1.2)
records the original iPhone Safari transport test, in which two websites
reached the hidden App after their helpers closed. Full autofill on a physical
iPhone, long suspension, and communication with standalone Home Screen PWAs
still require acceptance. iOS may require a manual visit to an existing App tab;
a port cannot force a suspended page to run.
