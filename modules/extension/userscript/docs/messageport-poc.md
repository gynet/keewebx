# MessagePort Lab 0.1.2

This is a separate Userscripts proof of concept. It exchanges synthetic ping
messages only. It does not read databases, credentials, forms, or production
Connect settings and is not an autofill replacement.

[Install the test script](https://raw.githubusercontent.com/gynet/keewebx/messageport-poc-v0.1.2/modules/extension/userscript/keewebx-messageport-poc.user.js)
or use the [hosted installer](https://keewebx.app/connect-port-poc/keewebx-messageport-poc.user.js?v=0.1.2).

## Test on iOS Safari

1. Open the installer in Safari, open the Userscripts extension menu and select
   **Tap to Install**. Keep the filename distinct from the production Connect
   script. Allow this test script on KeeWebX and the websites being tested.
2. In the existing `https://keewebx.app/app` tab, open **Port Lab** at the bottom
   left and choose **Enable test receiver**. No database unlock is needed for
   these synthetic messages. Keep that original App tab open.
3. Open website A, open **Port Lab**, and choose **Connect existing App**. A
   temporary connection page should close after the App confirms the port.
4. Choose **Repeat ×5**. Successful pongs after that page closes are the key
   result. Repeat with website B, then return to A and test again.
5. Disconnect/close A and check B still works. Refresh B, reconnect, and check
   it finds the same original App. The temporary page may open again for this
   new handshake, then close again.

If Safari keeps the temporary page open, switch back using Safari's tab
overview, check the website reports Connected, close only the temporary page,
and retry pings. A successful `window.close()` is not presumed when the browser
refuses it. The App receiver needs enabling again after refreshing the App
itself; refreshing a website rebuilds only that site's port.

For feedback, record whether the temporary page closed, which step timed out,
the visible status, whether A/B remain independent, and whether the App tab was
in the background. The panel displays short App/port IDs to check that a rebuild
reuses the original App. Do not share database contents or credentials.

## Discovery timeout fix in 0.1.2

The original receiver waited for `GM.getValue()` before replying to every
worker probe and port attachment. Its two-second probe deadline also included
that asynchronous extension-storage call. Injecting a three-second storage
read delay reproduced the exact original "app did not answer" error in WebKit.
This reproduces a concrete failure mechanism; it does not establish that the
same storage delay caused the report on a physical iPhone.

The receiver now answers probes and accepts matching test ports synchronously
from document memory. Selection is stored when enabling the receiver and checked
again separately on App focus, outside the handoff path. The worker allows eight
seconds for document scheduling; the website allows 25 seconds including helper
startup. Explicit message queue startup and acknowledgments release probe ports.
The App and worker recognize the same `/app`, `/app/`, `/next.html` and
`/index.html` routes. Successful probes remain compatible with 0.1.0 workers.

Errors now distinguish a worker that cannot see an App client, a disabled
receiver, an App refreshed since selection, and a receiver that never answered.
The App log records probes and rejected worker-source/port checks. Update the
script, reload the App and website once, then enable the App receiver again.
No new App is opened during discovery or recovery. A selection revision is
invalidated again when enabling commits, so a focus read begun during a pending
re-enable cannot later disable the fresh receiver or close its ports.

## Connection design

The website creates a MessageChannel. A temporary same-origin connection page
passes its second port to a narrowly scoped worker at `/connect-port-poc/`.
That worker queries same-origin window clients, asks candidate App tabs for the
selected test receiver ID, and transfers the port to the one original App that
answers. The App posts readiness through the direct port. Only then does the
website close its temporary connection page.

Subsequent pings travel directly between the website and App port endpoints.
The worker and temporary page are not in that data path. Different websites
receive separate ports and connection IDs. Page reload/navigation destroys the
website endpoint; a fresh handshake is required. No window object or MessagePort
is stored in JSON. Manager storage holds only the selected synthetic receiver ID.

The worker has no fetch handler or cache and is registered only under the lab
path. It does not replace the App's existing worker. Discovery validates the
helper URL, exact origin, nonce, receiver and connection IDs. It never opens a
replacement App. This is a transport test; it has no credential authorization
or encryption integration and cannot establish password-filling safety.

## Verification

Build the New UI assets and run:

```sh
bun run --filter @keewebx/ui build
node modules/extension/userscript/tests/messageport-selection.mjs
KWX_PORT_POC_GM_DELAY_MS=12000 node modules/extension/userscript/tests/messageport-poc.mjs
KWX_PORT_POC_BROWSER=webkit KWX_PORT_POC_GM_DELAY_MS=12000 node modules/extension/userscript/tests/messageport-poc.mjs
```

Install the corresponding Playwright browsers first. Chromium uses a real
extension content world and a small private GM adapter. WebKit runs the installer
in Playwright's isolated user world; a disposable DOM/binding fixture adapts only
GM storage. It is not the actual iOS Userscripts extension. The local endpoint
is substituted for the production address. Neither fixture uses credentials.

The installer passed **11 Chromium and 10 WebKit acceptance steps** with App
storage reads delayed by 12 seconds. Both verify direct pings after automatic
helper closure, two independent websites, closing one website, rebuilding after
website reload, preserving the original App document and main service worker,
320px/390px layouts, and actionable errors for disabled, refreshed and closed
App receivers. Chromium also verifies hidden-App replies and pings after the
handoff worker is stopped. The headless WebKit fixture did not report the App
as hidden, so it does not certify background execution on Safari.

The final three negative cases deliberately disable, refresh and close the App;
the earlier successful rebuild preserves the same App document. Static checks
prevent lab chunks being injected into normal App HTML and compare the hosted
installer bytes with source. A separate WebKit CI job runs independently of
other extension acceptance checks. Two additional deterministic selection-race
cases run against the actual installer in both browsers: a stale focus read
after re-enabling preserves an attached ping port, and disabling during a
pending enable prevents the receiver from becoming enabled again.

Native iPhone Userscripts execution, suspension and memory-pressure behavior
remain unverified. A browser-held port cannot force a suspended App to execute.

Installer: **16,308 bytes**. SHA-256:
`06d1ac161f7522bb1e51136bd33db54fa37b6112b70ba4ccc44ec63210e763b7`.

Disable this test script and close its test pages when finished. The production
Connect installation and saved databases do not require changes.
