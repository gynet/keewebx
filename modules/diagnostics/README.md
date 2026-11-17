# @keewebx/diagnostics

Optional, dependency-free TypeScript diagnostics client. Import from
`@keewebx/diagnostics` or `modules/diagnostics/src`. It can be used independently of
the Userscript. It requires `crypto.randomUUID`, `AbortController` and standard
timers, with no GM, DOM, `window`, `navigator`, storage or HTTP implementation.

## API

```ts
import {
    DiagnosticClient, sanitizeData, sanitizeEvent,
    type DiagnosticClientOptions, type DiagnosticData,
    type DiagnosticSession, type DiagnosticState
} from '@keewebx/diagnostics';

const options: DiagnosticClientOptions = {
    source: 'app', // 'app' | 'website'
    version: '0.1.0',
    store: {
        async load(): Promise<DiagnosticSession | undefined> { /* shared store */ },
        async revision(): Promise<string> { return 'initial'; /* persistent revocation marker */ },
        async save(session: DiagnosticSession | undefined, expectedRevision?: string): Promise<void> {
            /* fence-bound shared store; see contract below */
        }
    },
    async transport(path, body, token, signal): Promise<unknown> {
        // POST body as JSON. Use token as a Bearer header when supplied.
        // Select the trusted service origin here and honor signal.
        throw new Error('Provide an HTTP adapter');
    },
    snapshot(kind): DiagnosticData {
        // Only read safe runtime metadata for snapshot, ping or receiver-check.
        return { layer: 'app', locked: true };
    },
    onChange(state: DiagnosticState) { /* update adapter UI */ }
    // now: () => Date.now() // optional epoch milliseconds, useful in tests
};

const diagnostics = new DiagnosticClient(options);
// Constructing does not load storage, inspect runtime data or start networking.
await diagnostics.refresh(); // join an existing persisted global opt-in, if any
await diagnostics.enable();  // call in response to explicit consent
diagnostics.record('connect.stage', { layer: 'app', stage: 'connect', elapsedMs: 12 });
await diagnostics.flush();   // one exchange; also rechecks shared consent
diagnostics.setOnline(false);
diagnostics.setOnline(true); // immediately retries an enabled session
await diagnostics.disable(); // clear local work immediately and clear shared opt-in
diagnostics.dispose();       // local teardown; preserves other documents' opt-in
```

Exported types: `DiagnosticClientOptions`, `DiagnosticSession`, `DiagnosticState`,
`DiagnosticData`, `DiagnosticCode`, `DiagnosticCommandKind`, `DiagnosticError`,
`DiagnosticStore`, `DiagnosticTransport`, `DiagnosticEvent`, `DiagnosticCommand`,
and `DiagnosticResult`.

```ts
interface DiagnosticSession { id: string; token: string; expiresAt: number }
interface DiagnosticState {
    enabled: boolean;
    id?: string;
    expiresAt?: number;
    status: 'off' | 'starting' | 'sending' | 'connected' | 'offline';
    error?: 'storage' | 'network' | 'timeout' | 'invalid-response' | 'expired';
}
type DiagnosticCommandKind = 'snapshot' | 'ping' | 'receiver-check';
interface DiagnosticStore {
    load(): Promise<DiagnosticSession | undefined>;
    revision?(): Promise<string>;
    save(session: DiagnosticSession | undefined, expectedRevision?: string): Promise<void>;
}

// No coercion, recursion, getters or arbitrary strings. Unknown data fields drop.
function sanitizeData(value: unknown): DiagnosticData;
function sanitizeEvent(code: unknown, data?: unknown):
    { code: DiagnosticCode; data: DiagnosticData } | undefined;
```

`state` returns a copy and never exposes the token. `onChange` receives copies;
observer exceptions are isolated. Runtime errors use only the fixed codes above.
An invalid source or build version throws `TypeError('invalid-options')` during
construction. Build versions must match `[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}`.

## Consent, polling and lifetime

`enable()` reuses a valid shared session or creates one and **awaits successful
persistence before enabling or collecting**. Storage errors fail closed.
`refresh()` explicitly reads shared consent and performs an exchange for a live
session. An empty store leaves diagnostics off. Call it when shared storage
changes; automatic polling also reads the store before every exchange. Store
operations are serialized within each client. Shared stores must implement the
following revocation-fence contract; `revision()` is optional only for stores
that are not shared between clients:

* `revision()` returns a durable revocation marker as a string of at most 256
  characters. An initially empty store can return a fixed marker such as
  `initial`. The marker must survive deletion of the grant.
* `save(undefined)` replaces the marker with a fresh unique value **before**
  deleting the stored grant. Grant creation must never delete or reset the marker.
* `save(session, expectedRevision)` checks the current marker, binds the stored
  grant to `expectedRevision`, and rejects mismatches before and after writing.
  A concurrent late write can physically overwrite the grant after deletion;
  it must retain its original fence so every reader rejects it.
* `load()` returns a session only if its persisted fence matches the current
  revocation marker. Read the marker before and after the grant, rejecting changes
  during that read. Strip adapter-specific fence fields before returning the
  `DiagnosticSession` to the core.

The core reads the marker before creation, rechecks it before publication, passes
it to `save`, and rereads both grant and marker before adopting a created session.
Thus a delayed enable cannot republish consent after another document disables it,
including an empty-store/create/delete/empty-store sequence. Fence changes during
reads fail closed. The adapter owns persistent fence storage and notifications;
no GM implementation is embedded in this package. Ignore notifications caused by
an in-progress local enable, or refresh after that operation settles.

