# Connect 0.6.3 repeated lookup and fill recovery

[Safari installer](https://keewebx.app/connect-port/keewebx-connect.user.js?v=0.6.3)
· [Setup](../README.md) · [Architecture](messageport-connect.md)

## Reported failure and reproduced defects

The user confirmed initial iOS Safari success on 0.6.2, then reported delayed
account results and a second selection timing out after the first fill worked.
Repeated refreshes temporarily restored it. The MessagePort Lab tested transport;
the production lookup also has an encrypted App protocol and a local window
bridge. Recovering the initial hello did not cover failures in those later steps.

The investigation reproduced these defects:

- A rejected App handler could leave the queue's processing flag set, preventing
  the next request from being dispatched. `finally` now releases only its own
  transport generation, including unexpected rejections.
- After a local bridge was replaced, its content requests were silently dropped.
  They now receive an error addressed to that bridge without taking over the
  current connection or reading data.
- A completed account/field request whose reply was lost could not recover: its
  request ID was already consumed and only hello replies were repeatable.
- Hiding the panel with its key toggle skipped cancellation. A late lookup could
  reopen it; selection could remain busy without a visible progress stage.
- Independent per-step timeouts allowed a lookup or selection to wait much longer
  than one useful user-action budget.

A new wire-recovery regression fails on an isolated 0.6.2 checkout and passes on
0.6.3. The queue regressions also failed before their fixes. These demonstrate
concrete state defects; the exact dropped phone packet is not identified.

## Typed request lifecycle

The implementation remains TypeScript and now separates `Operation` and
`ReplyReceipt` from UI orchestration. A lookup or selection has one 30-second
budget across all stages. Closing either control cancels pending work, releases
busy controls and rejects late results. Access and form destinations are checked
again before filling. Status messages distinguish connection, account lookup,
account access and field retrieval. Expiry and explicit errors allow another
Find accounts action without requiring a page refresh.

Direct-port Apps no longer continuously poll an idle compatibility mailbox.
Storage notifications and App returns can wake compatibility work; legacy-only
receivers retain their polling behavior.

## Reliable delivery without repeating field reads

There are two request paths: the signed website-to-App MessagePort and the local
AppBridge-to-application window protocol. Each can lose a request or response.

- A capable receiver accepts retries of the identical signed request, within its
  original deadline and physical port. Its consumed-ID guard prevents execution
  twice. Older receivers keep single-send wire behavior.
- NativeHost keeps only the latest request binding for wire recovery. It does
  not bypass current App policy by forwarding an old encrypted field response.
- AppBridge reuses the original `kwRequest`, encrypted payload and nonce. The
  application retains one original response in document memory until the
  deadline, along with a bounded execution-ID ledger. Neither enters GM storage.
- Every cached publication reruns `ProtocolImpl.prepareResponse`, checking current
  client, file, entry and permission state. Lock, revocation, access invalidation,
  transport replacement and cancellation invalidate relevant receipts.
- Each revalidation has a fresh `kwAttempt`. A delayed original response cannot
  masquerade as that fresh policy check. Periodic retries within one attempt
  preserve the attempt, execution ID and deadline.
- Send failures are contained, pending promises and timers are released, and
  a failed post can be retried without executing the handler again.

The original Connect encryption, App-side website matching, selected-App lease,
signing identity and native database permissions remain in force. The new App
receiver must be loaded along with the Userscript; the panel reports an App
update requirement instead of presenting an incompatible receiver as Authorized.

## Automated acceptance

| Check | Result |
|---|---|
| Userscript lifecycle, receipt, signing, routing and matching unit cases | 318 passed |
| App protocol and queue lifecycle cases | 95 passed |
| App-side website scope cases | 14 passed |
| Chromium production-installer E2E | 22 passed |
| Same E2E with App GM reads blocked after authorization | 22 passed |
| WebKit isolated-world real-KDBX E2E | 10 passed |
| Legacy window/mailbox compatibility | 22 passed |
| Userscript/App/Vault typechecks, build, syntax and translations | Passed |

Both browser engines warm up with successful fills, then drop an account-list
response, a field response and a local App-window response. They also drop first
requests and verify same-request recovery. Each stress run performs 24 alternating
lookup/fill cycles, 20 periodic losses and four cancellation recoveries using the
same two physical ports and original App document. Key-toggle cancellation drops
late lookup and fill results. There are no replacement vault tabs or extra native
permission prompts.

The browser fixture separately counts logical request IDs and physical posts;
App queue unit tests assert actual handler execution once. Extra posts used the
original execution ID, crypto payload and nonce. Each Chromium audit inspected
3,021 signed envelopes, including 1,586 encrypted protocol envelopes, with no
plaintext fixture values or legacy-mailbox fallback in the direct-port flow.

Installer: **120,410 bytes**, SHA-256:
`89b0a50ebb0b7d773e8695e7d12869ce0571b96e481d8c233de337bdfa8cebf7`.

These browser fixtures use real encrypted disposable KDBX files and the actual
compiled installer. They adapt GM storage in isolated worlds and do not certify
physical iOS scheduling or the Userscripts manager. Native iPhone acceptance of
the repeated-fill fix remains pending the user's retest.
