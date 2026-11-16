# Hidden iframe relay investigation

A hidden iframe can contain the connection UI, but it must also reach an
already-open top-level KeeWebX app. Those are separate requirements.

The current relay sends signed messages through a BroadcastChannel on the app
origin. A top-level relay and top-level app share that origin's storage key.
When the same relay is embedded under a different website, browser storage
partitioning can give it a different key even though its origin is still
`https://keewebx.app`. It then cannot use that channel to reach the existing app.

## Browser probe

The controlled probe opened an app document at `https://keewebx.app/app`, an
iframe of `https://keewebx.app/connect.html` under `https://login.example.org`,
and a separate top-level connection document. All documents created the same
BroadcastChannel name. The app replied to every message it received. Routes
were local test fixtures; no account or credential data was used.

| Environment | App received iframe request | Iframe received app reply | Separate connection received app reply |
| --- | --- | --- | --- |
| Playwright Chromium defaults | Yes | Yes | Yes |
| Chromium with third-party storage partitioning enabled | No | No | Yes |
| Firefox with first-party isolation enabled | No | No | Yes |

The initial Chromium result was misleading because Playwright explicitly
disables `ThirdPartyStoragePartitioning` in its default launch arguments. The
partitioned run removed that disable entry and enabled the feature. The Firefox
run used `privacy.firstparty.isolate=true`. These probes establish a concrete
limitation of the proposed transport, not native iPhone certification.

The historical [WebKit change 230164](https://bugs.webkit.org/show_bug.cgi?id=230164)
relaxed BroadcastChannel partitioning after a storage-access grant. That behavior
was subsequently disabled by [WebKit change 232401](https://bugs.webkit.org/show_bug.cgi?id=232401).
Current WebKit BroadcastChannel code keys the channel by the top storage origin
and frame origin. The earlier change therefore does not establish a current
Safari workaround through `requestStorageAccess()`. No granted-storage-access
iframe transport was certified or shipped.

Production response headers for `/connect.html` and `/app` did not advertise
an embedding restriction during this check. Successful embedding alone would
not solve the communication partition. The installed script also currently
uses `@noframes`, so iframe injection would require a separate explicit design.

## Consequence

A hidden iframe is not a direct replacement for this top-level relay. It could
still send `postMessage` to its parent website, but that parent does not gain a
reference to an arbitrary existing KeeWebX tab. Returning to the manager-private
mailbox would retain the unresolved phone delivery issue rather than validate
a new connection path. No iframe transport has been shipped on this evidence.

The supported recovery continues to keep a lightweight connection tab open.
Closing it may require explicit reconnection when mailbox delivery also fails.
The Back to website action must verify its outcome and offer manual tab-switch
instructions when the browser does not confirm focus.
