# Connect 0.6.8: one owner per returned port

[Safari installer](https://keewebx.app/connect-port/keewebx-connect.user.js?v=0.6.8)
· [Setup](../README.md)
· [Diagnostic scope](remote-diagnostics.md)

Connect now reserves one runtime synchronously before reading settings. Running
the installer again in the same script world cannot create another UI, host,
restoration observer or competing authorization flow.

App receivers share one ServiceWorkerContainer dispatcher. It sends each
transferred endpoint only to the receiver addressed by the App boot ID. An old
receiver can no longer close another receiver's port or post a stale discovery
response ahead of its owner. One stale-state reply remains available when an
App has actually reloaded. Disposing a receiver removes its probes, idle timer
and registration; the last receiver also removes the shared listener.

This defect is reproducible in both receiver orders. Before the fix, an older
receiver registered first prevents readiness; registered last, it breaks the
return path after readiness. These results establish a code defect, but do not
establish the cause of every iOS discovery failure.

## Diagnose both directions

Opt-in diagnostics now correlate temporary request and port UUIDs across sends,
receives, signature/binding checks and accepted replies. Fixed rejection codes
distinguish wrong ownership, address, origin, generation, shape, expired replies
and missing pending requests. An App's "reply posted" is distinct from the
website accepting that reply. The handoff worker also records acknowledgement
receipt separately from an App sending one.

The service accepts bounded release-version metadata independently of its
payload schema. Previously it accepted only 0.6.6, rejecting 0.6.7 uploads and
leaving a misleadingly one-sided diagnostic timeline. Both schema boundaries
continue to reject arbitrary text and private fields. A bounded 128-event local
backlog preserves bursts while uploads remain limited to 32 combined items.
Existing consent, one-hour expiry and read-only command restrictions apply.

## Upgrade

Update the existing script filename. Save database edits, then reload the
original App tab and login website so both load 0.6.8. Old document listeners
cannot be removed by installing a new file alone. Unlock the original App and
check its Connect panel before retrying from the website. No second App tab is
needed. Keep only one enabled Connect script.

## Validation

- The client/core suite passes 347 tests, including ownership, lifecycle,
  signatures, revocation, cancellation, aggregate deadlines and schema privacy.
- The real-KDBX Chromium regression fails on 0.6.7 after installer reinjection.
  The fixed installer survives two reinjections in each document, then six
  successful fills on the original physical port with one widget and receiver,
  no new authorization, App navigation or helper.
- The final 175,457-byte installer passes the complete 31-step Chromium suite,
  including 24 alternating fill cycles. The hosted assets separately pass the
  five-step authorization, signed handoff and reinjection acceptance. Hosted,
  release and immutable tagged installers have the same SHA-256:
  `a86eca169193768061582ee56cfb826c83e13e334bdd00047508fa7f9acb400c`.
- Separate bundle copies share the same native dispatcher in Chromium. Both
  receiver orders preserve discovery and subsequent port replies.
- Desktop WebKit acceptance covers repeated cross-origin fills, lock/unlock,
  loss recovery, cancellation and helper closure. This is separate from native
  iOS Userscripts acceptance.
- The actual shared 0.6.7 diagnostic client completes a production read-only
  command/result round trip after the service fix, using synthetic state only.

Native iOS confirmation of the reported failure remains pending. This release
does not increase connection deadlines or bypass cryptographic checks.
