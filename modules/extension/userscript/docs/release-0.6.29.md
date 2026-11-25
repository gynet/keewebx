# Connect 0.6.29 looks up accounts from the iPhone login key

In Userscripts on iPhone and iPad, tap the key next to a login field to find
matching accounts, even when the input has no focus. Choose a match to fill using
the same authenticated session. **Test connection** remains available in the
Connection panel.

In the paired Safari trace, a local connection test reached the App about
5.4 seconds after sending, as the App became visible. It released its session
after the test, and **Find accounts** had to connect again. Later direct
discovery messages also arrived in a batch when the App became visible.

A slow initial lookup now shows a hint after two seconds. If Safari has paused
the original App, visit its tab once and return to the website. The same signed
request can wait for up to one minute and the lookup resumes on return. Closing
the panel cancels it. The App still applies website matching, pairing and vault
permissions to every credential request.

The browser acceptance fixture uses an iPhone user agent, an isolated
Userscripts storage adapter, and the real app with an encrypted test database.
It covers an unfocused key tap, fill while the App stays hidden, an App response
delayed past the old eight-second deadline, cancellation, lock and revocation.
An already unlocked App running 0.6.28 can serve the updated website script.
Physical iPhone verification is pending. Safari may still require a visit to a
suspended App tab.
