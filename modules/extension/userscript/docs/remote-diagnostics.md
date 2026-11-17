# Opt-in remote Connect diagnostics

In the script's **Connection** panel, turn on **Enable remote diagnostics for
1 hour**. The switch is available both beside a website login field and in the
KeeWebX App's Connect panel. The panel displays a support ID, upload status and
expiry time. The ID identifies a report; it grants no access to logs or commands.

Keep the existing script filename. The script manager's private storage shares
the temporary diagnostic grant between App and website instances. Existing
instances refresh that grant on manager storage notifications, focus and active
diagnostic polling. They do not need a new vault or a second Connect authorization.
Load the updated script in each participating tab to capture both ends.

## What is sent

The reusable TypeScript client accepts only an explicit schema of connection
events, fixed stage/error codes, booleans, bounded timings and counters. Each
document gets a temporary random client ID and ordered event numbers. `layer`
distinguishes the website, the App's Userscript receiver, the App runtime and the
handoff service worker. No raw logger arguments, exception messages, stacks,
website URLs, database names, entry values, passwords, ciphertext or signing keys
are uploaded. Unknown properties and arbitrary strings are discarded by the
client; the Worker independently validates the entire request.

Temporary request and port UUIDs correlate each send, receive and validation
decision without identifying a website or account. The receiver count exposes
duplicate runtimes. A bounded 128-event backlog preserves short bursts; each
upload still contains at most 32 combined events and command results. Client
release versions are metadata, independently bounded by the Worker rather than
required to match one hard-coded release.

Collection and network requests are off by default. Enabling diagnostics starts
a new temporary collection; old local logs are not uploaded. It does not grant
vault access, list accounts or fill a form. Support requests use the script
manager's privileged HTTP adapter to `https://keewebx.app/api/connect-diagnostics/`.
They omit cookies, do not need website CSP changes, and do not proxy credentials.
The upload token stays in private script storage and HTTP authorization headers.
It is never shown in the page, a URL, a support report or a workflow artifact.

The Home Screen PWA investigation is paused. This feature diagnoses the current
Safari tab connection; it makes no new claim about standalone PWA discovery.

## Read-only commands

Support can queue only these reviewed commands for an enabled session:

| Command | Observation |
|---|---|
| `snapshot` | Local Connect lifecycle, grant, visibility and pending-work state |
| `ping` | Diagnostic channel round trip and current document availability |
| `receiver-check` | Receiver state; on the App, a bounded read-only snapshot of the main App connector |

These are built-in TypeScript handlers, not remotely supplied JavaScript. There
is no `eval`, console access, DOM scraping, account search, field read, unlock,
lock, navigation, reload or permission mutation command. Adding another handler
requires an ordinary reviewed code release. A command expires after at most one
minute. The client rejects unknown, expired, incorrectly targeted or repeated
commands, and ignores results from an old or disabled session.

## Support loop

1. Enable the switch and reproduce the connection failure in the original tabs.
2. Support retrieves the sanitized event timeline from the hosted Worker using
   its private, authenticated diagnostic tooling. Public upload credentials
   cannot query reports or create commands.
3. Support queues a selected read-only check, then reads the matching command
   result and client ID. Discovery start, reply and timeout events distinguish
   App receipt from Worker acknowledgement.
4. A fix is tested against the failing lifecycle, then released normally.
   A subsequent diagnostic observation can confirm the new behavior on the
   actual device. Desktop WebKit tests do not certify native iOS execution.

Disabling the switch immediately stops this document, aborts in-flight requests,
clears its pending events and commands, and removes the shared opt-in. Other
instances stop when they observe the change or next poll. Their active session
also expires automatically after one hour. Stored diagnostic records expire
with the server session; disabling is not a claim of immediate historical
record deletion. Network, manager-storage or support-service failures leave
Connect's credential path independent and show a fixed diagnostic status.
Private support workflow artifacts have a separate one-day retention policy.

## Reuse boundaries

`modules/diagnostics` contains the pure client, allowlist schema and command
lifecycle. Storage, transport and safe-state readers are injected interfaces.
It imports no GM APIs, extension globals, vault models or UI framework.

`userscript/src/diagnostics.ts` owns the GM storage/HTTP adapter and trusted UI
events. `ui-kit/connect/diagnostics-settings.tsx` is a controlled Preact view.
The main App's `diagnostic-events.ts` exposes only fixed lifecycle observations
while the temporary opt-in is enabled. The handoff worker receives only the
expiry of that opt-in and forwards fixed metadata; it never receives the upload
token. A browser extension can reuse the same client and view with different
storage and HTTP adapters.
