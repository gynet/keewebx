# Userscripts Connect implementation and acceptance report

## Current release: 0.5.3

The user reported that the first connection worked, but testing after closing
other pages timed out; choosing Open KeeWebX then created another app. Closing
the website and helper does not revoke the app. A fresh website has no native
window association and therefore tests through the mailbox. The specific cause
of the phone's mailbox timeout has not been established.

Two recovery defects were confirmed: opening a helper did not automatically test
the original app, and its Open KeeWebX link always opened another app even when
an authorized route already existed.

**Reconnect to existing tab** now opens or reuses only a lightweight connection
page and immediately checks the original selected app using native window
messages and BroadcastChannel. It allows a bounded initial helper load. The
helper verifies the current host, reply signature, request binding, deadline,
and app identity before showing connectivity or consuming a reply. Forged
channel messages cannot consume a legitimate pending response. The new-app
link is hidden when a route exists, is malformed, or cannot be read; it is
offered only for first use with no saved selection.

Acceptance includes closing every login/helper page, retaining the original
unlocked app, then connecting three fresh websites. It also deliberately stops
app mailbox delivery, reproduces the test timeout, restores native delivery,
and fills an account while mailbox delivery remains stopped. That scenario
checks the original app document and selected host remain unchanged, there is
no new permission dialog, and the only extra page is the explicit connector.
Injected forged replies are identified separately in the transport audit.

**44 unit checks passed.** The exact installer passed **19 browser steps against
live app assets**, and the same **19 steps with storage notifications disabled**.
Both runs use real extension isolation and native browser events, a GM API
adapter, an encrypted KDBX and the app's permission dialog. They include actual
hidden/frozen lifecycle coverage, cancellation, and transport confidentiality
checks. TypeScript, syntax and deterministic bundle checks passed.

Installer: **95,567 bytes**. SHA-256:
`1970a67ca827e0952a36f6a6f2e6adf8fc3dceb1adf0f4ed227b709deb53947f`.

The prior full CI failure was a help-page test still expecting the 0.5.1 download
link. That test now compares the page link with the committed installer's version
so release updates cannot leave a stale hardcoded expectation. The New UI build
and both help-page viewports passed in Chromium and Firefox (four browser cases).

The existing 0.5.2 security and lifecycle regression checks remain applicable.
This is a verified recovery path for a transport failure, not proof of the
phone-specific timeout's root cause or a guarantee that a frozen app can run.
If the app itself does not reply, return to its existing tab and unlock if needed.

## Historical release: 0.5.2

An independent fault-injection audit reproduced defects in mailbox cleanup,
queue fairness, cancellation, delayed writes, and competing app selection.
The release fixes those paths and retains the one-authorization workflow with
no automatic connection-page opening. The [audit report](audit-0.5.2.md)
records each reproduction, correction, compatibility finding, and limitation.

Selection changes now use a shared browser Web Lock, held until the underlying
manager operation and any cancellation cleanup finish. Automatic restoration
rechecks the selected owner immediately before publication. Old host reads and
client continuations cannot resume into a newer authorization generation.
Mailbox cleanup failures cannot block delivery, reply backlogs cannot starve
requests, and late canceled writes receive completion-time cleanup.

### Acceptance

- **43 unit checks passed**, including storage fault injection, same-host and
  cross-host selection races, restoration races, replay, cancellation,
  ownership, locked vaults, and failed connector recovery.
- **17 browser steps passed against live app assets** using the exact installer,
  real Chromium extension isolation and storage, a GM API adapter, a real KDBX,
  and native vault consent.
- **The same 17 steps passed with storage notifications disabled**, exercising
  the polling path independently.
- The fixture now disables Playwright's forced visibility. Actual hidden
  documents and trusted freeze/resume events verify cancellation during a
  delayed fill and recovery after the app exceeds a request deadline.
- Cross-origin navigation, COOP isolation, repeated fills/tests, changed forms,
  lock/unlock, signed traffic, encrypted credential payloads, and no additional
  pages or permission dialogs remain covered. Neither browser run recorded
  browser errors or plaintext fixture credentials in transport/storage history.
