# Connect 0.6.23

This release includes operation-port cleanup from 0.6.22 and fixes a receipt
replay race found during repeated browser acceptance.

An App could send request A's successful response, then receive a queued
duplicate of A. While it revalidated that duplicate's receipt, the website
sent its next legitimate request B. The replay occupied the normal busy flag,
so B was incorrectly rejected as `A request is already running. Retry.`

Receipt revalidation now has its own operation-local promise. B reserves the
normal request slot, waits for replay to leave the single-slot App bridge, then
checks session identity, authorization, signing keys, selection, lock state and
the original deadlines before executing once. Replay completion cannot clear
the busy flag belonging to B. Cancellation, replacement or expiry during the
wait prevents new account reads. Duplicate delivery still revalidates a receipt;
it does not repeat a credential read or extend its deadline.

Completed tests, completed fills and cancellations also close their owned
physical port, clear pending work and discard transient RPC references. Old
operation cleanup cannot release or close a replacement port. Lookup retains
its session through account selection and filling. Durable authorization,
identity, preferences and local-log recording remain. See the
[0.6.22 lifecycle notes](release-0.6.22.md).

## Verification and limits

Twelve deterministic replay-ordering tests pass; the unchanged 0.6.22 host fails
eleven of them. They cover execution exactly once, replay rejection, concurrent
requests, hello admission, cancellation, locking, revocation, reauthorization,
selection changes, document departure and expiry. All 613 unit tests, TypeScript
and the New App production build passed. Chromium's five-step focused acceptance
held a real duplicate receipt while the original reply advanced the client:
0.6.22 failed with the false busy response; 0.6.23 waited and filled exactly once.
Six subsequent alternating fills completed with fresh ports, no leftover App
session and no additional consent. Broader browser results are recorded with
the published release.

The supplied native iOS trace separately shows a fresh port's request reaching
the App callback 54.502 seconds after transmission. Neither this ordering fix
nor port cleanup establishes a fix for that pre-callback delay. Native iOS
stability remains unverified; desktop Chromium/WebKit tests use adapted manager
APIs. Expired requests continue to be rejected.

Update the existing installer, save pending database changes, and reload the
original App and website to load 0.6.23 at both ends. Keep one enabled Connect
script. No additional authorization is requested by this release.

See the [technical analysis](technical-analysis-0.6.21.md) for component, transfer,
state, lookup/fill, failure-timeline and receipt-ordering diagrams. Its initial
sections describe the pinned 0.6.21 snapshot; the final sections describe these
follow-up corrections.
