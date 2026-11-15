# Native Connect 0.3.0 implementation and acceptance report

## Delivered behavior

KeeWebX Connect now has an experimental standalone Userscripts installer for
iOS Safari. A key button beside a login field opens a compact account picker.
Users explicitly select an account; the script fills username/password fields
without submitting the form.

First setup opens a small `connect.html` rendezvous page. BroadcastChannel
discovers cooperating, independently opened KeeWebX app tabs. Each displays
the requesting website's exact HTTPS origin. The user confirms **Connect this
tab** in the intended app; only that instance wins the selection. Its existing
document, open database and unlocked session remain in place. If no app
responds, the helper navigates to the normal app for database opening.

The helper remains a local relay and must stay open with the chosen app. A
related named window can be reused. A change of website origin requires a
fresh handshake and confirmation. No server relay, post-robot dependency,
GM mailbox polling or idle heartbeat is used. Bounded setup retries only
handle the initial window readiness handshake.

## Reused code and access rules

- The existing Connect protocol, TweetNaCl encryption, identity pairing,
  native permission dialog and vault permissions remain authoritative.
- Protocol runtime injection removes the userscript's dependency on Chrome
  runtime APIs. The desktop extension retains its default runtime.
- Username/password filling uses the shared extension DOM helpers, including
  native value setters and input/change events for framework compatibility.
- Discovery and relay carry identifiers, website origin, public handshake
  metadata and encrypted protocol payloads. The helper does not decrypt fields.
- Only exact HTTPS-origin matches are listed. No field read occurs before an
  explicit account choice. Lock, permission, target and lifetime checks precede
  filling; changing the form during input handlers stops further writes.
- Helper cancellation cancels pending app authorization. Origin pinning occurs
  before cancel/hello handling. Absolute deadlines fence delayed confirmation,
  authorization and credential replies even if browser timers were paused.
- Persistent GM state is limited to the signing identity and app address.
  Session encryption keys and credential values are not persisted there.

## Accepted artifact

- Installer: `keewebx-connect.user.js`, version `0.3.0`.
- Size: 85,191 bytes.
- SHA-256: `fa947e50408dbb1b00d47b12752d76af327d9fd0894d5366a50b9139b65c6aa3`.
- Desktop Connect package version: `1.0.4`.
- The installer includes its MIT license and requires only `GM.getValue` and
  `GM.setValue`; it runs on HTTPS top-level documents in the content context.

## Validation completed

| Check | Result and scope |
| --- | --- |
| Application production build | Passed, including the standalone helper with no app JavaScript or service-worker registration |
| Chrome, Edge and Firefox package builds | Passed; Firefox build package is unsigned |
| Userscripts strict TypeScript and JavaScript syntax | Passed |
| Desktop extension unit tests | 225 passed, including 25 protocol-runtime/crypto validation cases |
| Real-app Chromium acceptance | Six scenarios, 43 passing stages using the exact installer above |
| Form destination/lifetime tests | 16 passed across Chromium and desktop WebKit |
| Native BroadcastChannel transport | Eight passed across Chromium and desktop WebKit, including delayed trusted commits with withheld timers and discovery expiry |
| App and disconnected extension setup instructions | Rendered successfully; download/guide URLs checked |
| Authored userscript language | English source, comments, UI and documentation; no CJK matches |

Real-app acceptance opens real encrypted disposable KDBX files through the
New interface and approves its actual native Connect dialog. It covers:

1. App-first setup, encrypted matching, explicit fill and navigation rejection.
2. Website-first missing-app opening, authorization and related named-window
   reuse without an app reload or a second unlock.
3. Two independent original app tabs with distinct matching credentials:
   only the selected app is listed/read, neither original is reloaded, no
   credential is read before selection, and no login form is submitted.
4. A delayed genuine confirmation from the other app cannot steal the chosen
   connection. Locking the selected database stops filling and never falls
   back to the other app.
5. A different HTTPS origin in the same website window cannot cancel or
   bootstrap a connection approved for the original origin. The fixture
   preserves actual native message delivery so the origin guard is exercised.
6. Restarting or closing the helper cancels native authorization; stale Allow
   actions cannot grant access. A fresh explicit approval enables normal fill.

The harness simulates Userscripts' GM storage/injection and runs the bundle
in Chromium's main world. App, KDBX, permissions, encrypted protocol and form
filling are real. It does not load the Userscripts extension or certify its
isolated execution environment. Supplemental lifecycle regressions are
maintained alongside this acceptance; see their current test output.

Supplemental real-app cancellation acceptance passed: restarting or closing
the helper removes the pending native Allow dialog, detached late Allow
actions do not persist approval, and a fresh explicit approval is required
before listing/filling. The transport tests independently check absolute
expiry while withholding normal timeout callbacks.

## Documentation and distribution

The repository README, extension README, userscript guide, New interface's
Browser extension settings and desktop extension options describe the same
setup. Help is available before a desktop connection succeeds. Privacy
documentation distinguishes persisted signing identities from ephemeral
session keys. Extension release packaging includes the standalone userscript
and SHA-256 checksums without replacing the default web release link.

Build and test commands are in the [installation guide](../README.md).
[Discovery design and sources](tab-discovery.md) cover browser partitioning
and the separate Home Screen PWA investigation.

## Publication checks

- [Release v1.0.4-extension](https://github.com/gynet/keewebx/releases/tag/v1.0.4-extension)
  contains Chrome/Edge ZIPs, the unsigned Firefox XPI, the standalone installer
  and `SHA256SUMS.txt`. All four downloaded files passed their published
  checksums; the downloaded installer exactly matched the accepted artifact.
- [The packaging workflow passed](https://github.com/gynet/keewebx/actions/runs/43754769426).
  Bun 1.3.11 is pinned for byte-reproducible installer checks, and packaging
  creates the extraction parent directory before validating archives. An
  existing immutable tag can be rebuilt through the workflow's optional
  `release_tag` input. The default web release remains `v0.4.10`.
- The hosted app reported build `6fd5272`. Its `connect.html` returned the
  685-byte lightweight helper without app scripts. The original app tabs are
  not redirected or reloaded by discovery.
- The complete database acceptance ran against a local production build.
  An additional browser attempt against the live origin was blocked before
  app loading by the runner's IPv6 network (`ENETUNREACH`). Live verification
  therefore covers HTTP route/build identity and public artifacts; it is not
  a claim of a completed production-browser or native iPhone E2E run.
- Full repository CI continues independently of publication. The checks above
  describe the scoped acceptance and successful release workflow, not an
  assertion that every unrelated repository job has passed.

## Native-device limits and final iPhone acceptance

Complete iPhone autofill, long hidden-tab delays, screen lock and memory
pressure remain unverified. The earlier user-reported iPhone post-robot probe
returned in 2–3 ms from a hidden, unfocused page; that was transport-only and
does not establish the new relay's full native behavior.

Standalone Home Screen PWAs are not claimed as supported. They can have
separate storage/lifecycle behavior, and Userscripts injection in a true PWA
was not established. Opening the URL in Safari does not inherit the PWA's
unlocked memory. No WebRTC or cross-device relay is included.

On an iPhone with Userscripts enabled, final acceptance should install the
single script, disable both old probes, open two independent app tabs,
confirm the intended one and fill a disposable login. Repeat after background
delays, a site-origin change, app lock, helper closure and a canceled approval.
Expect rejection rather than filling from another app when a connection is
invalid. Safari may decline a programmatic focus request; select the original
website tab manually in that case.
