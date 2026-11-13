// App-shell cache used by the service worker. Kept free of service
// worker globals so it can be unit tested with injected dependencies.

export const CACHE_PREFIX = 'keewebx-shell-';

// Static files the app needs to boot, relative to the worker scope.
export const SHELL_ASSETS = [
    'index.html',
    'next.html',
    'js/next.js',
    'css/next.css',
    'manifest-new.json',
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

function scopePrefix(scope: string): string {
    return CACHE_PREFIX + encodeURIComponent(new URL(scope).pathname) + ':';
}

export function cacheName(version: string, scope: string): string {
    return scopePrefix(scope) + version;
}

function inScope(url: string, scope: string): boolean {
    const target = new URL(url);
    const root = new URL(scope);
    return target.origin === root.origin && target.pathname.startsWith(root.pathname);
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
        if ((name.startsWith(scopePrefix(deps.scope)) || /^keewebx-shell-(?:[a-f0-9]{7}|unknown)$/.test(name))
            && name !== cacheName(version, deps.scope)) {
            const old = await deps.caches.open(name);
            for (const request of await old.keys()) {
                if (inScope(request.url, deps.scope) && !assets.includes(request.url)) {
                    pages.add(request.url);
                }
            }
        }
    }
    const name = cacheName(version, deps.scope);
    const cache = await deps.caches.open(name);
    try {
        // A failed page refresh must not activate a build missing a previously
        // available offline entry point. Complete the new cache before activation.
        for (const url of new Set([...assets, ...pages])) {
            const response = await fetchFresh(deps, url);
            if (!response.ok) {
                throw new Error(`Precache failed for ${url}: ${response.status}`);
            }
            await cache.put(url, response);
        }
    } catch (error) {
        await deps.caches.delete(name);
        throw error;
    }
}

export async function activate(deps: ShellDeps, version: string): Promise<void> {
    for (const name of await deps.caches.keys()) {
        if (name.startsWith(scopePrefix(deps.scope)) && name !== cacheName(version, deps.scope)) {
            await deps.caches.delete(name);
        }
    }
}

// Called by the page after registration: stores the HTML of the page the
// app was opened from (for example /app, /demo or a self-hosted index).
export async function cachePage(deps: ShellDeps, version: string, url: string): Promise<void> {
    const target = stripQuery(url);
    if (!inScope(target, deps.scope)) {
        return;
    }
    const cache = await deps.caches.open(cacheName(version, deps.scope));
    // Registration on a later visit must not replace this build's HTML with
    // a newer deployment while its worker is still waiting.
    if (await cache.match(target)) return;
    const response = await fetchFresh(deps, target).catch(() => null);
    const type = response?.headers.get('content-type') || '';
    if (response && response.ok && type.includes('text/html')) {
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
    if (!inScope(request.url, deps.scope)) {
        return null;
    }
    const key = stripQuery(request.url);
    if (assetUrls(deps.scope).includes(key)) {
        return deps.caches
            .open(cacheName(version, deps.scope))
            .then((cache) => cache.match(key))
            .then((cached) => cached || deps.fetch(request));
    }
    if (request.mode === 'navigate') {
        return deps.caches
            .open(cacheName(version, deps.scope))
            .then((cache) => cache.match(key))
            .then((cached) => cached || deps.fetch(request));
    }
    return null;
}
