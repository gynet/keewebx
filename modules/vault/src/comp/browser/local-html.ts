/** Local HTML disables server features regardless of saved preferences. Website icons are a separate exception. */
export function isLocalHtml(): boolean {
    return typeof location !== 'undefined' && location.protocol === 'file:';
}

export function requireNetwork(): void {
    if (isLocalHtml()) throw new Error('Network access is disabled in local HTML.');
}
