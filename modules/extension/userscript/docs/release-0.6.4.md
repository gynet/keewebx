# Connect 0.6.4 connection-page closure

[Safari installer](https://keewebx.app/connect-port/keewebx-connect.user.js?v=0.6.4)
· [Setup](../README.md) · [Architecture](messageport-connect.md)

## Reported failure

The physical Safari report showed the App receiving the transferred port,
posting authenticated ready and receiving the website's signed hello. The
connection helper nevertheless stayed in front with a waiting message.

The implementation discarded its helper reference whenever cross-window
`close()` returned normally. That call can silently do nothing. The fault
fixture reproduces this condition without changing native message trust,
source, origin or port transfer. It does not establish why a particular iOS
Userscripts installation refused the call.

## Change

After transferring the endpoint to the original App, the scoped worker sends
routing completion to its validated helper. The helper closes itself in its own
page context, independently of the website's execution. Before attaching, the
helper requires the current worker's `self-close-v1` acknowledgement; an old
activated worker with the same URL cannot handle the first attachment during an
update. Closing the helper does not authenticate the App or expose credentials.
The website still verifies signed ready, signed hello and the existing encrypted
Connect protocol before account traffic.

The 0.6.4 website also sends a scoped completion control to its own helper after
verification. If remote close is refused, it retains the reference until the
page is actually closed. Later cleanup uses the scoped control rather than
closing a potentially navigated replacement document. If self-close is also
refused, the helper provides a bounded, explicit manual close action.

The deployed helper is compatible with an already installed 0.6.3 script and
unlocked App. Close an old stuck helper and retry from the website to load the
updated helper. It cannot replace JavaScript inside a helper already open.
Updating the script adds the extra opener fallback; reloading the original
0.6.3 App is optional. Save edits and reload both ends when upgrading from an
older receiver.

## Verification

- 335 unit cases pass, including actual relay and worker execution, signed-ready
  rejection, spoofed completion controls, denied close, bounded failure, worker
  upgrade and safe retained-reference cleanup.
- Userscript and App TypeScript checks, installer syntax and App build pass.

The Chromium production-installer suite passes all 23 checks with cross-window
close disabled. This includes two origins, 24 alternating lookup/fill cycles,
20 injected request/reply losses, four cancellation recoveries, helper closure
while hello is held, and closure through the trusted opener when the worker
completion notice is deliberately lost. The traffic audit verifies 3,059 signed
envelopes, 1,610 encrypted sensitive envelopes, 12 signed ready receipts and no
plaintext credential transport. Every account request follows signed-ready and
signed-hello verification. WebKit passes its 11 checks under the same fault.
Both engines repeat their full pass with the actual old worker preinstalled,
verifying a successful first-connection upgrade before attachment. The exact
hosted 0.6.3 installer passes six compatibility checks with three closed helpers;
the old-server negative control fails at the intended first-helper assertion.
The deployed production assets also pass all 23 Chromium checks.

A subsequent combined CI check (unresolved App storage plus denied remote close)
exposed a second closure omission: worker rejection after revocation left error
helpers open. A server-only follow-up closes the helper after a trusted, matching
worker error, which is also delivered through the port to the website. Untrusted,
wrong-source, stale and port-bearing errors cannot trigger closure. The 0.6.4
installer is unchanged; this helper update also applies to existing 0.6.3 clients.
Physical iOS acceptance of this fix still requires a device test; desktop
WebKit is separate evidence.