- TypeScript, JavaScript syntax, deterministic bundle checks, and the New UI build
  passed. An unrelated Firefox CI fixture now waits for imported-file cache
  persistence before reload; its focused test passed three times without retries.

Installer: **94,392 bytes**. SHA-256:
`e234c2eb2044669f67bedec6cbacca09950bf3fce0da97a2c1801ed80ea88320`.

These are desktop and source-level results. Native iPhone Userscripts execution,
long suspension, memory pressure, and standalone PWA communication remain
unverified. Replace the existing script under the same filename, save database
changes, then reload the app and website so both show **Connect 0.5.2**.

## Historical release: 0.5.1

The user reported that one website worked but switching websites caused failure
and repeated new pages. 0.5.0 kept its connector reference in one document and
opened another page when lookup or connection testing found that reference
missing. Its earlier acceptance used separate website tabs and missed navigation
between origins within a single tab.

0.5.1 removes automatic page opening from lookup, key-panel opening, connection
testing and retry. An existing native connection is retained where usable.
When navigation has invalidated the window association, a signed manager-private
mailbox reaches the same selected app and the same single-session Connect host.
It preserves the existing encryption, signature, origin, document, session,
permission, replay and deadline checks. No remote relay is introduced.

The app receives private mailbox records through native storage notifications
where available, with bounded polling and immediate checks when the user returns
to the app. Credential payloads are encrypted. Transient records are consumed,
canceled or expired; no plaintext fixture credentials appeared in the complete
storage history. Canceling a fill stops its response reader even if storage
cleanup fails. A connection check or account lookup can continue while the user
visits the app, but switching away during credential filling still cancels it.

**Open connection page** is now an explicitly optional action. It is never used
to retry normal filling. If a website separates that optional window from its
opener, the page explains that it can be closed and normal account lookup can
use the recovery channel.

### Acceptance

- **14 unit checks passed**, including a client with no window association,
  identical host admission, and successful completion despite failed reply
  cleanup. Existing signature, replay, cancellation, ownership and lock checks
  remain in place.
- **14 end-to-end steps passed using live keewebx.app assets**, the exact
  installer, real Chromium extension isolation and storage, a GM API adapter,
  a real encrypted KDBX and native vault consent.
- Regression coverage includes four cross-origin navigations within one browser
  tab with no new page or repeated consent; a login document with
  Cross-Origin-Opener-Policy isolation; independent websites; six alternating
  fills; repeated connection tests; reload; closing an old connector; delayed
  response cancellation; lock/unlock; and signed/encrypted traffic audits.
- Updated setup instructions passed at 1280px and 320px. All four locale checks,
  application build, TypeScript, syntax and deterministic bundle checks passed.

Installer: **92,718 bytes**. SHA-256:
`a1ef6a9fa60e45d7dfe49a6b4e52debec9891324615335d63336fce1633aa870`.

The iOS Userscripts extension itself has not been certified by these desktop
checks. Device acceptance and long suspension remain unverified. The app-side
receiver changes in this release: replace the installed script, save database
changes, and reload app and website once so both show 0.5.1. Existing native
vault permissions and identity are retained. Obsolete connection pages may be
closed; they are unnecessary for normal filling.

See the [current setup guide](../README.md) and `tests/native-connect.mjs`.

## Historical release: 0.5.0

The reported failure persisted after 0.4.5: the app displayed Authorized while
website requests received no reply. Authorization state alone did not establish
reachability. This release replaces the GM request/reply queue with native
window messages, retaining the existing encrypted Connect protocol.

### Flow

1. Unlock the intended app and authorize the installed script once.
2. From a login website, open its lightweight connection page with a trusted tap.
3. Return to the website and select a matching account. Further lookups reuse
   the page and the original unlocked app; no new website consent is required.
4. If execution stops, visit the existing app, unlock if needed, return and retry.

Website-to-connection-page traffic uses pinned native window identity and exact
origin. Same-origin BroadcastChannel reaches the selected app. Signed envelopes
bind app host, endpoint, document, origin, operation, session and deadline.
Credential payloads remain encrypted by the existing ProtocolImpl/AppBridge
implementation. The connection page cannot decrypt them. GM holds only identity,
settings and routing metadata; there are no GM transport records or polling loops.

