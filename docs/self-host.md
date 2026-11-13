# Self-host KeeWebX

Download the web `.zip` or `.tar.gz` release and verify its accompanying SHA-256 checksum. Both archives contain the same static site and license notices.

Extract the archive and double-click **index.html** to open New. **classic.html** opens Classic. The compatibility entries `next.html` (New), `classic/index.html` (Classic), and `index.html?ui=classic` remain available. Both interfaces can open the same KDBX vaults. Switching interfaces does not convert your database.

You can also serve the extracted directory with any static HTTP server, including under a nested path. For a local check:

```sh
python3 -m http.server 8080
```

Open `http://localhost:8080/`. HTTPS or localhost enables service workers and browser APIs that require a secure context. Browser and authenticator support determines passkey availability.

On `file://`, the app reads its assets directly from the extracted directory; service workers do not register. Enable “Allow access to file URLs” in Chromium's extension settings if you use extension autofill with local files. Keep all files in the archive together.

Browser storage is not a backup. Keep an encrypted KDBX copy outside the browser before clearing site data or moving to a different origin. Remote storage and browser extensions require separate configuration.

Automated release smoke checks open the packaged demo in New and Classic over localhost HTTP, nested hosting paths, and `file://`. The checks also cover compatibility links, demo startup, missing assets, script errors, and content security policy violations.

Source: https://github.com/gynet/keewebx
