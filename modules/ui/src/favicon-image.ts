export const faviconCap = (value: number) => [32, 64, 128].includes(value) ? value : 32;
/** Build an explicit download destination; no service is used unless configured. */
export function faviconUrl(website: string, service?: string, cap = 32): string {
    if (!website.trim() || /[\x00-\x20\\]/.test(website)) throw new Error('Enter a valid HTTP or HTTPS website first.');
    const url = new URL(website.includes('://') ? website : `https://${website}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Enter a valid HTTP or HTTPS website first.');
    if (!service) return new URL('/favicon.ico', url.origin).href;
    // An installation may provide a same-origin path or its own HTTP(S)
    // service. Never infer a public service from the entry's website.
    const relative = service.startsWith('/') && !service.startsWith('//');
    let endpoint: URL;
    try { endpoint = new URL(service, relative ? 'https://icon-service.invalid' : undefined); }
    catch { throw new Error('Configure a valid HTTP or HTTPS icon service.'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error('Configure a valid HTTP or HTTPS icon service.');
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/${encodeURIComponent(url.hostname)}`;
    // Request higher-quality source pixels only when the chosen cap needs it.
    // The image decoder below still bounds the downloaded bytes and stored PNG.
    if (faviconCap(cap) > 32) endpoint.searchParams.set('min', String(faviconCap(cap)));
    return relative ? endpoint.pathname + endpoint.search : endpoint.href;
}
export async function fetchFavicon(url: string, cap: number, signal: AbortSignal): Promise<string> {
    const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', mode: 'cors' });
    if (!response.ok || !response.body) throw new Error('The website icon could not be downloaded. The server must allow cross-origin requests.');
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(type)) throw new Error('The website did not return a supported image.');
    const reader = response.body.getReader();
    let length = 0;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            length += value.byteLength;
            if (length > 1024 * 1024) { await reader.cancel(); throw new Error('The website icon exceeds 1 MB.'); }
            chunks.push(new Uint8Array(value));
        }
    } finally { reader.releaseLock(); }
    if (signal.aborted) throw new Error('Icon download canceled.');
    const bitmap = await createImageBitmap(new Blob(chunks, { type }));
    try {
        if (signal.aborted) throw new Error('Icon download canceled.');
        if (!bitmap.width || !bitmap.height || bitmap.width > 4096 || bitmap.height > 4096) throw new Error('The website icon has unsupported dimensions.');
        const scale = Math.min(1, faviconCap(cap) / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d'); if (!context) throw new Error('Image processing is unavailable.');
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png').split(',')[1];
    } finally { bitmap.close(); }
}
