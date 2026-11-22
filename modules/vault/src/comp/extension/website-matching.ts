/** Accept only the exact HTTPS origin supplied by a website's location.origin. */
export function validWebsiteOrigin(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.origin === value ? value : undefined;
    } catch {
        return undefined;
    }
}

export function storedWebsiteUrl(value: string): URL | undefined {
    // URL parsing otherwise silently removes controls and repairs backslashes.
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
    const trimmed = value.trim();
    const address = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const authority = address.slice(address.indexOf('://') + 3).split(/[/?#]/, 1)[0];
    // Checking the authority also rejects empty userinfo, which URL erases.
    if (!authority || authority.includes('@') || authority.endsWith(':')) return undefined;
    try {
        const url = new URL(address);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
            ? url : undefined;
    } catch {
        return undefined;
    }
}

function websiteHostname(hostname: string): string {
    if (!hostname.startsWith('www.')) return hostname;
    const base = hostname.slice(4);
    // Only one conventional alias; IP addresses and local names stay exact.
    if (!base.includes('.') || base.startsWith('www.') || /^[\d.]+$/.test(base) ||
        /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|home\.arpa)$/.test(base)) {
        return hostname;
    }
    return base;
}

/** Match stored URLs to an authoritative HTTPS destination without suffix matching. */
export function matchesWebsiteUrl(value: string, origin: string): boolean {
    if (!validWebsiteOrigin(origin)) return false;
    const stored = storedWebsiteUrl(value);
    if (!stored) return false;
    const destination = new URL(origin);
    // Legacy summaries omitted the scheme: retain only the default HTTP upgrade.
    const portsMatch = stored.protocol === 'http:'
        ? !stored.port && !destination.port
        : stored.port === destination.port;
    return portsMatch && websiteHostname(stored.hostname) === websiteHostname(destination.hostname);
}

/** Include the primary URL and all additional URL fields exposed by the entry. */
export function entryMatchesWebsite(entry: { getAllUrls(): string[] }, origin: string): boolean {
    if (!validWebsiteOrigin(origin)) return false;
    return entry.getAllUrls().some((value) => matchesWebsiteUrl(value, origin));
}
