# Connect 0.6.10: complete handoff before closing the helper

The production worker treated transferring a port as a completed connection and
closed the helper before the App had replied. The successful MessagePort Lab
waited for the App's actual ready packet. This was a real ordering difference;
device diagnostics also showed handoffs processed after their websites had
already abandoned them. The effect on native iOS scheduling still requires
device confirmation.

There is now one completion path: the website verifies the App's signed ready
receipt, then asks its own helper to close. A worker transfer notification cannot
close it. The updated helper also ignores premature completion from an old
worker. No extra discovery handshake, new App navigation or credential access
is added.

Further lifecycle fixes:

- Failed or canceled hellos discard ready-only ports. Reuse requires a verified
  RPC reply; a canceled attempt cannot carry timeout debt into the next tap.
- Timeout errors retain their original cause instead of being replaced by a
  later port-generation assertion.
- A queued ready event cannot beat an expired website setup deadline. The App
  rejects expired queued handoffs and removes abandoned unauthenticated peers.
- A disabled App sends an explicit rejection before closing its port. Direct
  routing previously exposed a silent close here, reproducible when revocation
  could not remove manager metadata. Vault access remains denied in both cases.
- Failed setups send a separately scoped helper-cancel command. The helper can
  close itself even when Safari denies closing it from the website; cancellation
  never claims that the App was authenticated.

Regression checks include a held App-ready packet: the helper must remain open,
no credential request may start, and release must lead to signature verification
before automatic closure. The historical implementation fails this check.
Separate tests reproduce timeout masking, cancellation debt, delayed timer/event
ordering and the silent disabled-App rejection. Real-KDBX browser acceptance
covers cross-site fills, reload/reopen, lock/unlock, revocation and helper closure.

The final installer passes 387 unit tests and focused real-KDBX acceptance:
17 cross-site fills after App reload/reopen without additional consent; attached
and fresh website revocation with App manager reads blocked and cross-window
helper closure denied, with zero additional credential-field reads. Full stress
suites also remain part of asynchronous CI. These adapters do not establish
native iOS scheduling behavior.

Update the existing `keewebx-connect.user.js`, save pending vault edits and reload
the App and websites. Both Connect panels should show **0.6.10**. Existing
database permissions are retained; explicit Disconnect still requires consent.
