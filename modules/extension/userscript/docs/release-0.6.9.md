# Connect 0.6.9: main-App lifecycle recovery

App reloads could leave a website targeting an old document. Canceling a physical
connection could discard a newer authorization read, and a promoted New App
could be blocked by the previous tab owner's saved selection. Both conditions
are now covered by regression tests.

The default New App now has one routing path: the browser-held primary lock and
its lifetime client locator identify the destination, the temporary helper
transfers one port, and the website verifies signed readiness and the encrypted
handshake. This route does not wait for an additional discovery acknowledgement.
Older deployments retain the existing discovery fallback. The worker never
changes the requested App identity or grants database access.

The sole primary can restore an existing identity only after unlock, pairing and
listing-permission checks. Checking, secondary and departing Apps cannot serve
or restore the grant. Explicit disconnect still blocks automatic restoration.
Websites refresh manager settings before connection actions become available;
newer reads supersede older reads independently of physical-port cancellation.
Read failures clear the cached target instead of leaving it usable.

## Upgrade

Update the existing `keewebx-connect.user.js` in Userscripts. Save pending vault
edits, reload the original App and login websites, and confirm **Connect 0.6.9**
at both ends. Unlock the existing App. Its previous database permissions remain
in force; a fresh installation or explicit Disconnect still needs authorization.

## Validation

- 370 userscript tests cover routing, grant restoration, revocation, request
  binding, signature validation, cancellation and receipt replay boundaries.
- Browser tests use the production installer, native ports, a real encrypted
  KDBX and the native permission dialog. The lifecycle case reloads the App,
  closes and reopens it under a different tab owner, delays manager reads and
  completes 17 fills on two origins without another consent. The old 0.6.8
  installer fails the same readiness test. A fresh site also proves that the
  primary route works without a discovery acknowledgement.
- The full Chromium suite passes 31 steps, including 24 alternating fills,
  lock/unlock, passkey restoration, revocation and legacy discovery fallback.
- Desktop WebKit passes 15 steps with 24 alternating lookup/fill cycles, loss recovery,
  cancellation, website reload, helper closure and preferences.
- Compatible 0.6.8 and 0.6.9 installers connect in both directions, including
  lost and delayed hello responses. This does not remove lifecycle bugs from
  an old installer; update both endpoints for the fixes in this release.

Native iOS Userscripts confirmation remains pending. Browser adapters do not
establish real-device behavior. Connection deadlines and cryptographic checks
are not relaxed by this release.
