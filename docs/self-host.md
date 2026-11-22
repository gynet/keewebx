# Self-host KeeWebX

Download the recommended **New** release archive and verify its accompanying SHA-256 checksum. ZIP and TAR contain the same static site and license notices.

| Package | Files | `index.html` opens |
| --- | --- | --- |
| **New (recommended)** | `keewebx-new-<version>.zip` or `.tar.gz` | New |
| Classic (deprecated) | `keewebx-classic-<version>.zip` or `.tar.gz` | Classic |
| Combined (compatibility) | `keewebx-web-<version>.zip` or `.tar.gz` | New, with Classic available |

The standalone packages contain only their selected interface and the shared assets it needs. Each works independently, including offline use over HTTPS or localhost. Interface switching is available in the combined package. Both interfaces open the same KDBX vaults; switching does not convert your database.

Extract the archive and double-click **index.html**. New also retains `next.html`. Classic retains `classic.html` and `classic/index.html`; its homepage opens Classic even when browser settings previously selected New. The combined package also retains `index.html?ui=classic` and `next.html?ui=classic`. In New-only packages those query parameters continue opening New.

When changing package types, replace the complete deployed directory instead of overlaying files from one archive onto another. Keep an encrypted KDBX backup first. If you need both interfaces and in-app switching, choose the combined package.

You can also serve the extracted directory with any static HTTP server, including under a nested path. For a local check:

```sh
python3 -m http.server 8080
```

Open `http://localhost:8080/`. HTTPS or localhost enables service workers and browser APIs that require a secure context. Browser and authenticator support determines passkey availability.

On `file://`, the app reads its assets directly from the extracted directory. It does not contact `keewebx.app` or its subdomains, register a service worker, or check for updates. Configured WebDAV synchronization and other external services remain available. Website icons are downloaded directly instead of through an app server. Your remote server must allow the browser's file-origin CORS requests (`Origin: null`). Download a newer archive separately to update. Enable “Allow access to file URLs” in Chromium's extension settings if you use extension autofill with local files. Keep all files in the archive together.

Browser storage is not a backup. Keep an encrypted KDBX copy outside the browser before clearing site data or moving to a different origin. Remote storage and browser extensions require separate configuration.

### HTTPS response headers

For a dedicated KeeWebX origin, configure the HTTPS host with these response headers.
The example assumes the service worker lives at the site root.

```caddyfile
vault.example.com {
    root * /srv/keewebx
    header {
        Content-Security-Policy "frame-ancestors 'none'"
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
    }
    @worker path /service-worker.js
    header @worker Cache-Control "no-cache"
    file_server
}
```

Apply the same headers in nginx using `add_header ... always`. Put the worker
cache policy on its actual URL, including the deployment prefix if applicable,
and repeat the common headers in that location if it defines its own
`add_header` directives. Use HSTS when the origin is intended to stay HTTPS-only.
`frame-ancestors` must be an HTTP response header and blocks iframe embedding.

Automated release smoke checks open the packaged demo in New and Classic over localhost HTTP, nested hosting paths, and `file://`. The combined bundle retains its 26 startup checks. Standalone checks also cover prior interface preferences, hidden unavailable switches, installed service workers, offline reloads, missing assets, script errors, and content security policy violations. Both ZIP and TAR are extracted and checked before release.

Source: https://github.com/gynet/keewebx
