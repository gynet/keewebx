# Connect 0.6.19

Closing the App panel during repeated authorization could stop its receiver while
leaving the UI marked Connected. Opening the panel or returning to the App then
skipped restoration. The canceled attempt now clears its UI state and restores
the previously approved grant through the existing unlock and permission checks.
Closing a panel also no longer cancels automatic restoration at startup.

Canceling first-time permission approval cannot authorize access through a late
reply. Disconnect and database lock still stop access, including queued recovery.
The lifecycle regression test fails against the previous implementation and
passes with this change. Browser acceptance uses the actual installer, a real
encrypted database, native permission approval, and repeated cross-site fills.

Opt-in local logs now distinguish entering a port listener, posting a message,
validation rejection, port closure, and App lifecycle events. They include UI and
receiver state so a displayed connection can be compared with the running
receiver. Only the latest 300 sanitized events stay in this tab's memory. There
is no log upload, remote command interface, credential data, or website URL.

This release fixes the reproduced authorization lifecycle defects. Desktop
Chromium and WebKit acceptance does not certify native iOS Userscripts behavior
or establish the cause of every intermittent background-delivery failure.
