# Connect state and recovery

Connect can minimize state, but a live browser port, immediate revocation and
replay protection require some state. Persist identity and explicit user choices;
keep transport and account-selection state confined to the owning documents.

## Current state

| Location | Contents | Lifetime and purpose |
|---|---|---|
| Script-manager private storage | Signing identity, selected App route, address, preferences | Durable identity and user choices. No vault password or selected account fields. |
| Manager tab metadata | App owner ID | Identifies the original tab across document reloads when the manager supports tab APIs. |
| App-origin storage | Current selected host marker; explicit-disconnect restoration block | Synchronous local admission and revocation. The marker alone cannot authorize signed requests. |
| Website memory | Physical port, foreground route/key snapshot, pending requests, current short-lived scope | Rebuilt after navigation or connection loss. Foreground preparation avoids a background manager-storage read on the connection path. |
| App memory | Owned ports, active encrypted scope, authorization generations, consumed request IDs, bounded receipts | Ends with the document; expires or clears on idle, lock, cancellation, revocation or replacement as appropriate. |
| Temporary helper and handoff worker | Discovery probes, transient port transfer | The helper closes after handoff. Established traffic does not depend on either remaining alive. |
| Optional diagnostics | One-hour consent and upload capability; expiring sanitized records | Separate from vault authorization and transport availability. Off by default. |

The selected route's `host` identifies one document boot. Its `owner` identifies
the selected browser tab. A saved host is a discovery pointer, not proof that a
port remains usable. Each actual connection still verifies signed readiness and
the encrypted protocol handshake.

`authorization` and `publishedAuthorization` also serve different purposes. The
current generation can advance on pause; the published generation identifies
delayed manager events that must not revoke a newer grant.

## State already reduced in 0.6.8

- Synchronous startup reservation prevents repeated installers from creating
  extra UIs, authorization flows and restoration observers in one script world.
- One dispatcher owns delivery on each ServiceWorkerContainer. Other receiver
  instances cannot answer ahead of an addressed owner or close its endpoint.
- Receiver disposal removes its probes, timer and registration. The last
  receiver releases the dispatcher listener.

## Further reductions identified by the audit

The following are findings and recommendations, not shipped behavior changes:

1. Derive the App panel's current authorization display from host readiness,
   selection and lock state. Its independent `authorized` boolean can retain an
   old display after a manager grant change clears ports. Existing admission and
   signature checks still deny that stale selection. A display refactor must not
   automatically reauthorize an App merely because another tab was selected.
2. Remove `SitePortLink.sent`: the presence of its transferable endpoint already
   expresses whether handoff can occur. Cover duplicate helper-ready messages,
   transfer exceptions and cancellation before deleting it.
3. Start legacy BroadcastChannel/mailbox adapters only when needed. They can
   still listen alongside the direct path, and share the protocol-session owner.
   Preserve compatibility and test restored old clients before changing this.

Do not remove the foreground route/key snapshot to make request handling appear
stateless: that reintroduces manager-storage dependency while Safari has moved
the App or website into the background. Refresh it at controlled foreground
boundaries and verify live responses rather than treating the snapshot as proof
of connectivity.

Do not replace consumed-request tracking with signature validation alone. A
valid signature does not prevent replay. Likewise, cached encrypted replies must
retain their original port, grant, request and deadline binding, with current
vault permission checks before publication.
