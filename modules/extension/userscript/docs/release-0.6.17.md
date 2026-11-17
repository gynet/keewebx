# Connect 0.6.17

If a port worked before and stops replying during the next handshake, Connect
closes the stale port and uses the encrypted local fallback within the same
operation. The fallback requires the same saved App authorization and starts a
fresh handshake. It cannot replay a credential read or open another App tab.

The connection worker also recovers a missing lookup for the exact App client
that answered discovery. A temporary page that takes too long to start can now
recover through the same local fallback within the original operation deadline.

The [local connection log](release-0.6.16.md) is available in both panels and
remains off by default. Update the existing script and reload both documents
after saving pending database edits.
