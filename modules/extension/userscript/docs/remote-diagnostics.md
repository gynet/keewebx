# Remote diagnostics retired

Connect remote diagnostics was removed in 0.6.11 at the user's request.
The App and Userscript no longer collect or upload support events, poll support
commands, or expose diagnostic controls. The retired server paths return 410
without accessing storage, analytics or rate-limit bindings.

Existing support records expire under their original one-hour TTL. No migration
reads or uploads are performed. Previous implementations remain in Git history.
