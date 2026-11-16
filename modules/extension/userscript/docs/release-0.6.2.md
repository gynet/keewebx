# Connect 0.6.2 handshake recovery report

[Safari installer](https://keewebx.app/connect-port/keewebx-connect.user.js?v=0.6.2)
· [Setup](../README.md) · [Architecture](messageport-connect.md)

## Failure and correction

Physical Safari testing still failed on 0.6.1. The App diagnostics confirmed a
matching worker, endpoint and transferred port, and receipt of a signed hello.
The previous receiver hardening did not resolve the reported phone problem.

Three defects were independently reproduced against the released 0.6.1 code:

- A selected App answered discovery immediately, but a silent unrelated App
  delayed its handoff until the unrelated probe timed out after eight seconds.
- One failing selection-marker read consumed an otherwise valid hello ID before
  doing any work. Restoring storage and resending that request could never recover.
- Dropping the first signed hello reply left no recovery path. The host ignored
  an identical retry even though it had already created the valid session.

The same three regression cases fail on an isolated checkout of 0.6.1 and pass
on 0.6.2. Discovery now transfers once when the exact selected boot replies and
cancels unused probes. Signature and selection checks precede consuming an ID.
Only the current session's signed hello receipt is cached and may be replayed
for an identical request, on the same physical port, within the original deadline.
The client retries that handshake on its existing port; credential RPCs are not
re-executed or cached. Lock, release, revocation and session replacement invalidate
the receipt. An unavailable selection marker still fails closed.

## Match the successful POC's helper lifetime

The POC closed its helper on the initial ready message. Production previously
kept the helper foreground through an additional signed RPC round trip. The
new App signs the initial port receipt using the existing Connect identity:

`["keewebx-connect-port-ready-v1", appBoot, connectionId, endpoint, siteOrigin]`

The signature has a separate domain from RPCs and binds the fresh physical
connection ID. New routes advertise that a valid receipt is required. The
website verifies it and closes its helper synchronously, before awaiting RPC
session creation. Existing encrypted Connect handshakes, App-side website
matching and native database permission checks continue unchanged. Older routes
retain the signed-hello closure path; a supplied invalid proof is rejected.

The browser regression holds all RPC hello replies, requires the authenticated
helper to close, and verifies that no account or fields become available until
the real hello is released. This removes that circular foreground dependency;
it does not establish that Safari scheduling caused the physical report.

## Verification

| Check | Result |
|---|---|
| Signing, receiver, handshake retry, routing, matching and lifecycle | 275 unit cases passed |
| App-side website permission policy | 14 cases passed |
| Chromium real-KDBX direct-port E2E | 18 passed |
| Same E2E with App GM reads blocked after authorization | 18 passed |
| WebKit isolated-world real-KDBX E2E | 5 passed |
| Legacy signed window/mailbox compatibility E2E | 22 passed |
| Userscript/App typechecks, build, syntax and translations | Passed |

Both browser fixtures drop the first hello response and deliver a cached retry.
They verify the same original App, identical hello request/signature/deadline,
the same physical port and no premature account access. WebKit also tests repeated
connection tests, website reload, and a fresh website after closing both previous
websites. All four WebKit helpers close after signed transport authentication.

The three targeted state regressions fail against released 0.6.1. An external
copy of the browser harness also fails the intended early-closure assertion on
0.6.1 after its setup succeeds; checked-in version and signature checks remain
strict. These are concrete before/after regressions, not physical iOS certification.

Installer: **114,996 bytes**, SHA-256:
`51aa85b0ebfa59829cb0286211716839fd73f1b8264e9b4d6737120b5461a0a9`.

The new regressions cover exact port-signature bindings, missing and
forged receipts, transient admission failure, lost hello, wrong port, changed
request, revocation, lock, replacement sessions and unchanged wire replay denial.

App diagnostics now distinguish discovery replies posted and worker results,
port signing, hello rejection, signed replies posted and suppressed replies. The
physical iPhone failure remains the final acceptance case; desktop browser
fixtures do not certify the Userscripts manager or native background scheduling.
