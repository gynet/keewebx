# Userscripts Connect implementation and acceptance report

## Current architecture: 0.4.3

Authorize the intended KeeWebX app tab once with **Authorize Connect** and the
native **Allow** dialog for account listing. All login websites then use the
same tab through the Userscripts manager's private GM queue. On a website,
tap the key beside a login field and explicitly select an account. Normal
lookup and fill open no tab and do not submit the form. **Open KeeWebX** is an
explicit setup action. There is no helper, discovery, BroadcastChannel or
per-website Connect authorization in this default flow.

The installer requests `GM.getValue`, `GM.setValue`, `GM.deleteValue`,
`GM.listValues`, `GM.getTab` and `GM.saveTab`. Persistent private state contains
the signing identity, settings and approved route (public host ID, endpoint
and public key). Manager tab state preserves the host ID across reloads.
Session encryption keys remain in memory. Signed transient request/reply
records carry routing metadata and Connect messages; credential payloads stay
encrypted. Records are deleted after consumption or expiry while scripts can
run. The enabled app polls request keys at about 500 ms idle or 60 ms after
recent activity; websites poll only pending reply keys at about 80 ms.

Install from the
[0.4.3 raw URL](https://raw.githubusercontent.com/gynet/keewebx/userscript-v0.4.3/modules/extension/userscript/keewebx-connect.user.js).
See the [current setup and validation commands](../README.md). The current
real-app regression entry point is `tests/gm-connect.mjs`; the helper acceptance
results below do not validate this new transport. Its desktop harness simulates
GM storage/injection, so native Userscripts execution, iOS long suspension,
screen lock and memory pressure remain unverified. No automatic OS wakeup is
established.

### 0.4.3 upgrade recovery

0.4.1/0.4.2 rejected a saved route without the `canonical-1` metadata before
sending any request. That was not evidence of an incompatible live app and
could trap a valid existing authorization behind a repeated reload message.
0.4.3 performs the signed live handshake. A legacy route permits either
canonical or original JSON-order Ed25519 verification of the response; it
never accepts an unsigned reply. Existing origin, host, identity, session,
expiry, revocation and explicit account-selection checks remain in place.
The old host lacks a focus command, so Open uses its supported probe instead
of navigating the original document.

The app mirrors its public host ID between manager tab state and sessionStorage.
It reuses that ID when manager state disappears or fails, and initializes the
null returned by Userscripts before its first saveTab call. The earlier mock
incorrectly returned an empty object; the real-app harness now returns null.
A foreground return retries failed automatic restoration, including a return
that happens while the previous attempt is still pending. It does not silently
select a different app or request another per-website permission.

Regression coverage includes missing metadata with a live current host, the
actual published 0.4.0 installer as the app with a 0.4.3 website client, lost
manager tab state, manager errors, first-use null state, tampered legacy
signatures and rejection of an unrelated app tab. Four added checks failed
against the previous implementation before the repair.

- Final installer: 81,034 bytes; SHA-256
  `0eb4b4422b679cfd44819c172c95b8756ed7946a4726b67684e0e9164ae93f57`.
- Current-version real-app acceptance: all 16 steps passed using reordered
  JSON storage and actual first-use null tab state.
- Mixed-version real-app acceptance: all 16 steps passed with the immutable
  0.4.0 app installer and this exact new client, using legacy-preserving storage.
- Transport and recovery checks: 18 passed, including signature tampering,
  manager state loss, null initialization, cancellation, expiry and revocation.
- Userscript strict TypeScript and JavaScript syntax checks passed.

Both real-app runs used encrypted disposable KDBX files, one native approval,
two independent login origins, repeated fills, Test connection, Open without
reload/lock, canceled/expired replies, locked-vault rejection and historical
storage audits. No plaintext fixture credentials were persisted in GM.

Legacy interoperability requires storage to preserve the old host's signing
order. A new client cannot repair the signature verifier inside an old running
script if its manager reorders keys. The full current-version suite separately
uses reordered JSON storage. Native iOS execution remains unverified; neither
suite loads the actual iPhone Userscripts extension.

### Historical 0.4.2 repair and results

The metadata-only compatibility check described below was superseded by 0.4.3.



The 0.4.0 signature format depended on dictionary enumeration order. A storage
adapter that serializes and reorders nested keys reproduced lost requests.
0.4.2 normalizes packets to JSON values and signs canonical JSON; the same counterexample now passes. Every real-app
GM write in the new harness is JSON-serialized with reversed nested key order.
This is a native-storage compatibility model, not a native iPhone certificate.

Open previously called window.open with a URL and a reused target name. A
browser regression reproduced replacing an unlocked app with its password
screen in the same tab. The repaired action contacts an approved app through
GM, with optional focus, and never navigates it. Setup navigates only a newly
created blank target. Lock policy is unchanged; trusted widget activity and
idle locking were independently verified.

Switching to Connection cancels automatic account lookup so that Test
connection is usable. Testing has immediate progress/busy state. Independent
watchdogs reject unanswered requests even when a GM read or write never
settles. Manager calls are bounded; queue errors are reported in the app.
An incompatible older app script is detected before a new-format request.

- Exact installer: 80,656 bytes; SHA-256
  `a8b85588ec55aaea9daab688ba3f9c3d464627cd8711aa74f0c2b81a265849c3`.
- Fifteen real production-app Chromium steps passed. They include one native
  grant, two independent origins, Test connection, Open preserving the original
  unlocked document, ten alternating fills, renewal beyond the short session
  expiry, website reload, cancellation/navigation, locked-vault rejection and
  encrypted queue cleanup.
- Twelve transport checks passed, including key-order changes, undefined/null normalization, unresolved
  storage promises, old-script detection, replay, invalid signatures/scopes,
  cancellation and revocation.
- All historical GM writes were audited for plaintext fixture data and valid
  signatures. Native iOS execution and long suspension remain unverified.

### Superseded 0.4.0 desktop baseline


- Installer size: 78,515 bytes.
- SHA-256: `c37b2507b357c8be4d118dc55145d6b7c17e978a8e4f9edf0b60ae4c2c7ee064`.
- Real production-app Chromium acceptance: 11 steps passed, including two
  independently opened origins with one native consent, repeated filling,
  website reload, navigation/cancellation, expired replies and locked-vault
  rejection. The original app document and route were retained, without
  helper tabs or automatic focus changes.
- Historical GM writes were audited: no plaintext fixture titles, usernames,
  passwords or database password; signed packets verified; sensitive wire
  payloads remained encrypted; transient keys were consumed or expired.
- Seven transport-security tests passed for shared authorization, tampered
  origins, replay, deadlines, wrong scope, revocation and cancellation.
- Userscript strict TypeScript/syntax, New UI type checks and locale coverage
  passed. Native iPhone manager execution and long suspension remain unverified.

## Historical architecture and results: 0.3.x

The remainder preserves the 0.3.0 report and 0.3.1 recovery update. Their helper
pages, discovery, per-origin confirmations, permissions, artifact hashes and
test results apply only to those old versions. They are not current 0.4.0
installation instructions or acceptance results.

### Connection recovery update: 0.3.1

The standalone 0.3.1 installer fixes intermittent setup failure after repeated
use. A global helper-window name and a permanently captured initial opener
could route setup replies to an old website tab. A single discovery broadcast
also missed app tabs that resumed later; the helper fell back to opening an
app after only 2.5 seconds.

Helpers now have origin-specific names. Native source/origin/nonce challenges
associate the current website window, including a replacement tab after the
original closes. A same-origin replacement retains the selected app, original
vault document and existing permission. A different origin uses a separate
helper and requires its own app confirmation. An ordinary website opener is
never assumed to be KeeWebX.

An expired setup proof triggers a fresh challenge instead of granting access
or leaving a permanent failure. Returning to the website resumes setup.
Discovery retries are bounded and stop at the first candidate; the missing-app
fallback waits eight seconds. There is no idle heartbeat or automatic iOS wakeup.

Acceptance uses the exact 0.3.1 installer and actual encrypted disposable KDBX
files. It adds repeated explicit lookup/fill, closed-opener replacement,
delayed native proof, ordinary-opener rejection and simultaneous-origin
isolation to the original scenarios. Chromium and desktop WebKit transport
checks both verify recovery after the first discovery broadcast is withheld,
and verify that discovery stops after an app responds. The old implementation
fails that new discovery test. The accepted 0.3.0 bundle also fails the fresh
challenge requirement after its setup timeout.

The same-origin popup harness performs a separate native navigation because
Chromium can reuse its initial popup context without rerunning Playwright's
init script. This preserves real window references and native trusted events;
it does not load the actual Userscripts manager. Native iPhone execution and
long suspension remain outside the automated certification.

Install 0.3.1 over the existing script file, close old helper pages and reload
website/app tabs once after saving database changes. Keep one installed
script version. The original 0.3.0 release record below is retained with its
original artifact checksum.

### Delivered behavior

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

### Reused code and access rules

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

### Accepted artifact

- Installer: `keewebx-connect.user.js`, version `0.3.0`.
- Size: 85,191 bytes.
- SHA-256: `fa947e50408dbb1b00d47b12752d76af327d9fd0894d5366a50b9139b65c6aa3`.
- Desktop Connect package version: `1.0.4`.
- The installer includes its MIT license and requires only `GM.getValue` and
  `GM.setValue`; it runs on HTTPS top-level documents in the content context.

### Validation completed

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

### Documentation and distribution

The repository README, extension README, userscript guide, New interface's
Browser extension settings and desktop extension options describe the same
setup. Help is available before a desktop connection succeeds. Privacy
documentation distinguishes persisted signing identities from ephemeral
session keys. Extension release packaging includes the standalone userscript
and SHA-256 checksums without replacing the default web release link.

Build and test commands are in the [installation guide](../README.md).
[Discovery design and sources](tab-discovery.md) cover browser partitioning
and the separate Home Screen PWA investigation.

### Publication checks

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

### Native-device limits and final iPhone acceptance

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
