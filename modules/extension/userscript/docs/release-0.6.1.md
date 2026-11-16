# Connect 0.6.1 receiver hardening report

[Install in Safari](https://keewebx.app/connect-port/keewebx-connect.user.js?v=0.6.1)
· [Setup](../README.md)
· [Architecture and lifecycle](messageport-connect.md)

## Problem and change

Physical iOS Safari testing of 0.6.0 reported an eight-second discovery timeout
while the original App showed Authorized. The separate MessagePort Lab had
already returned hidden-App pongs successfully on that phone. The production
receiver introduced additional silent admission conditions; this release aligns
public discovery with the tested transport and makes receiver failures observable.

- Install the ServiceWorker message receiver without accessing WebStorage.
  A startup failure cannot be presented as a usable direct authorization.
- Answer discovery from in-memory state after checking the exact worker URL,
  protocol marker and transferred port. Do not read GM or WebStorage on that path.
- Match the Lab's worker/port checks rather than rejecting public discovery on
  `MessageEvent.isTrusted`. This is compatibility hardening, not a demonstrated
  WebKit trust-flag defect. Synthetic metadata discovery does not authorize data.
- Report an endpoint mismatch explicitly. Previously the worker could find a
  client with the same path while its receiver silently rejected a different
  saved full address. This is a concrete reproducible defect; it has not been
  established as the cause of the reported phone failure.
- Show a bounded App-side Connection diagnostics log for receiver registration,
  source/address/port checks, attachment admission and signed hello receipt.
  Logs contain no credentials, keys, website URLs or account names.
- Keep the same script filename, private identity and encrypted Connect protocol.
  Port attachment and actual requests still fail closed if the selected App lease
  cannot be verified. Signature, physical-port origin, document, scope, deadline,
  replay, vault lock and native database permission checks remain in place.

## Validation

Targeted unit coverage includes receiver startup without the WebStorage getter,
authorized discovery with both storage APIs unavailable, explicit endpoint
mismatch responses, wrong worker rejection, inactive lease rejection and pinned
physical origin/connection IDs. It also checks that accepting a discovery probe
cannot admit unsigned, tampered or unselected credential requests.

The real-KDBX Chromium suite covers two origins, repeated encrypted fills,
automatic helper closure after signed hello, refresh and SPA navigation,
cancellation, timeout/late replies, lock/unlock, revoke and transport auditing.
A separate run blocks all App GM reads after authorization. WebKit acceptance
uses an isolated user world and a GM fixture for encrypted listing, filling,
second-site use and website reload against the same original App.

| Check | Result |
|---|---|
| Receiver, signing, routing, matching and lifecycle unit cases | 245 passed |
| App-authoritative encrypted website policy cases | 14 passed |
| Direct-port Chromium E2E with real KDBX and native consent | 18 passed |
| Same E2E with App GM reads blocked after authorization | 18 passed |
| WebKit 26.4 isolated-world real-KDBX smoke | 4 passed |
| Existing signed window/mailbox compatibility E2E | 22 passed |
| Userscript/App typechecks, syntax, build and translation checks | Passed |

Installer: **111,948 bytes**. SHA-256:
`6cea50433a40d60f1bb0cb0dbf748037622758b17ea840bb19893c9b5ec073b9`.

Each Chromium transport audit inspected 1,145 signed envelopes, including 612
encrypted sensitive-protocol envelopes, without plaintext fixture values or a
legacy mailbox fallback. WebKit preserved the original App document and closed
all three helpers after signed hello.

Desktop WebKit does not certify the complete physical Safari/Userscripts environment. The exact phone-side rejection remains
unconfirmed; the new diagnostics distinguish transport receipt and admission
without treating a previous Authorized label as proof of receiver health.
