const supportedSchemes = new Set(['https:', 'http:', 'file:', 'chrome-extension:', 'moz-extension:']);

/** Match the configured app document, not other apps sharing its host or path prefix. */
export function matchesAppUrl(candidate: string | undefined, configured: string | undefined): boolean {
    if (!candidate || !configured) return false;
    try {
        const tab = new URL(candidate);
        const target = new URL(configured);
        if (!supportedSchemes.has(target.protocol) || tab.protocol !== target.protocol ||
            tab.hostname !== target.hostname || tab.port !== target.port ||
            tab.username || tab.password || target.username || target.password) return false;
        const documentPath = (pathname: string) => pathname.replace(/\/index\.html$/, '/').replace(/\/$/, '');
        if (documentPath(tab.pathname) !== documentPath(target.pathname)) {
            // New documents with an explicit Classic selector redirect within
            // their directory. Admit that destination, not arbitrary sibling apps.
            if (target.searchParams.get('ui') !== 'classic' || tab.searchParams.get('ui') !== 'classic') return false;
            const explicitClassic = /\/classic(?:\.html|\/(?:index\.html)?)$/;
            const destination = explicitClassic.test(target.pathname)
                ? target.pathname.replace(explicitClassic, '/classic.html')
                : new URL('classic.html', target).pathname;
            const candidate = tab.pathname.replace(/\/classic\/(?:index\.html)?$/, '/classic.html');
            const legacyPath = (pathname: string) => documentPath(pathname.replace(explicitClassic, '/index.html'));
            if (legacyPath(tab.pathname) !== legacyPath(target.pathname) && candidate !== destination) return false;
        }
        // Query-free settings retain the existing hash/query routing behavior.
        // Explicit selectors (such as ?ui=classic) must not select another UI.
        if (target.search) {
            const search = (url: URL) => { const params = new URLSearchParams(url.search); params.sort(); return params.toString(); };
            if (search(tab) !== search(target)) return false;
        }
        return true;
    } catch { return false; }
}
