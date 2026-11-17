# Connect 0.6.13

A newly opened website must discover the original KeeWebX App again. The App
can now acknowledge discovery directly to the requesting service worker as well
as through its temporary probe port. The worker accepts the alternate response
only from the window it queried and within the pending probe's deadline.
Account lookup and filling still require the original signed connection and
vault permissions.

Update the existing userscript and reload the App and the login website. The
existing grant and vault permissions remain available. Safari can suspend an
App tab. A suspended receiver may still need a visit to the existing App.
