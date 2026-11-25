# Connect 0.6.28 starts locally on iPhone and iPad

With 0.6.27, the temporary connection page could be ready while an authorized
App was still waiting to receive the worker's discovery message. In the paired
Safari trace, the first App callback ran 1,688 ms after the worker sent it, as
the App became visible. Nine protocol exchanges then finished in about 202 ms.
[Paired dispatch analysis](https://github.com/gynet/keewebx/blob/d153ed1d5c627460bdc6c242ce1e2f36cee26304/modules/extension/userscript/docs/dispatch-analysis-0.6.27.md).

0.6.28 sends a fresh signed hello through manager-private local storage when
Userscripts on iPhone or iPad has an authorized App with mailbox support. The
website can start listing and filling when the App replies over this path, even
when worker discovery is unavailable. Signed packets use the existing Connect
identity, and account and field requests use the existing encrypted protocol.
The App still matches entries and checks vault permissions for each operation.

If local delivery fails, retry promptly to start a direct handoff from the
trusted tap. The choice lasts up to 30 seconds for the same page and App grant.
**Reconnect to existing tab** in Connection always requests direct handoff.
The temporary page closes after signed App readiness is verified.

| Scenario | Verification |
| --- | --- |
| Worker discovery replies unavailable | 0.6.27 stalled in the control run. 0.6.28 filled on two sites and a reopened website while the App stayed hidden. The local path opened zero helper pages. |
| Reopen the App | A saved encrypted database reopened with the existing grant. A new lookup filled from the new App document. |
| Locked vault or revoked grant | The default local path returned no credentials. Unlock restored filling without new consent. |
| Close the panel during a delayed lookup | The canceled operation left the fields empty. A later trusted lookup succeeded. |
| Local delivery failure | The next trusted lookup opened one temporary page, authenticated the original App and filled over a fresh port. |

These checks use a real encrypted test database and App consent, a desktop
browser with an iPhone user agent, and an adapter for Userscripts storage.
The App used the released 0.6.27 receiver in the upgrade test, so an already
unlocked App at 0.6.27 can stay open while the login page loads 0.6.28.
Physical iPhone and iPad acceptance is pending. A fully suspended App may still
need one visit so the browser can resume its execution.
