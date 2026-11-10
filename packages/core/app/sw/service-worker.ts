import { activate, cachePage, handleFetch, install, ShellDeps } from './shell-cache';

declare const self: ServiceWorkerGlobalScope;
declare const __KEEWEBX_BUILD_SHA_SHORT__: string;

// Each build gets its own cache; the old one is removed once the new
// worker takes over.
const VERSION = __KEEWEBX_BUILD_SHA_SHORT__;

function deps(): ShellDeps {
    return {
        caches: self.caches,
        fetch: (input, init) => self.fetch(input, init),
        scope: self.registration.scope
    };
}

self.addEventListener('install', (event) => {
    event.waitUntil(install(deps(), VERSION));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(activate(deps(), VERSION));
});

self.addEventListener('fetch', (event) => {
    const response = handleFetch(deps(), VERSION, event.request);
    if (response) {
        event.respondWith(response);
    }
});

self.addEventListener('message', (event) => {
    const data = event.data as { type?: string; url?: unknown } | null;
    if (data?.type === 'skip-waiting') {
        void self.skipWaiting();
    } else if (data?.type === 'cache-page' && typeof data.url === 'string') {
        event.waitUntil(cachePage(deps(), VERSION, data.url));
    }
});
