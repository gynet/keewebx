/** Match Classic's explicit website protocols without URL-parser normalization of controls. */
export function safeWebsiteUrl(text: string): string | undefined {
    const value = text.trim();
    if (!value || /[\x00-\x1f\x7f\\]/.test(value)) return undefined;
    try {
        const candidate = value.startsWith('//') ? `https:${value}`
            : /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
        const url = new URL(candidate);
        if (url.protocol === 'mailto:') return url.pathname ? url.href : undefined;
        return ['http:', 'https:', 'ftp:', 'ftps:'].includes(url.protocol) && url.hostname ? url.href : undefined;
    } catch { return undefined; }
}