Calls to `record()` while off are ignored, with no backfill. Each client gets a
random UUID for its document lifetime and a monotonically increasing event
sequence. A fresh session records `session.started` after persistence. The core
does not automatically send `session.stopped` when consent is removed.

Online defaults to true. The adapter should call `setOnline()` using its own
connectivity information. Successful exchanges schedule the next poll five
seconds after completion. Network errors stop automatic polling; `refresh()`,
`flush()` or `setOnline(true)` retries. Offline clients do not send requests or
execute commands. There are no background retries while disabled or disposed.

Session grants last at most one hour from the start of local creation, or the
earlier expiry in shared storage. Creation tolerates up to one minute of server
clock lead and clamps the persisted expiry to the local hour. Server replies can
shorten expiry and cannot extend it. Expiry aborts pending work and erases event
and result queues. A stale store value cannot revive a locally expired or revoked
session. Fixed ID/deadline metadata is retained locally to enforce this, with
capacity limits of 4,096 command IDs and 4,096 session IDs per client lifetime;
capacity exhaustion rejects further commands/sessions instead of evicting safety
history.

`disable()` aborts pending work and erases queues before awaiting the shared
clear. If clearing fails, this document stays disabled with `storage`; adapters
must handle the failed shared clear for other documents. `dispose()` is
idempotent, aborts local work, emits no further notifications, and preserves the
shared session. Async responses and callback resolutions from previous sessions
cannot reactivate diagnostics or enter a replacement session's queues.

## Wire protocol and commands

The transport receives exactly these relative paths and JSON bodies:

* `POST /api/connect-diagnostics/session`, `{}`, no token. Response is
  `{ id: UUID, token: string, expiresAt: epochMs }`.
* `POST /api/connect-diagnostics/:id/exchange`, with the session token:

```ts
{
    client: UUID, source: 'app' | 'website', version: string,
    events: [{ seq: number, at: epochMs, code: DiagnosticCode, data: DiagnosticData }],
    results: [{ id: UUID, kind: DiagnosticCommandKind, status: 'ok' | 'failed', data: DiagnosticData }]
}
```

The exchange response is `{ commands: [...], expiresAt: epochMs }`. Each command
must contain exactly `{ id: UUID, kind, target?: clientUUID, issuedAt, expiresAt }`.
Unknown envelope keys, invalid IDs/kinds/timestamps, future issuance, expired
commands, another client's target, or a TTL over 60 seconds are rejected. Commands
are checked immediately before execution and run only in the current live
session. All three kinds call `snapshot(kind)`; the callback must remain read-only
and must not issue credential RPCs, execute server-provided code or mutate Connect.

Each command ID executes at most once per session and client, including retries
and switching away from and back to a shared session. Callbacks have an eight
second deadline, shortened to the remaining command/session lifetime. Failures
produce only `{ reason: 'timeout' | 'other' }`. A callback's underlying promise
cannot be canceled through this signature, but late data is discarded. Results
are sent in the **next** exchange; `flush()` performs one exchange, without an
immediate result-upload loop.

All network requests have an eight second deadline even if the adapter ignores
abort. Event and result queues are each bounded to 32. Each outgoing exchange has
**at most 32 combined results and events**: results take priority, with events
filling the remaining capacity. Excess events remain queued for the following
exchange. Oversized command responses are rejected in full. The latest 32 events survive overflow;
failed exchanges retain bounded pending payloads for an explicit retry. Delivery
is best effort, so the backend should use client/sequence and result IDs to handle
request retries.

## Privacy schema

Only these event codes are accepted:

```text
session.started session.stopped
page.visible page.hidden page.show page.hide
connect.state connect.action connect.stage connect.error
app.locked app.unlocked app.receiver
transport.event command.result
```

All event and snapshot data pass through the same canonical sanitizer:

| Fields | Permitted values |
| --- | --- |
| `locked`, `authorized`, `authorizing`, `selected`, `live`, `direct`, `hasSession`, `hasPort`, `online`, `visible`, `persisted` | Booleans |
| `elapsedMs` | Finite number from 0 through 3,600,000 |
| `pending`, `ports`, `authorization` | Integers from 0 through 10,000 |
| `layer` | `userscript`, `app`, `website`, `worker` |
| `state` | `Initializing`, `ReadyToConnect`, `Connecting`, `Connected`, `Error` |
| `action` | `open`, `authorize`, `revoke`, `lookup`, `probe`, `save`, `close` |
| `stage` | `connect`, `access`, `lookup`, `fields`, `fill`, `test`, `authorize`, `restore` |
| `event` | `receiver-ready`, `discovery`, `discovery-reply`, `discovery-timeout`, `handoff`, `port-ready`, `hello-received`, `hello-replied`, `wire-received`, `wire-replied`, `wire-error`, `receipt`, `suppressed`, `unavailable` |
| `reason` | `timeout`, `locked`, `canceled`, `unavailable`, `changed`, `other` |

Unknown fields and invalid primitive values are dropped. No URLs, error messages,
user agents, accounts, passwords, titles, private keys, ciphertext, nested data,
or freeform logs are accepted. Session tokens belong only in privileged storage
and the transport authorization header. Adapters forwarding events from another
runtime should use `sanitizeEvent` before passing them to `record`; the client
sanitizes again at ingestion. State observers never receive credentials.

## Verification

From this directory, run `bun test tests` (or `bun run test`). From the repository
root, run `bun test modules/diagnostics/tests`. The tests use fake clocks and
deferred transports to cover consent, redaction, schema bounds, malformed and
duplicate commands, shared-store changes, stale async work, deadlines and expiry.
