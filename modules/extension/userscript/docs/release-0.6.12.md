# Connect 0.6.12: movable App launcher

The App's Connect key can be dragged away from the main toolbar with a mouse
or touch pointer. A normal click still opens the panel; dragging does not.
The App origin remembers the non-secret position locally. Viewport changes
keep the key and its panel reachable. Focused arrow keys also move the key.
Website field icons remain attached to their fields.

The encrypted protocol, App selection, authorization and port lifecycle retain
the 0.6.11 implementation. Remote diagnostics remain removed. No support polling
or new Userscript permissions are introduced.

App 0.4.11 also simplifies the password generator, keeps updates silent during
unlocked sessions, and restricts local HTML networking to website icons. See
[the local installation policy](../../../../docs/self-host.md).

Verification uses desktop Chromium and WebKit for launcher interactions, plus
the existing transport unit and component suites. Desktop WebKit does not
establish native iOS behavior.
