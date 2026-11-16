# Connect 0.6.0 acceptance report

Connect now carries the existing encrypted KeeWebX protocol over independent
MessagePorts to one original App. A trusted website action may open a temporary
connection page. The page closes after a signed App hello; the original unlocked
vault is neither navigated nor replaced. Further requests in that website
document reuse the direct port.

[Install in Safari](https://keewebx.app/connect-port/keewebx-connect.user.js?v=0.6.0)
· [Setup](../README.md)
· [Architecture diagram and lifecycle](messageport-connect.md)

## Verified changes

- Foreground setup caches the script identity and selected route before opening
  the helper. Hidden-App discovery and data requests do not await extension
  storage. App-side account matching, native vault permissions, request signing
  and Connect encryption are retained.
- A narrowly scoped worker transfers the endpoint to the selected original App
  and retains no endpoint. Safari's `auxiliary` window type and ordinary
  `top-level` windows are supported; nested iframe clients remain excluded.
- Both websites get separate physical ports. UI operations use bounded logical
  sessions; switching websites does not ask for another native permission.
- Reload and SPA history changes rebuild ports without replacing the App. Normal
  lock/unlock preserves transport; account access still checks the actual vault.
- Revocation immediately invalidates ports and pending work. Private route cleanup
  verifies ownership under the shared Web Lock and uses a bounded read. If that
  read fails, inactive routing metadata may remain but no revoked receiver serves
  credentials. A persistent restoration block prevents reload from silently
  reauthorizing an explicitly disconnected App.
- Canceled or failed publication leaves no previous direct grant active. Public
  storage change notifications only revoke grants and are revision checked.
  Foreground selection checks also detect selection by an older receiver before
  and after retrieving selected fields.
- Healthy replies confirm the signed handshake before helper closure. Failed
  setup and canceled requests close their temporary pages as cleanup, without
  treating them as a successful connection.

## Automated results

| Check | Result |
|---|---|
| Signing, routing, matching and lifecycle unit cases | 232 passed |
| App-authoritative encrypted website policy cases | 14 passed |
| Existing signed window/mailbox compatibility E2E | 22 passed |
| Default direct-port E2E with real KDBX and native consent | 18 passed |
| Same E2E with App GM reads blocked after authorization | 18 passed |
| WebKit 26.4 real KDBX/consent/autofill/reload smoke | 4 passed |
| Userscript/App typechecks, syntax, build and translations | Passed |

The direct-port suites verify first key/Find accounts/Test connection startup,
two independent origins, six alternating fills, repeated UI tests, hidden-App
responses in Chromium, correctly signed origin-override rejection, pending-fill
cancellation, reload, SPA history navigation, lock/unlock, fresh websites after
all previous websites close, timeout and late replies, revocation, and an actual
transport audit. Both audits inspected 1,145 signed envelopes, including 612
encrypted private-protocol envelopes, with no plaintext fixture credentials or
mailbox requests. The normal suite opened and automatically closed ten helpers.
The blocked-storage suite also cleaned up two failed discovery pages after
revocation left deliberately unverified metadata; all twelve helpers closed.

WebKit uses an isolated user world and adapts GM storage through a disposable
fixture. It substitutes only the App origin for an ephemeral HTTPS server and
records both installer hashes. It preserved the original App document and closed
all three helpers after signed hello. Headless WebKit reported `hidden: false`;
that test does not certify native background scheduling.

Installer: **110,313 bytes**. SHA-256:
`1d2889594b60843438c6ba54b6a4e6022a96d1835cb50aed94af64555cf34a9d`.

## Physical iPhone evidence and remaining acceptance

The user confirmed the separate MessagePort Lab 0.1.2 on iOS Safari with the
Userscripts manager: helpers automatically closed, two websites reached the
same original App, and repeated pongs returned in 1–2 ms while the App was hidden.
This is transport acceptance. The complete 0.6.0 credential-filling flow still
needs physical-phone acceptance. Long OS suspension, discarded tabs and standalone
Home Screen PWA discovery are not certified by desktop fixtures or short pings.
