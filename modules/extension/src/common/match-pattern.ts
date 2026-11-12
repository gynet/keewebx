/**
 * Convert a concrete URL string into a browser extension match pattern
 * suitable for `chrome.permissions.contains` / `chrome.permissions.request`
 * / `host_permissions` etc.
 *
 * See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns
 *
 * Chrome is lenient and will silently accept a concrete URL in the
 * `origins` array. Firefox is strict and rejects anything that isn't a
 * valid match pattern, so we must normalize before calling the API.
 *
 * Conversions:
 *   https://foo.example/path     -> https://foo.example/*
 *   http://localhost:8080/       -> http://localhost/*
 *   http://[::1]:8080/           -> http://[::1]/*
 *   file:///Users/x/index.html   -> file:///*
 *
 * Note: match patterns do NOT support ports or userinfo — they're
 * matched by scheme + host + path only. We therefore strip the port
 * component when building the pattern. This is consistent with how
 * Firefox/Chrome store `host_permissions`.
 */
export function urlToMatchPattern(rawUrl: string): string {
    const u = new URL(rawUrl);

    // file:// URLs don't have meaningful hosts in match-pattern land.
    // The canonical broad pattern is `file:///*`. Anything narrower
    // isn't supported cross-browser.
    if (u.protocol === 'file:') {
        return 'file:///*';
    }

    // For http(s), pattern is `<scheme>://<host>/*`. Strip port.
    // `u.hostname` preserves the `[...]` brackets for IPv6 literals
    // on modern URL implementations, so we can use it as-is.
    return `${u.protocol}//${u.hostname}/*`;
}
