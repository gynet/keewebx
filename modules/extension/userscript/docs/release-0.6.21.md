# Connect 0.6.21

Each trusted account lookup or connection test now closes its previous physical
MessagePort and starts a fresh handoff to the selected App. A successful earlier
probe no longer causes the next operation to reuse that port. Reconnect uses the
same path and opens one temporary page. The page closes after the signed ready
receipt is verified. A new lookup, its account selection and its fill share one
new encrypted session; the saved signing identity and authorization remain.

This changes the previous helper-reuse policy: a temporary page may briefly
appear for every new lookup or test. It does not open another vault, repeat
permission approval, extend credential deadlines or replay a fill. Form detection
and page load still do not initiate connection actions.

An already-authorized App also stops starting another silent authorization after
an unrelated body mutation or cached-page restoration. Successful authorization
records that restoration was attempted; the restore guard recognizes an active
authorization after checking the lock state. Explicit reauthorization, lock,
disconnect and cancellation remain separate actions.

The reported 0.6.20 trace showed a successful probe followed by a new hello on
the same physical port. The App dispatched that hello and its identical retries
only after becoming visible, when the request had expired. This establishes late
delivery in that trace; it does not prove that authorization changes caused it,
or that a new handoff can always wake a background browser document. Expired
packets must remain rejected. Native iOS Userscripts acceptance is still required.

Update the existing installer. Save database changes and copy any local logs to
retain, then reload the original App and website to load 0.6.21 at both ends.
The local logging preference remains saved; log contents remain memory-only.

See the [connection architecture](connection-architecture.md) for the current
sequence, state lifetime and unchanged authentication and encryption boundaries.

Verification: TypeScript and the New App build passed, along with 594 unit tests
and 22 legacy-transport browser scenarios. Chromium acceptance passed all 32
scenarios; the blocked-helper-close/App-storage variant passed 31. Focused App
reload/reopen, foreground storage failure, mailbox recovery, and stale-port
replacement checks also passed. WebKit acceptance passed 18 scenarios
covering 128 operations, each with a distinct port and one automatically closed
helper. The old installer fails the new fresh-port regression. The old App
restoration closure fails two publication checks; the corrected closure passes
all 14 lifecycle tests, including three cached-page returns with signed RPCs.
These are automated desktop browser checks with adapted manager APIs, not native
iOS certification.
