# First-time discovery of an existing KeeWebX tab

## Current implementation

The installer supports a top-level `connect.html` helper. Its window stays
related to the login website, while BroadcastChannel discovers cooperating
KeeWebX app tabs in the same origin/storage partition. The website and app
need no previous opener relationship.

1. A trusted website tap opens or reuses the connection page. A native
   postMessage challenge binds it to the real opener and website origin.
2. Discovery shows the exact requesting origin in each cooperating app tab.
   It does not read a vault or grant permissions.
3. The user chooses **Connect this tab** in the intended app. The helper
   commits only one winner; another app's delayed confirmation cannot steal it.
4. The chosen original app uses the existing Connect identity, encrypted
   handshake and native permission dialog. Canceling the helper also cancels
   pending native authorization.
5. The helper relays encrypted wire messages. The original app retains its
   document, database and unlock state. Requests and replies are bound to the
   selected instance, helper, origin, epoch and absolute deadlines.

The relay forwards protocol ciphertext and handshake metadata; it does not
hold the client protocol instance or decrypt vault fields. A channel name or
successful discovery is not authorization. No password is stored in GM or
broadcast as plaintext. Normal lookup still requires a trusted account choice
before reading fields, fresh vault/permission checks, and a valid destination.

The helper pins the confirmed website origin before accepting cancel/hello
or credential requests. Changing origins requires a fresh helper handshake
and explicit app confirmation. Locking the selected app fails closed; another
open app is never used as an automatic fallback.

If no cooperating app responds in the short discovery window, the helper
navigates to the normal app so the user can open and authorize a vault. An
unavailable or suspended app can look like a missing app. Browser permission,
COOP/opener isolation, storage partitioning and lifecycle limits still apply.

## Verification and browser boundaries

Chromium acceptance uses real encrypted KDBX fixtures, two independently
opened original app tabs with different matching entries, and the app's real
permission dialog and encrypted protocol. It verifies the chosen-only listing
and filling, absence of premature field reads, no submission, unchanged
original document lifetimes, delayed-confirmation rejection and lock rejection.
Only GM storage/injection is simulated. This is not native iPhone certification.

BroadcastChannel supports unrelated same-origin contexts but does not return a
WindowProxy. The helper remains a relay. Named windows remain a best-effort
reuse path, not a browser-wide directory. A cross-origin embedded iframe is
not interchangeable with a top-level helper because WebKit partitions its
channel/worker context. A cooperating service worker could discover clients
inside its storage key but cannot itself access the vault's unlocked memory.

## Home Screen PWA

Treat the standalone PWA as a separate target. Opening its URL in Safari does
not itself expose the existing PWA document or its unlocked vault. Apple
documents separate web-app/browser storage, and Userscripts maintainers
historically reported that standalone PWAs do not load Safari extensions.
That injection finding needs verification on the target iOS release.

Storage isolation alone is not proof that every explicit window, native or
network relay is impossible. However, no supported direct Safari Userscripts
API for discovering and attaching to a standalone KeeWebX PWA was established
by this review. A PWA would likely need app-side cooperation; background
suspension remains a separate constraint. A Home Screen bookmark configured
to open in Safari is different from a standalone web app.

## Smallest useful device experiment

- Open KeeWebX independently before visiting the login test site. Record a
  random in-memory page marker without reading any vault credentials.
- Open only the same-origin helper from the site and test discovery/replies
  over BroadcastChannel. Confirm the original marker, document lifetime and
  navigation count remain unchanged.
- Repeat with multiple app tabs, wrong origins, revoked/expired requests,
  background delays and a locked phone. A timeout must fail closed.
- Repeat separately in a true standalone PWA, checking script injection,
  opener/channel visibility and application lifetime. Do not infer PWA
  behavior from desktop WebKit or from an ordinary Safari tab.

## Sources

- [HTML named navigable rules](https://html.spec.whatwg.org/multipage/document-sequences.html#navigable-target-names)
- [HTML BroadcastChannel rules](https://html.spec.whatwg.org/multipage/web-messaging.html#broadcasting-to-other-browsing-contexts)
- [WebKit: BroadcastChannel in Safari 15.4](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/)
- [WebKit cross-origin named-target restriction](https://bugs.webkit.org/show_bug.cgi?id=190475)
- [WebKit BroadcastChannel partitioning](https://bugs.webkit.org/show_bug.cgi?id=232401)
- [Service Worker clients.matchAll](https://w3c.github.io/ServiceWorker/#clients-matchall)
- [Apple: What is new in web apps](https://developer.apple.com/videos/play/wwdc2023/10120/)
- [Userscripts standalone PWA discussion](https://github.com/quoid/userscripts/issues/251#issuecomment-1119147100)
- [Safari 26 Open as Web App setting](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
