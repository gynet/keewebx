// App-shell cache used by the service worker. Kept free of service
// worker globals so it can be unit tested with injected dependencies.

export const CACHE_PREFIX = 'keewebx-shell-';

// Static files the app needs to boot, relative to the worker scope.
export const SHELL_ASSETS = [
    'js/app.js',
    'css/app.css',
    'manifest.json',
    'icons/favicon-16x16.png',
    'icons/favicon-32x32.png',
    'icons/favicon-ink-16x16.png',
    'icons/favicon-ink-32x32.png',
    'icons/apple-touch-icon.png',
    'icons/android-chrome-192x192.png',
    'icons/android-chrome-512x512.png'
];

export interface ShellDeps {
    caches: CacheStorage;
    fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
    scope: string;
}

export function cacheName(version: string): string {
    return CACHE_PREFIX + version;
}

export function stripQuery(url: string): string {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.href;
}

function assetUrls(scope: string): string[] {
    return SHELL_ASSETS.map((asset) => new URL(asset, scope).href);
}

async function fetchFresh(deps: ShellDeps, url: string): Promise<Response> {
    return deps.fetch(new Request(url, { cache: 'reload' }));
}

// Precaches the static assets and refreshes every app page the previous
// versions had cached, so pages and assets always come from one build.
export async function install(deps: ShellDeps, version: string): Promise<void> {
    const assets = assetUrls(deps.scope);
    const pages = new Set<string>();
    for (const name of await deps.caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== cacheName(version)) {
            const old = await deps.caches.open(name);
            for (const request of await old.keys()) {
                if (!assets.includes(request.url)) {
                    pages.add(request.url);
                }
            }
        }
    }
    const cache = await deps.caches.open(cacheName(version));
    await Promise.all(
        assets.map(async (url) => {
            const response = await fetchFresh(deps, url);
            if (!response.ok) {
                throw new Error(`Precache failed for ${url}: ${response.status}`);
            }
            await cache.put(url, response);
        })
    );
    await Promise.all(
        [...pages].map(async (url) => {
            const response = await fetchFresh(deps, url).catch(() => null);
            if (response && response.ok) {
                await cache.put(url, response);
            }
        })
    );
}

export async function activate(deps: ShellDeps, version: string): Promise<void> {
    for (const name of await deps.caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== cacheName(version)) {
            await deps.caches.delete(name);
        }
    }
}

// Called by the page after registration: stores the HTML of the page the
// app was opened from (for example /app, /demo or a self-hosted index).
export async function cachePage(deps: ShellDeps, version: string, url: string): Promise<void> {
    const target = stripQuery(url);
    if (new URL(target).origin !== new URL(deps.scope).origin) {
        return;
    }
    const response = await fetchFresh(deps, target).catch(() => null);
    const type = response?.headers.get('content-type') || '';
    if (response && response.ok && type.includes('text/html')) {
        const cache = await deps.caches.open(cacheName(version));
        await cache.put(target, response);
    }
}

// Returns a response for requests the shell owns, or null to leave the
// request entirely to the browser. Only GET requests for the shell assets
// and for cached app pages are answered; everything else, including any
// other same-origin path, is never intercepted or stored.
export function handleFetch(
    deps: ShellDeps,
    version: string,
    request: Request
): Promise<Response> | null {
    if (request.method !== 'GET') {
        return null;
    }
    const scopeOrigin = new URL(deps.scope).origin;
    if (new URL(request.url).origin !== scopeOrigin) {
        return null;
    }
    const key = stripQuery(request.url);
    if (assetUrls(deps.scope).includes(key)) {
        return deps.caches
            .open(cacheName(version))
            .then((cache) => cache.match(key))
            .then((cached) => cached || deps.fetch(request));
    }
    if (request.mode === 'navigate') {
        return deps.caches
            .open(cacheName(version))
            .then((cache) => cache.match(key))
            .then((cached) => cached || deps.fetch(request));
    }
    return null;
}
