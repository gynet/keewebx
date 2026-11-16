# MessagePort Lab 0.1.0

This is a separate Userscripts proof of concept. It exchanges synthetic ping
messages only. It does not read databases, credentials, forms, or production
Connect settings and is not an autofill replacement.

[Install the test script](https://raw.githubusercontent.com/gynet/keewebx/messageport-poc-v0.1.0/modules/extension/userscript/keewebx-messageport-poc.user.js)
or use the [hosted installer](https://keewebx.app/connect-port-poc/keewebx-messageport-poc.user.js).

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
node modules/extension/userscript/tests/messageport-poc.mjs
```

The browser fixture injects the actual installer in Chromium extension isolation
with a small GM storage adapter, an existing main App service worker and two
distinct HTTPS website origins. Its local endpoint is substituted for the
production address. It checks automatic relay closure, repeated pings, two
independent ports, continued pings after stopping the handoff worker, closing
one website, rebuilding after reload, and preserving the original App document
and main worker. It also checks that lab scripts are not injected into the
normal App HTML and that the hosted installer matches its source bytes.
The panel is checked at 390px and 320px without interrupting its connection.

Native iPhone Userscripts execution, suspension and memory-pressure behavior
remain unverified. A browser-held port cannot force a suspended App to execute.
The separate early main-world experiment passed Chromium but not isolated
Firefox; that experiment is not a compatibility certification.

The final local installer passed **eight browser acceptance steps**, including
true hidden-App replies, automatic closure of all three temporary connection
pages, continued pings with the handoff worker stopped, two independent websites,
rebuilding after website reload, and both mobile widths. The original App
document navigated only once and its main worker remained in control.

Installer: **14,895 bytes**. SHA-256:
`fae03762dc7ee83496ce8ba51d98f6421fa21315543b286b798b76936f2e089e`.

Disable this test script and close its test pages when finished. The production
Connect installation and saved databases do not require changes.
