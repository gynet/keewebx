import { describe, expect, it } from 'bun:test';
import {
    activate,
    cacheName,
    cachePage,
    handleFetch,
    install,
    SHELL_ASSETS,
    ShellDeps
} from '../../app/sw/shell-cache';

const SCOPE = 'https://app.test/base/';

class MemoryCache {
    entries = new Map<string, Response>();
    async match(request: RequestInfo, options?: CacheQueryOptions): Promise<Response | undefined> {
        let url = typeof request === 'string' ? request : request.url;
        if (options?.ignoreSearch) {
            url = url.split('?')[0];
        }
        return this.entries.get(url)?.clone();
    }
    async put(request: RequestInfo, response: Response): Promise<void> {
        this.entries.set(typeof request === 'string' ? request : request.url, response.clone());
    }
    async keys(): Promise<Request[]> {
        return [...this.entries.keys()].map((url) => new Request(url));
    }
}

class MemoryCacheStorage {
    stores = new Map<string, MemoryCache>();
    async open(name: string): Promise<MemoryCache> {
        if (!this.stores.has(name)) {
            this.stores.set(name, new MemoryCache());
        }
        return this.stores.get(name)!;
    }
    async keys(): Promise<string[]> {
        return [...this.stores.keys()];
    }
    async delete(name: string): Promise<boolean> {
        return this.stores.delete(name);
    }
}

function setup(respond?: (url: string) => Response) {
    const caches = new MemoryCacheStorage();
    const fetched: Array<{ url: string; cache?: RequestCache }> = [];
    const deps: ShellDeps = {
        caches: caches as unknown as CacheStorage,
        scope: SCOPE,
        fetch: async (input) => {
            const request = input instanceof Request ? input : new Request(input);
            fetched.push({ url: request.url, cache: request.cache });
            return respond
                ? respond(request.url)
                : new Response(`net:${request.url}`, {
                      headers: { 'content-type': request.url.endsWith('/') || !/\.\w+$/.test(new URL(request.url).pathname) ? 'text/html' : 'application/octet-stream' }
                  });
        }
    };
    return { caches, deps, fetched };
}

const text = async (r: Response | null | undefined) => (r ? await r.text() : null);
const req = (url: string, init?: RequestInit & { mode?: RequestMode }) => {
    const r = new Request(url, init);
    if (init?.mode) {
        Object.defineProperty(r, 'mode', { value: init.mode });
    }
    return r;
};

describe('install', () => {
    it('precaches every shell asset, bypassing the HTTP cache', async () => {
        const { caches, deps, fetched } = setup();
        await install(deps, 'v1');
        const cache = await caches.open(cacheName('v1'));
        expect((await cache.keys()).map((r) => r.url).sort()).toEqual(
            SHELL_ASSETS.map((a) => new URL(a, SCOPE).href).sort()
        );
        expect(fetched.every((f) => f.cache === 'reload')).toBe(true);
    });

    it('refreshes pages cached by the previous version from the network', async () => {
        const { caches, deps } = setup();
        const old = await caches.open(cacheName('v1'));
        await old.put(SCOPE + 'app', new Response('old page'));
        await old.put(new URL('js/app.js', SCOPE).href, new Response('old js'));
        await install(deps, 'v2');
        const cache = await caches.open(cacheName('v2'));
        expect(await text(await cache.match(SCOPE + 'app'))).toBe(`net:${SCOPE}app`);
        expect(await text(await cache.match(new URL('js/app.js', SCOPE).href))).toBe(
            `net:${new URL('js/app.js', SCOPE).href}`
        );
    });

    it('fails when an asset cannot be fetched, so the old version stays active', async () => {
        const { deps } = setup((url) =>
            url.endsWith('app.css') ? new Response('', { status: 500 }) : new Response('ok')
        );
        await expect(install(deps, 'v1')).rejects.toThrow('app.css');
    });
});

describe('activate', () => {
    it('removes older shell caches and leaves unrelated caches alone', async () => {
        const { caches, deps } = setup();
        await caches.open(cacheName('v1'));
        await caches.open(cacheName('v2'));
        await caches.open('something-else');
        await activate(deps, 'v2');
        expect((await caches.keys()).sort()).toEqual([cacheName('v2'), 'something-else'].sort());
    });
});

describe('cachePage', () => {
    it('stores the page without its query string', async () => {
        const { caches, deps } = setup();
        await cachePage(deps, 'v1', SCOPE + 'app?demo=1#x');
        const cache = await caches.open(cacheName('v1'));
        expect((await cache.keys()).map((r) => r.url)).toEqual([SCOPE + 'app']);
    });

    it('ignores other origins, errors and non-HTML responses', async () => {
        const { caches, deps } = setup((url) =>
            url.includes('broken')
                ? new Response('', { status: 404, headers: { 'content-type': 'text/html' } })
                : new Response('{}', { headers: { 'content-type': 'application/json' } })
        );
        await cachePage(deps, 'v1', 'https://elsewhere.test/app');
        await cachePage(deps, 'v1', SCOPE + 'broken');
        await cachePage(deps, 'v1', SCOPE + 'data');
        const cache = await caches.open(cacheName('v1'));
        expect(await cache.keys()).toEqual([]);
    });
});

describe('handleFetch', () => {
    it('serves shell assets from the cache, ignoring the query string', async () => {
        const { caches, deps, fetched } = setup();
        const cache = await caches.open(cacheName('v1'));
        await cache.put(new URL('js/app.js', SCOPE).href, new Response('cached js'));
        const response = handleFetch(deps, 'v1', req(SCOPE + 'js/app.js?__inline=true'));
        expect(await text(await response)).toBe('cached js');
        expect(fetched).toEqual([]);
    });

    it('serves a cached app page for navigations and the network otherwise', async () => {
        const { caches, deps } = setup();
        const cache = await caches.open(cacheName('v1'));
        await cache.put(SCOPE + 'demo', new Response('cached page'));
        expect(await text(await handleFetch(deps, 'v1', req(SCOPE + 'demo?x=1', { mode: 'navigate' })))).toBe(
            'cached page'
        );
        expect(await text(await handleFetch(deps, 'v1', req(SCOPE, { mode: 'navigate' })))).toBe(
            `net:${SCOPE}`
        );
    });

    it('leaves everything else to the browser', () => {
        const { deps } = setup();
        expect(handleFetch(deps, 'v1', req(SCOPE + 'js/app.js', { method: 'POST' }))).toBeNull();
        expect(handleFetch(deps, 'v1', req('https://elsewhere.test/js/app.js'))).toBeNull();
        expect(handleFetch(deps, 'v1', req(SCOPE + 'some/other/path'))).toBeNull();
        expect(handleFetch(deps, 'v1', req(SCOPE + 'vault.kdbx'))).toBeNull();
    });
});