The app endpoint has one native port. One active website session therefore owns
it at a time. A fresh lookup invalidates previous handles; a busy request cannot
be stolen by another website. Canceling or navigating prevents late filling.
Native vault permissions and exact-origin form checks remain authoritative.

### Corrections included in the rewrite

- Acquire a named connection window without navigating an existing document.
  Separate window names include both app endpoint and website origin.
- Wait for the native setup response instead of failing during the first
  handshake race. Retain pending requests during same-peer setup renewal.
- Use manager tab identity for ownership across reload. Duplicated sessionStorage
  cannot silently replace the selected app.
- Invalidate pending authorization on cancellation; a late settings write cannot
  reactivate the host. Check the selected route before serving each request.
- Return an explicit locked-app result promptly, then reuse permission after
  unlock. Do not change the app’s lock policy.
- Bound request and connection-test lifetimes, and reject old sessions,
  replayed requests, invalid signatures and changed form targets.

### Verification

The exact published installer passed **13 transport security/lifecycle unit
checks**, TypeScript, JavaScript syntax and deterministic build checks. The
application build passed. The updated extension instructions passed browser
checks at **1280px and 320px**, with no retries.

**12 end-to-end steps passed** in a real Chromium extension’s isolated
content environment using native postMessage, BroadcastChannel and extension
storage, a GM settings API adapter, a real encrypted KDBX and the New UI’s native
permission dialog. The fixture used no GM request/reply simulation.

Coverage includes one authorization across two origins; six alternating fills;
connection testing; explicit reconnect without app navigation or lock; canceling
and navigating during a real delayed encrypted field response; website reload
with a preserved named connector; reopening a closed connector; prompt rejection
while locked and recovery after unlock; and a complete audit of settings writes
and signed, encrypted wire traffic. No plaintext fixture credentials or transport
queue records appeared in settings history. No payload logs or browser errors
were recorded.

Installer size: **86,598 bytes**. SHA-256:
`9e96fb8371811874b61bc65d2f5392d12dd1da53e92db96380d896023f73f67d`.

Browser fixture: `tests/native-connect.mjs`. Unit checks:
`tests/native-connect.test.ts`. Setup and reproducible commands:
[Userscripts guide](../README.md).

After publication, the same 12-step suite also passed against assets fetched
from `https://keewebx.app`, including its real connection-page response. The
released raw installer and GitHub asset matched the accepted bundle byte for
byte. The published app identified build `f450789` during this check.

The first full CI run exposed two additional issues: moving Ubuntu runners
selected an OS unsupported by the pinned Playwright version, and two new UI
help strings lacked German/French catalog entries. Follow-up changes pin the
CI runners to Ubuntu 24.04 and complete those translations. All four locale
checks pass; these follow-up changes do not alter the 0.5.0 installer.

This is desktop browser evidence, not a claim of native iPhone certification.
The installed iOS Userscripts manager, long suspension and standalone PWA
communication still need device acceptance. Manual switching to the existing
app is supported. Update the one installed script and reload app and website
once so both run 0.5.0; an old 0.4.x receiver cannot use this transport.

