/** Local HTML never performs automatic server or version discovery. */
export function isLocalHtml(): boolean {
    return typeof location !== 'undefined' && location.protocol === 'file:';
}
