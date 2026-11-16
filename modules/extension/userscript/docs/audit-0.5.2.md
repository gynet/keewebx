# Connect 0.5.2 independent audit

This audit started from the published 0.5.1 implementation, rather than treating
its passing desktop tests as proof of reliability. It examined cancellation,
manager failures, app selection, cross-origin navigation, background lifecycle,
and credential delivery. Reproductions use disposable accounts only.

## Confirmed defects and corrections

| Trigger reproduced against the earlier code | Result before correction | Correction |
| --- | --- | --- |
| Request deletion rejects | Valid requests never reach the host | Cleanup is best effort; host signatures and replay checks still govern delivery |
| 128 unexpired replies precede a request | Every scan misses the request | Request processing has its own rotating batch, independent of reply cleanup |
| Stop/restart while a storage read is awaiting completion | An old read delivers into the resumed generation | Check the mailbox generation after every await and before replying |
| A storage write completes after timeout and cancellation | An abandoned record reappears after cleanup | Attach cleanup to the underlying write's completion, not only its timeout wrapper |
| Cancel/re-authorize or revoke/re-authorize while a route operation is delayed | Earlier cleanup removes the replacement authorization | Serialize the complete route operation, including delayed completion and cleanup |
| Another app tab is selected during an earlier tab's delayed write or revoke | The newly selected route disappears | Coordinate route mutations across app tabs with an exclusive Web Lock |
| Automatic restoration waits in the native permission handshake while another tab is selected | Restoration silently selects the earlier app again | Recheck the selected owner inside the route lock immediately before restoring |
| Pause/resume during the host's selection read | An old hello replaces the current website session | Bind admission and replies to the authorization generation |
| The optional connector closes during setup | Recovery aborts before using the available mailbox | Drop the failed window reference before checking cancellation and recovering |
| Dispose between the selection await and request publication | A canceled client still publishes a request | Recheck client liveness immediately after the await |

Additional regression checks cover a failed individual record read, more than
one batch of undeletable requests, expiry of abandoned app records, delayed
reply cleanup, missing/rejected Web Locks, and explicit recovery after lost or
failed manager tab metadata. Duplicate tabs still cannot silently take over.

## Selection and cancellation boundaries

Web Locks coordinate only route changes; ordinary requests and fills do not
take that lock. A caller timeout does not release the lock while its underlying
storage operation is still running. Queued authorization checks its generation
again before writing. An unavailable lock fails explicitly instead of allowing
uncoordinated selection. If storage never completes, another selection can time
out; this avoids accepting two conflicting changes. Normal recovery is to
return to the existing app and retry after the manager responds.

Selecting a different app is an explicit action. Automatic restoration cannot
replace that choice. Cancellation, navigation, a changed form, expired requests,
and switching away during credential filling prevent a late password fill.
Lookup and connection testing may remain pending while the user visits the app.

Mailbox records use the same signed envelopes, host admission, replay checks,
session binding, and encrypted Connect payloads as native window transport.
Cleanup is not an authorization decision. Removing a record unsuccessfully
must neither block a valid request nor let it execute twice. Expiry cleanup
also visits abandoned host records without deleting identity, settings, or
unexpired records for other hosts.

## Browser acceptance improvement

The earlier Playwright fixture forced every tab to appear visible. Merely
calling `bringToFront()` therefore did not test background cancellation.
The revised fixture disables Playwright's focus override on its original CDP
session. It checks real `document.hidden` and trusted browser `freeze`/`resume`
events; it does not fake those events in application JavaScript.

New browser scenarios include hiding a website while its real encrypted field
reply is delayed, replacing the password field synchronously during username
input, and freezing the app beyond a lookup deadline. The expired lookup must
leave fields empty; returning to the same app must permit a fresh fill without
another page or permission dialog. Both native and mailbox traffic are audited
for signatures, encryption, and absence of plaintext fixture credentials.

## Official Userscripts compatibility

The API review checked the official implementation at
[`06900223459036d2a238d93ab1af4d9f26cadbc7`](https://github.com/quoid/userscripts/tree/06900223459036d2a238d93ab1af4d9f26cadbc7),
covering `getValue`, `setValue`, `deleteValue`, `listValues`, `getTab`, `saveTab`,
`GM.info.script.filename`, and content injection. No unsupported API call or
metadata-shape mismatch was found. Storage event access is optional; polling
must work when that access is absent.

Manager values are namespaced by the installed script's filename. Upgrading
must replace the same installed file, not create a renamed duplicate. The tab
metadata store is separate from persistent values. If that metadata is lost,
explicitly selecting the intended app recovers without weakening duplicate-tab
protection. Whether a particular iOS lifecycle event clears that metadata was
not established by this review.

## Verification limits

The browser fixture runs the exact installer in a real Chromium extension's
isolated content world, with native extension storage, a small GM API adapter,
a real encrypted KDBX, and the app's permission dialog. It is not the installed
iOS Userscripts extension. Native iPhone behavior under long suspension, memory
pressure, manager restart, and standalone Home Screen PWA isolation remains
unverified. No wrong-origin credential disclosure was demonstrated in this
audit; the negative tests are not a blanket security certification.

See the [release acceptance results](release-report.md) and
[installation and reproduction instructions](../README.md).
