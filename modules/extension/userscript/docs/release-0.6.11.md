# Connect 0.6.11: restore selected-App routing and remove diagnostics

Two regressions introduced with the 0.6.9 window-coordination changes are fixed:

1. A failed website settings refresh closed a healthy port and discarded an
   otherwise valid signed reply. Failed reads now block new setup while an
   existing RPC retains its signed grant snapshot. Confirmed revocation, changed
   host/key, canceled work and request deadlines still invalidate access.
2. The worker's primary-window shortcut could transfer a port to a different
   App than the one explicitly authorized. Connect again discovers and addresses
   the selected App boot. A main-window lock no longer overrides that choice.
   The singleton and its Return button still coordinate the New App interface.

The first regression reproduces against the actual RPC/port implementations:
0.6.4 and 0.6.8 accept the valid reply; 0.6.9 and 0.6.10 close its port. The new
tests cover hello and encrypted wire replies, subsequent settings recovery,
changed grants and revocation. Separate worker tests reproduce an older selected
App coexisting with a different primary-window lock holder.

## Diagnostics removed

Remote support collection, session startup, command polling, both diagnostic UI
panels and the privileged HTTP permission have been removed from the installer.
The App and handoff worker no longer forward support events. Retired server
paths return 410 without touching storage, request logging or limiter bindings;
the support workflow and CLI entrypoint have also been retired. Existing support
records expire under their original TTL without migration reads or uploads.

The release passes 373 transport tests and 216 Chromium/WebKit component checks.
Real-KDBX browser acceptance also covers 17 fills across App reload/reopen,
revocation with manager storage unavailable, and a five-second foreground
settings timeout while signed hello/probe replies continue on the same port.
No extra App navigation, helper or credential read is needed for that recovery.

The installer is about 23 KB smaller. Component tests check that the diagnostic
controls are absent and interactions make no fetch requests. Artifact tests
reject support endpoint strings and privileged upload grants in the installer.

## Upgrade

Update the existing `keewebx-connect.user.js`, save vault edits and reload the
App and website tabs. Both Connect panels should show **0.6.11**. Existing
database pairing and permissions are retained. No remote diagnostics setup is
needed. Local automated acceptance does not establish native iOS behavior.
