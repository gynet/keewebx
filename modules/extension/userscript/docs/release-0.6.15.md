# Connect 0.6.15

The local fallback now retains a storage notification that arrives during a
queue read. After the current scan finishes, Connect checks for the newly
queued request before returning to idle. This resolves a retry timeout observed
after canceling an account fill during the 0.6.14 fallback test.

The fallback is limited to the existing authenticated App and receives only
signed, encrypted Connect messages. A normal MessagePort connection proceeds
without using the local fallback. See the [0.6.14 notes](release-0.6.14.md).

When notifications are missing, an authorized App checks one local mailbox
signal every 1.5 seconds while its script is running. The hint contains only
request identity and expiry. It does not contact a server or grant access.