## Historical architecture: 0.4.5

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
[0.4.5 raw URL](https://raw.githubusercontent.com/gynet/keewebx/userscript-v0.4.5/modules/extension/userscript/keewebx-connect.user.js).
See the [current setup and validation commands](../README.md). The current
real-app regression entry point is `tests/gm-connect.mjs`; the helper acceptance
results below do not validate this new transport. Its desktop harness simulates
GM storage/injection, so native Userscripts execution, iOS long suspension,
screen lock and memory pressure remain unverified. No automatic OS wakeup is
established.

### 0.4.5 event-driven delivery

An authorized route is not evidence that the selected app is currently reading
requests. The previous app receiver depended on polling timers. This version
also subscribes to WebExtension storage changes when Userscripts exposes that
API in its content execution world. A matching request or reply key wakes the
existing GM reader immediately. Notifications are scheduling hints only:
their values are never read, and all protocol data still passes the original
GM namespace, signature, identity, origin, scope and deadline checks.

The listener checks the actual Userscripts manager identity and exact script
filename namespace, and ignores other scripts and storage areas. Notifications
arriving during a read coalesce into one subsequent read. Timed polling remains
a fallback when the API is unavailable. Pausing the host and completing or
canceling a client request removes its listener.

Both app and website must load 0.4.5 for event-driven delivery at both ends.
Updating only the website leaves an old app receiver dependent on its timers.
No hidden helper tabs, server relay, new per-website permission or auto-lock
policy change is introduced.

The Userscripts runtime implementation is referenced directly:
[content injection and API binding](https://github.com/quoid/userscripts/blob/06900223459036d2a238d93ab1af4d9f26cadbc7/src/ext/content-scripts/entry-userscripts.js)
and [per-filename storage namespace](https://github.com/quoid/userscripts/blob/06900223459036d2a238d93ab1af4d9f26cadbc7/src/ext/content-scripts/api.js).
This optional notification API is an implementation capability of that content
world, not a claimed portable GM.addValueChangeListener API.

Transport checks include delivery while all polling callbacks are withheld,
listener disposal, unrelated-script isolation and refusing to inspect event
values. Desktop real-WebExtension acceptance supplements the older simulated
GM harness. The exact 0.4.4 installer passed eight native-extension steps with
normal timers. With polling callbacks withheld, the same installer reproduced
an Authorized app and the exact reported “The authorized KeeWebX tab did not
reply” website message. The exact 0.4.5 installer passed all eight native steps
with those callbacks still withheld, including two origins and six repeated
fills. This uses real Chromium isolated content scripts, storage.local and
storage.onChanged; a small API adapter supplies the Userscripts method shapes
and namespace. It is not an installation of the iOS Userscripts extension.

The 22 transport checks and both 20-step real-app simulated-GM suites passed.
Installer: 83,265 bytes; SHA-256
`bec45ba5b970d4ac0d5600bf097bb6a7d02d2c5a53431de7eb55596145d3bcdd`.
Neither desktop fixture proves native iPhone execution or OS wakeup.

The prior complete CI run also exposed an unrelated Firefox test race: it
locked an imported vault before the initial cache write completed. The fixture
now waits for Up to date before Lock. The affected 320px Firefox test passed
with zero retries; production save/lock behavior was not changed.

### Historical 0.4.4 connection-test completion



The user reported an indefinitely displayed connection-test message. Two
reproducible software paths were repaired: synchronous cleanup API failure
could remove a pending request and its watchdog before resolving/rejecting
its promise, and cancellation through hash navigation or closing the panel
could leave the progress text displayed after the operation had ended.

Requests now settle before best-effort cleanup; disposal cannot throw because
an optional release/cleanup operation fails. Required client API grants are
checked before connecting. The entire UI test has a 15-second wall-clock
budget, including initialization, storage reads, handshake and probe. It
shows stage/elapsed time, restores controls after failure and checks the
deadline on focus/pageshow. Shared cancellation resets stale text. Constructor
errors are caught inside the test, and the panel displays Connect 0.4.4.

These are tested failure mechanisms, not a confirmed native-device root cause.
Userscripts' normal storage API methods are async, so ordinary storage rejection
does not itself prove the synchronous exception mechanism occurred on iOS.
The defensive cleanup fix covers absent or replaced methods as well.

- Installer: 82,246 bytes; SHA-256
  `13519006a19aaa3eba572da38562b1bfd09e6a5c71507545f05b12d874c5c470`.
- Transport unit checks: 20 passed. Both new cleanup regressions failed against
  0.4.3 before the repair.
- Real-app acceptance adds cleanup exceptions, a never-returning identity read,
  hash/close cancellation and multiple slow storage reads that individually fit
  their limits but exceed the total test budget. Each case verifies a subsequent
  successful retry through the same authorized app.
- The current pair and actual 0.4.0-host/new-client pair each run 20 steps with
  encrypted disposable KDBX files, real native consent and real protocol traffic.
  Their final results and publication status are recorded in the release notes.

Timers cannot run while iOS freezes a page. No automatic wakeup, native iPhone
acceptance or resolution of every reported connectivity failure is claimed.

### Historical 0.4.3 upgrade recovery



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
