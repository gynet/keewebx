# Connect 0.6.31 restores direct handoff on iPhone and iPad

Tap the key beside a login field to open a temporary connection page. The
existing KeeWebX App signs the handoff and the temporary page closes. Connect
uses that port to query for matching accounts and fill the account you choose.
On iPhone and iPad, Connect waits for the login website to be visible before
querying the vault. With the single-match preference enabled, one key tap
can complete the fill.

Connect can fall back to the local mailbox after a classified setup failure.
A recently verified mailbox reply can avoid another popup for the same page
and grant. **Find accounts via relay** is available in Connection for the
same-origin broadcast route.

Acceptance covers an unfocused key tap, consecutive fills across websites,
automatic helper closure, the website returning to the foreground, the local
fallback, the explicit relay and denial when the vault is locked or the
grant is revoked. The iOS route tests run in a desktop browser with the
Userscripts storage adapter. Native iPhone background scheduling remains
unverified.
