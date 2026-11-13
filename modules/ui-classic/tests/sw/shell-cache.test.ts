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
        const cache = await caches.open(cacheName('v1', SCOPE));
        expect((await cache.keys()).map((r) => r.url).sort()).toEqual(
            SHELL_ASSETS.map((a) => new URL(a, SCOPE).href).sort()
        );
        expect(fetched.every((f) => f.cache === 'reload')).toBe(true);
    });

    it('refreshes pages cached by the previous version from the network', async () => {
        const { caches, deps } = setup();
        const old = await caches.open(cacheName('v1', SCOPE));
        await old.put(SCOPE + 'app', new Response('old page'));
        await old.put(new URL('js/app.js', SCOPE).href, new Response('old js'));
        await install(deps, 'v2');
        const cache = await caches.open(cacheName('v2', SCOPE));
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
        await caches.open(cacheName('v1', SCOPE));
        await caches.open(cacheName('v2', SCOPE));
        await caches.open('something-else');
        await activate(deps, 'v2');
        expect((await caches.keys()).sort()).toEqual([cacheName('v2', SCOPE), 'something-else'].sort());
    });
});

describe('cachePage', () => {
    it('stores the page without its query string', async () => {
        const { caches, deps } = setup();
        await cachePage(deps, 'v1', SCOPE + 'app?demo=1#x');
        const cache = await caches.open(cacheName('v1', SCOPE));
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
        const cache = await caches.open(cacheName('v1', SCOPE));
        expect(await cache.keys()).toEqual([]);
    });
});

describe('handleFetch', () => {
    it('serves shell assets from the cache, ignoring the query string', async () => {
        const { caches, deps, fetched } = setup();
        const cache = await caches.open(cacheName('v1', SCOPE));
        await cache.put(new URL('js/app.js', SCOPE).href, new Response('cached js'));
        const response = handleFetch(deps, 'v1', req(SCOPE + 'js/app.js?__inline=true'));
        expect(await text(await response)).toBe('cached js');
        expect(fetched).toEqual([]);
    });

    it('serves a cached app page for navigations and the network otherwise', async () => {
        const { caches, deps } = setup();
        const cache = await caches.open(cacheName('v1', SCOPE));
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


describe('scope and update isolation', () => {
    it('keeps both interface entry points and New assets in the shell', () => {
        expect(SHELL_ASSETS).toEqual(expect.arrayContaining([
            'index.html', 'next.html', 'js/app.js', 'css/app.css',
            'js/next.js', 'css/next.css', 'manifest.json', 'manifest-new.json'
        ]));
    });

    it('does not read or delete another deployment scope', async () => {
        const { deps, caches, fetched } = setup();
        const other = cacheName('v1', 'https://app.test/other/');
        await (await caches.open(other)).put('https://app.test/other/next.html', new Response('other'));
        await install(deps, 'v2');
        await activate(deps, 'v2');
        expect(await caches.keys()).toContain(other);
        expect(fetched.some(({ url }) => url.includes('/other/'))).toBe(false);
        await cachePage(deps, 'v2', 'https://app.test/outside');
        expect(fetched.some(({ url }) => url.endsWith('/outside'))).toBe(false);
        expect(handleFetch(deps, 'v2', req('https://app.test/outside', { mode: 'navigate' }))).toBeNull();
    });

    it('keeps the old shell and removes a partial update when a cached page cannot refresh', async () => {
        const { deps, caches } = setup(url => new Response('response', {
            status: url.endsWith('/app') ? 503 : 200
        }));
        const old = await caches.open(cacheName('v1', SCOPE));
        await old.put(SCOPE + 'app', new Response('old page'));
        await expect(install(deps, 'v2')).rejects.toThrow('503');
        expect(await caches.keys()).toEqual([cacheName('v1', SCOPE)]);
        expect(await text(await old.match(SCOPE + 'app'))).toBe('old page');
    });

    it('migrates scoped pages from an older unscoped shell without deleting it', async () => {
        const { deps, caches, fetched } = setup();
        const old = await caches.open('keewebx-shell-400c956');
        await old.put(SCOPE + 'app', new Response('old page'));
        await old.put('https://app.test/other/app', new Response('other page'));
        await install(deps, 'v2');
        await activate(deps, 'v2');
        expect(await text(await (await caches.open(cacheName('v2', SCOPE))).match(SCOPE + 'app')))
            .toBe(`net:${SCOPE}app`);
        expect(fetched.some(({ url }) => url.includes('/other/'))).toBe(false);
        expect(await caches.keys()).toContain('keewebx-shell-400c956');
    });
});


describe('waiting update page isolation', () => {
    it('does not replace active HTML when a newer deployment is waiting', async () => {
        const { deps, caches, fetched } = setup();
        const cache = await caches.open(cacheName('v1', SCOPE));
        await cache.put(SCOPE + 'next.html', new Response('active build'));
        await cachePage(deps, 'v1', SCOPE + 'next.html');
        expect(await text(await cache.match(SCOPE + 'next.html'))).toBe('active build');
        expect(fetched).toHaveLength(0);
    });
});
