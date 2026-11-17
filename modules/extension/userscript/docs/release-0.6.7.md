# Connect 0.6.7: bounded recovery on the existing connection

[Safari installer](https://keewebx.app/connect-port/keewebx-connect.user.js?v=0.6.7)
· [Setup](../README.md)
· [Opt-in diagnostics](remote-diagnostics.md)

Device diagnostics separated two events that an App panel alone cannot distinguish:
an App may post discovery replies after their temporary endpoints have expired,
and repeated cached hello replies may still precede a successfully accepted
handshake. An Authorized status is not an end-to-end connection test.

## Hosted discovery recovery

The hosted worker retains the original pending website endpoint for one additional
discovery round after timeout. Total discovery is capped at 16 seconds, the
helper and current browser-owned App clients are revalidated, and the original
website port transfers once. A selected App's explicit disabled/address mismatch
does not wait for another round. Unrelated old tabs cannot override a selected
App's timeout. This update also serves installed 0.6.6 scripts.

A real-KDBX regression holds App discovery replies for 10.5 seconds. The old
worker fails; the updated worker completes lookup and fill using the same helper
and original App, with one website-port transfer.

## Client handshake recovery

After the App's signed ready receipt is verified, a first hello deadline no
longer destroys that physical port. Connect tries one fresh signed hello on it.
The retry has a new request ID and session scope; old replies cannot satisfy it.
The existing lookup/test deadline also caps that second attempt, including when
an expired reply is delivered before suspended timers resume.

A fresh matching signed reply clears the consecutive timeout count. Two
consecutive request timeouts close a dead port. Navigation, revocation, a changed
App or key, send failures and decoding failures still close it immediately.
An unverified ready packet cannot preserve a failed handshake.

Closing/canceling a proved handshake stops its operation and keeps only the
physical transport for a later trusted action. It preserves no account handles
or pending credential work. Credential requests retain their permission checks,
original deadlines and existing same-request receipt rules; automatic recovery
does not repeat a credential read.

## Upgrade

Update the existing script filename and reload the login website. The updated
website client is compatible with the already authorized 0.6.6 App receiver;
that App can keep its open vault and authorization. Diagnostic opt-in is retained
until disabled or its original expiry. No second App is required.

## Validation

The final client/core unit suite passes 329 cases. The existing 0.6.6 App receiver
also passes the focused delayed-hello browser scenario with the final 0.6.7
website installer, without reauthorization or an App reload.

- The actual worker's 27 cases cover bounded late discovery, one-time transfer,
  disabled/address errors, helper changes, unrelated tabs and diagnostic events.
- Real-KDBX Chromium acceptance includes 30 steps: delayed discovery and delayed
  hello, repeated fills, 24 alternating website cycles, losses at both encrypted
  hops, cancellation, passkey lock/unlock and revocation.
- A hello held for 10.5 seconds fails on 0.6.6. With 0.6.7, one action resumes on
  the same signed physical port, ignores expired replies and performs one logical
  field read. The final deadline-capped build passes that focused browser case.
- WebKit's 15 real-KDBX cases pass. These desktop isolated-world checks are
  distinct from native iOS Userscripts acceptance.
- Unit cases cover first/second timeouts, scope and signature binding, cancellation,
  invalid and expired responses, cross-realm serialization, and 30/35-second
  aggregate budgets.

The older native-connector CI driver also now uses the visible panel's controls
when it covers the username field. Its original click was intercepted by the
open settings panel; the corrected browser suite passes without forced clicks.
