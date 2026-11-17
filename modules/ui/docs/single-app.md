# One main KeeWebX App

The first top-level browser page acquires an exclusive Web Lock before starting
the vault. Further pages show **KeeWebX is already open** and one action,
**Return to KeeWebX**. They do not create another vault model or show another
unlock form. Opening another database within the main App continues to work.

The return action asks the existing connection worker to query the browser's
actual lock holder and focus that WindowClient. It creates no new window and
stores no owner ID. When focus is unsupported, refused or slow, the page gives
a manual tab-switching instruction. A late query cannot focus a tab after its
fallback deadline.

Browsers use different identifiers for Web Locks contexts and Service Worker
WindowClients. The primary asks the worker for its own browser-observed client
ID, then holds an auxiliary locator lock for the same lifetime as the main lock.
The worker resolves that locator only when both locks belong to the same browser
context. This adds no persistent registry and survives a worker restart without
requiring the background App to answer a probe.

## Ownership and recovery

- Hiding or suspending the main page does not transfer ownership. There are no
  heartbeats or expiry-based takeovers.
- A visible waiting page queues an exclusive request. When the main document
  closes and releases its lock, only one waiter can start the vault.
- Hidden waiting pages cancel their queue entries and rejoin when visible. This
  prevents unused background duplicates from taking over during a main-tab reload.
- A back-forward cached primary retains its lifetime lock. A cached waiting page
  cancels its queued work and checks ownership again when restored.
- Lock-service errors show a retry action and do not start an uncoordinated vault.
  Startup errors retain the existing vault error screen.
- Connect authorization and database permissions retain their existing checks.
  App ownership grants no account access or unlocked database state to a new page.

The current interface's lock is scoped by origin, deployment base path and
configured storage namespace. All supported App entry aliases share the same
lock. It adds no localStorage, sessionStorage or GM ownership cache.

## Platform and upgrade boundaries

This feature coordinates top-level HTTP(S) pages in a browser that supports Web
Locks. Downloaded file pages, extension documents and embedded frames retain
their existing startup behavior. Classic remains a separate compatibility
interface. Different browsers, private profiles and storage partitions do not
share locks. Safari tabs and installed PWAs may occupy separate partitions.

Already open pages must load this version to participate. Save pending database
edits and refresh the original App after updating; an older document cannot be
retroactively assigned a browser lock by code it has not loaded.

Desktop browser acceptance is distinct from native iOS confirmation.
