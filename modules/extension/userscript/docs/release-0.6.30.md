# Connect 0.6.30 adds an iOS broadcast recovery option

When the normal lookup is waiting on iPhone or iPad, open **Connection** and tap
**Find accounts via relay**. A temporary page on the KeeWebX origin uses
BroadcastChannel to reach the App you already authorized. Return to the login
website if Safari opens the relay in front. Keep the relay open until you select
an account and finish filling. Connect requests its closure when the operation
ends.

The relay forwards the existing signed and encrypted messages. It does not
open another database. The original App checks the grant, website scope and
vault access. The key icon still starts the local lookup and **Reconnect to
existing tab** still offers the direct handoff.

In Chromium with the Userscripts adapter, the broadcast route completed an
encrypted lookup and fill while the App stayed hidden, the mailbox reader was
blocked, and direct discovery replies were disabled. The same test verifies
the temporary page closes after filling and an already authorized 0.6.29 App
can serve the request. Safari on iPhone and iPad can still pause the App or
relay. Native background reliability of this option is not yet established.
