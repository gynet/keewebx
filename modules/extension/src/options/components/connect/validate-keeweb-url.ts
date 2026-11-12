/**
 * Pure URL-validation logic for the "KeeWeb URL" options field.
 *
 * Allowed schemes, to support self-host release bundles shipped via
 * `.github/workflows/release.yml` plus local dev / localhost tunnels:
 *
 *   - https:   on any host                                        (remote self-host)
 *   - http:    only on localhost / 127.0.0.1 / ::1                (local dev / tunnels)
 *   - file:    unconditionally                                    (standalone bundle
 *                                                                  from `keewebx-web-v*.zip`,
 *                                                                  opened as
 *                                                                  file:///path/to/index.html;
 *                                                                  browser-side `file://`
 *                                                                  host permission
 *                                                                  is the user's
 *                                                                  responsibility)
 *
 * LAN IP (e.g. 192.168.x, 10.x, 172.16-31.x) over plain HTTP is intentionally
 * rejected — user should tunnel via Tailscale/WireGuard or terminate TLS.
 */

/** Loopback hostnames that make `http:` acceptable. */
const LOOPBACK_HOSTS = new Set<string>([
    'localhost',
    '127.0.0.1',
    // IPv6 loopback. Note `new URL('http://[::1]').hostname` === '[::1]'
    // (brackets preserved). We compare against both the bracketed and
    // bare form to be defensive.
    '[::1]',
    '::1'
]);

export type KeeWebUrlValidationResult =
    | { ok: true; url: URL }
    | { ok: false; reason: 'scheme' | 'parse'; message: string };

/**
 * Validate a user-entered KeeWeb URL.
 *
 * The component is responsible for turning the `reason` into a localized
 * error string via `res()`; this helper only returns the raw underlying
 * parse message (for `reason: 'parse'`) so the caller can format it the
 * same way the pre-refactor code did.
 */
export function validateKeeWebUrl(input: string): KeeWebUrlValidationResult {
    let url: URL;
    try {
        url = new URL(input);
    } catch (e) {
        return {
            ok: false,
            reason: 'parse',
            message: (e as Error).message
        };
    }

    const protocol = url.protocol;

    if (protocol === 'https:') {
        return { ok: true, url };
    }

    if (protocol === 'file:') {
        return { ok: true, url };
    }

    if (protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) {
        return { ok: true, url };
    }

    return {
        ok: false,
        reason: 'scheme',
        message: `Disallowed scheme: ${protocol}`
    };
}
