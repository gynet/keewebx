# Userscripts on iOS: KeeWebX Connect 0.6.0

Authorize the unlocked KeeWebX App once, then choose matching accounts beside
login fields on other websites. Each website document gets a direct MessagePort
to the same original App. A temporary connection page closes after a signed
handshake. Forms are filled only after selecting an account and are not submitted.

[Install in Safari](https://keewebx.app/connect-port/keewebx-connect.user.js?v=0.6.0)
· [Immutable source](https://raw.githubusercontent.com/gynet/keewebx/userscript-v0.6.0/modules/extension/userscript/keewebx-connect.user.js)
· [Architecture and lifecycle](docs/messageport-connect.md)
· [0.6.0 acceptance report](docs/release-0.6.0.md)

## Install or upgrade

1. Open the installer in Safari, open the Userscripts extension menu, and choose
   **Tap to Install**. Update the existing `keewebx-connect.user.js` filename.
   Keep one enabled Connect script; disable MessagePort Lab and old probes.
   Allow Userscripts on KeeWebX and your login websites, and allow the temporary
   connection popup when Safari requests permission.
2. Save pending database changes, then reload your original
   `https://keewebx.app/app` tab and the login website so both show **Connect 0.6.0**.
   Existing database entries and the script's stored identity are retained.
3. Unlock the original App, open its Connect key panel, and choose
   **Authorize Connect**. Approve account listing once in the native permission
   dialog if requested. This selects one App for all websites.
4. On a login website, focus a username/password field, tap the key, and select
   a matching account. The first connection in that document opens a small
   connection page, finds the original App, and automatically closes the page
   after verification. Further lookups in that document reuse the direct port.

A renamed script has a separate manager storage namespace and cannot reuse the
original filename's identity. For self-hosting, publish the built `connect-port/`
directory beside the App assets and save the App's full HTTPS address in the
script's Connection tab before authorizing it.

## Recovery and lifecycle

Keep the original App tab open. **Test connection** checks its signed response
without reading credential fields. **Reconnect to existing tab** rebuilds a port
to that App. It never navigates or silently replaces an unlocked vault. If the
App stops replying, visit its existing tab, unlock if needed, return to the
website, and reconnect.

| Event | Result |
|---|---|
| Temporary page closes or handoff worker stops | Established direct ports continue |
| Website is hidden | Port remains usable while the document can execute |
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
credential response. The older signed transport remains available for old
receivers and separate regression coverage; new receivers use direct ports.

## Verification

```sh
bun modules/extension/userscript/build-connect.ts
bun test modules/extension/userscript/tests/native-connect.test.ts modules/extension/userscript/tests/connect-mailbox.test.ts modules/extension/userscript/tests/connector-return.test.ts modules/vault/tests/website-matching.test.ts
modules/extension/node_modules/.bin/tsc --project modules/extension/userscript/tsconfig.json
bun run --filter @keewebx/ui build
```

Serve the built assets and run browser acceptance with Playwright Chromium:

```sh
KEEWEBX_E2E_PORT=8085 bun e2e/serve-app.ts
```

```sh
KWX_APP_SERVER=http://127.0.0.1:8085 node modules/extension/userscript/tests/port-connect.mjs
KWX_APP_GM_BLOCK=1 KWX_APP_SERVER=http://127.0.0.1:8085 node modules/extension/userscript/tests/port-connect.mjs
KWX_APP_SERVER=http://127.0.0.1:8085 node modules/extension/userscript/tests/native-connect.mjs
```

The production-port fixture uses the exact installer in Chromium extension
isolation, real encrypted KDBX, native consent, and browser-owned service-worker
clients and transferred ports. A disposable TLS proxy serves the actual built
assets at the configured HTTPS origin. A separate run blocks App-side GM reads
after authorization. The older native/mailbox suite explicitly masks the new
capability in its fixture to retain coverage of that compatibility path.

The separate [MessagePort Lab](docs/messageport-poc.md) transport was reported
working on a physical iPhone in Safari with Userscripts: two websites reached
the same original hidden App after their helpers automatically closed, with
1–2 ms pongs. That validates transport, not this release's complete autofill
flow. Full autofill on the physical phone, long suspension, and communication
with standalone Home Screen PWAs still require acceptance. iOS may require a
manual visit to an existing App tab; a port cannot force a suspended page to run.
