/** Keep old explicit Classic selectors usable on static hosts and file URLs. */
export function legacyClassicEntry(pageUrl: string, baseUrl = pageUrl): string | undefined {
    const page = new URL(pageUrl);
    if (page.searchParams.get('ui') !== 'classic') return;
    const target = new URL('classic.html', baseUrl);
    target.search = page.search;
    target.hash = page.hash;
    return target.href;
}
