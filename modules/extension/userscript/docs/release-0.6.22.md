# Connect 0.6.22

A subsequent repeat of Chromium acceptance exposed a pre-existing receipt-replay
race despite the first full run passing. See [0.6.23](release-0.6.23.md) for the
ordering correction. The lifecycle results below remain valid; they are not
evidence that every connection failure was resolved.

Finished and canceled operations now close their physical MessagePort as well as
sending the existing best-effort session release. Previously, a successful test
or fill could leave its port allocated until the next operation. If the App
processed the signed release after its deadline, its session also remained.
The port-bound close now removes that session when the App processes it, while
expired protocol requests remain rejected.

An older operation checks its port generation before sending release or closing
anything. Its late cleanup cannot act on the next operation's port. Disposal
also clears pending requests, retry timers and the RPC's references to scope,
keys, route and helper. The saved signing identity, authorization, settings and
local-log recording preference remain. Clearing a reference is not a guarantee
of immediate memory erasure by the JavaScript engine.

The account list keeps its live session through selection and filling. Closing
the panel, finishing a fill, finishing a test, canceling or leaving the document
ends the operation. Each new trusted lookup/test still starts a fresh handoff.
No timeout is extended, credential check removed or background probe added.

## Remaining native iOS failure

The supplied paired 0.6.21 trace shows six successful RPCs on a **new** port, then
a seventh request entering the App callback 54.502 seconds after it was sent.
It was rejected as expired when the App became visible. This release fixes the
separate cleanup defect; it does **not** establish a fix for that delivery stall.
Browser-process termination can also skip lifecycle events. Remote close only
takes effect once the remote document executes; new App boot IDs, session bounds
and deadline checks continue to reject stale work.

## Verification

TypeScript and 601 unit tests passed. The previous implementation fails the
regressions for closing a verified operation and for preventing a late disposer
from sending release on a replacement port. Tests also cover delayed physical
close after release expiry, preserving another website's session and suppressing
an encrypted reply after port closure.

Chromium passed 32 full acceptance scenarios, plus focused operation-disposal
and stale-reply checks. Real MessagePort close delivery was verified after an
expired release, and delayed cleanup preserved a replacement session. WebKit
passed 18 scenarios spanning 128 operations, including website and App reopening;
lookup retains its port until selection, and completed operations close it.
The 22 legacy/recovery browser scenarios and the New App production build also
passed. Automated desktop browsers with adapted manager APIs do not certify
native iOS behavior.

Update the existing installer, save any pending database edits, then reload the
original App and website to load 0.6.22 at both ends. Local-log recording remains
enabled if previously selected; individual log events remain memory-only.

See [connection architecture](connection-architecture.md) for flow diagrams and
state lifetimes.
