/** HTTPS for remote servers; loopback HTTP supports local WebDAV servers. */
export function webDavAddress(value: string): string {
    if (/[\x00-\x20\x7f\\]/.test(value.trim())) throw new Error('Enter a valid WebDAV file address.');
    const url = new URL(value.trim());
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new Error('Use HTTPS for WebDAV. HTTP is only allowed for a server on this device (localhost or a loopback address).');
    }
    if (url.username || url.password || url.hash || url.pathname === '/' || url.pathname.endsWith('/')) {
        throw new Error('Enter a WebDAV file address without embedded credentials or a fragment.');
    }
    return url.href;
}
