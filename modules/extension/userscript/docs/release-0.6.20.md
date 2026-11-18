# Connect 0.6.20

Tapping the key beside a detected login form now starts the existing connection
test when no login field has been selected. The panel shows connection progress
and the signed reply result without requiring a second Test connection tap. An
available connection is reused; a temporary handoff page opens only through the
existing connection path when needed. The test does not list accounts or read
credential fields, including when single-account autofill is enabled.

Tapping the key after selecting a login field retains the existing lookup and
optional single-account autofill behavior. Page load, form detection and synthetic
focus do not initiate connections. The trusted key click starts the existing path
synchronously, preserving browser popup user activation.

Recovery no longer pins future operations to the mailbox for two minutes. Each
new trusted lookup attempts the direct connection again; a working physical port
can be reused, while account results and the encrypted session are created anew.
The current operation may still use the existing authenticated mailbox recovery.
This removes a reproduced cross-operation transport preference; it does not claim
to fix the separately reported native iOS stall after several successful RPCs.

A helper that disappears during browser-client revalidation now reports a distinct
recoverable transport failure. It can enter existing recovery only after the saved
App grant is revalidated. Malformed attachments and denied authorization still fail
closed. Selected-App discovery, signed-ready verification, encryption, deadlines,
request receipts and database permissions are unchanged.

The explicit **Record local connection events** preference now survives reloads
and new App/website tabs in this installed script. Only the boolean is persisted.
Each tab keeps at most 300 sanitized events in memory; no logs are uploaded or
retained across reloads. A late settings read cannot override a new user choice.
Storage failures do not block connection actions. No remote diagnostics are added.

Update the existing script, save pending vault changes, and reload the original
App and login website once to load 0.6.20. Existing identity and approval remain.

The [connection architecture](connection-architecture.md) describes the actual
code paths, state lifetime, security boundaries and recovery limits. Automated
browser acceptance uses desktop Chromium and WebKit with the actual installer
and an encrypted disposable KDBX. It does not certify native iOS Userscripts.

Local verification: TypeScript and the App build passed; 591 unit tests,
32 Chromium acceptance scenarios and 17 WebKit acceptance scenarios passed.
The App protocol suites passed 111 tests in separate processes, matching CI's
module-mock isolation. The legacy transport passed 22 browser scenarios, and
the focused mailbox recovery run passed all seven scenarios, including a
locked vault, a canceled fill and retained local logging preferences.
A targeted browser regression fails with the old fallback preference and passes
with its removal: one recovery followed by three fresh direct queries and fills.
Helper classification tests fail before the fix and pass afterward, including
unchanged rejection of malformed requests and invalid origins.
