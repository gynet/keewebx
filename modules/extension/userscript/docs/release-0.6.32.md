# Connect 0.6.32 lets the temporary page close after App confirmation

In the reported iPhone trace, the website verified the App port and completed
its signed hello at 01:32:06, but stayed hidden until 01:32:32. The lookup had
already timed out when Safari returned to the website.

The temporary page can now verify the App's signed readiness receipt over a
same-origin BroadcastChannel and close before the website processes its own
copy. The website still verifies the port and establishes the encrypted
session before asking the App for accounts. The receipt contains connection
metadata only. Older App receivers can still use the website's confirmation.

If Safari refuses automatic closure, close the temporary page and return to
the login website. An authenticated iOS lookup gets up to one minute for
that return and starts its account query after the website is visible.
**Find accounts** handles setup and recovery from one action. The separate
**Find accounts via relay** button was removed.

Save vault edits, update the existing script and reload the App and the
login website to use the new closure path. Browser acceptance holds delivery
at the website's port and blocks its cross-window close. It verifies
that the temporary page still closes and that filling starts only after
the website processes its own authenticated receipt. Native iPhone
verification is pending.
