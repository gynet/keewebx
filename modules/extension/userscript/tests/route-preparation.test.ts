import { afterEach, beforeEach, expect, test } from 'bun:test';
import { sign } from 'tweetnacl';
import { SitePortLink } from '../src/direct-ports';
import { toBase64 } from '../../src/background/utils';

const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(name: string, value: unknown) {
    if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
replace('addEventListener', () => {});
const { prepareDirect, openDirect, directCredentials, watchApprovedRoute } = await import('../src/native-connect');
const open = SitePortLink.prototype.open;
let endpoint: URL, route: any, saved: any, configured: any, link: SitePortLink | undefined;
let listeners: Set<(changes: Record<string, unknown>, area: string) => void>;
let events: Map<string, (() => void)[]>;
let stop: (() => void) | undefined;
const configure = SitePortLink.prototype.configure;
const routeKey = () => 'keewebx-native-connect-v1:selected:' + endpoint.href;
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); }
const changed = (key = routeKey(), area = 'local', filename = 'Connect.user.js') => {
    for (const listener of listeners) listener({ [filename + '---' + key]: { newValue: { host: 'untrusted event' } } }, area);
};
beforeEach(() => {
    endpoint = new URL('https://keewebx.app/app?route-test=' + crypto.randomUUID());
    const keys = sign.keyPair();
    route = { host: crypto.randomUUID(), owner: crypto.randomUUID(), endpoint: endpoint.href,
        publicKey: toBase64(keys.publicKey), messagePort: 1 };
    saved = structuredClone(route); configured = undefined; link = undefined; stop = undefined;
    listeners = new Set(); events = new Map();
    replace('addEventListener', (name: string, listener: () => void) => {
        events.set(name, [...events.get(name) ?? [], listener]);
    });
    replace('removeEventListener', () => {});
    replace('location', { href: 'https://login.example.org/login', origin: 'https://login.example.org' });
    replace('GM', {
        info: { scriptHandler: 'Userscripts', script: { filename: 'Connect.user.js' } },
        async getValue(key: string) {
            return structuredClone(key === routeKey() ? saved : {
                publicKey: route.publicKey, secretKey: toBase64(keys.secretKey)
            });
        }
    });
    replace('browser', { storage: { onChanged: {
        addListener: (listener: any) => listeners.add(listener),
        removeListener: (listener: any) => listeners.delete(listener)
    } } });
    SitePortLink.prototype.configure = function(value) {
        link = this; configured = structuredClone(value); configure.call(this, value);
    };
    // Exercise route selection without opening a real helper window.
    SitePortLink.prototype.open = function() { link = this; };
});
afterEach(() => {
    stop?.(); link?.dispose();
    SitePortLink.prototype.open = open; SitePortLink.prototype.configure = configure;
    for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as any)[name];
    }
    originals.clear();
});

test.each(['same App reload', 'replacement App grant'])
('canceling a physical connection does not discard a pending metadata refresh (%s)', async change => {
    await prepareDirect(endpoint);
    const read = deferred<any>(), gm = (globalThis as any).GM, get = gm.getValue;
    saved = { ...route, host: crypto.randomUUID(),
        ...(change === 'replacement App grant' ? { owner: crypto.randomUUID() } : {}) };
    gm.getValue = (key: string) => key === routeKey() ? read.promise : get(key);
    const preparing = prepareDirect(endpoint);
    await settle();
    link!.reset('The connection attempt was canceled.');
    read.resolve(structuredClone(saved)); await preparing;
    expect(configured).toEqual(saved);
    expect(openDirect(endpoint)).toBe(true);
    expect((link as any).route.host).toBe(saved.host);
});

test('a newer grant read supersedes an older delayed read', async () => {
    await prepareDirect(endpoint);
    const old = deferred<any>(), gm = (globalThis as any).GM, get = gm.getValue;
    let first = true;
    gm.getValue = (key: string) => key === routeKey() && first
        ? (first = false, old.promise) : get(key);
    const stale = prepareDirect(endpoint); await settle();
    saved = { ...route, host: crypto.randomUUID() };
    await prepareDirect(endpoint);
    old.resolve(route); await stale;
    expect(configured).toEqual(saved);
});

test.each(['route', 'identity'])
('a failed latest %s read blocks new setup without resetting the physical link', async failure => {
    await prepareDirect(endpoint);
    const generation = link!.generation, gm = (globalThis as any).GM, get = gm.getValue;
    const key = failure === 'route' ? routeKey() : 'keewebx-userscript-connect-identity-v1';
    gm.getValue = (name: string) => name === key ? Promise.reject(new Error('Manager read failed')) : get(name);
    await expect(prepareDirect(endpoint)).rejects.toThrow('Manager read failed');
    expect(directCredentials(endpoint)).toBeUndefined();
    expect(openDirect(endpoint)).toBe(false);
    expect(link!.generation).toBe(generation);
    gm.getValue = get;
    await prepareDirect(endpoint);
    expect(directCredentials(endpoint)).toBeDefined();
    expect(openDirect(endpoint)).toBe(true);
    expect(link!.generation).toBe(generation);
});

test.each(['revoked', 'invalid', 'identity mismatch', 'host', 'key'])
('a successful %s grant read after a failed refresh still resets the previous link', async change => {
    await prepareDirect(endpoint);
    const generation = link!.generation, gm = (globalThis as any).GM, get = gm.getValue;
    gm.getValue = () => Promise.reject(new Error('Manager read failed'));
    await expect(prepareDirect(endpoint)).rejects.toThrow('Manager read failed');
    gm.getValue = get;
    if (change === 'revoked') saved = undefined;
    else if (change === 'invalid') saved = { ...route, owner: 'invalid' };
    else if (change === 'identity mismatch') saved = { ...route, publicKey: toBase64(sign.keyPair().publicKey) };
    else if (change === 'host') saved = { ...route, host: crypto.randomUUID() };
    else {
        const keys = sign.keyPair();
        saved = { ...route, publicKey: toBase64(keys.publicKey) };
        gm.getValue = (name: string) => name === 'keewebx-userscript-connect-identity-v1'
            ? Promise.resolve({ publicKey: saved.publicKey, secretKey: toBase64(keys.secretKey) }) : get(name);
    }
    await prepareDirect(endpoint);
    expect(link!.generation).toBe(generation + 1);
    if (['revoked', 'invalid', 'identity mismatch'].includes(change)) {
        expect(directCredentials(endpoint)).toBeUndefined();
        expect(openDirect(endpoint)).toBe(false);
    } else expect(configured).toEqual(saved);
});

test.each(['route', 'identity'])
('a superseded failed %s read cannot clear a newer prepared grant', async failure => {
    await prepareDirect(endpoint);
    const read = deferred<any>(), gm = (globalThis as any).GM, get = gm.getValue;
    const key = failure === 'route' ? routeKey() : 'keewebx-userscript-connect-identity-v1';
    let first = true;
    gm.getValue = (name: string) => name === key && first ? (first = false, read.promise) : get(name);
    const failing = prepareDirect(endpoint).catch(error => error); await settle();
    saved = { ...route, host: crypto.randomUUID() };
    await prepareDirect(endpoint);
    const generation = link!.generation;
    read.reject(new Error('Superseded read failed'));
    expect((await failing).message).toBe('Superseded read failed');
    expect(configured).toEqual(saved);
    expect(directCredentials(endpoint)).toBeDefined();
    expect(openDirect(endpoint)).toBe(true);
    expect(link!.generation).toBe(generation);
});

test.each(['grant ended', 'pagehide'])
('%s invalidates an outstanding metadata read even without a replacement read', async invalidation => {
    await prepareDirect(endpoint);
    const read = deferred<any>(), gm = (globalThis as any).GM, get = gm.getValue;
    gm.getValue = (key: string) => key === routeKey() ? read.promise : get(key);
    const preparing = prepareDirect(endpoint); await settle();
    saved = { ...route, host: crypto.randomUUID() };
    if (invalidation === 'grant ended') link!.onGrantEnded();
    else for (const listener of events.get('pagehide') ?? []) listener();
    read.resolve(saved); await preparing;
    expect(configured).toEqual(route);
    if (invalidation === 'grant ended') expect(openDirect(endpoint)).toBe(false);
});

test('route notifications invalidate pending reads before waking the caller and never grant from event data', async () => {
    await prepareDirect(endpoint);
    const read = deferred<any>(), gm = (globalThis as any).GM, get = gm.getValue;
    gm.getValue = (key: string) => key === routeKey() ? read.promise : get(key);
    const preparing = prepareDirect(endpoint); await settle();
    let wakes = 0;
    stop = watchApprovedRoute(endpoint, () => {
        wakes++;
        // Resolving inside the callback also checks the invalidation ordering.
        read.resolve({ ...route, host: crypto.randomUUID() });
    });
    changed('unrelated'); changed(routeKey(), 'sync'); changed(routeKey(), 'local', 'Other.user.js');
    expect(wakes).toBe(0);
    changed(); await preparing;
    expect(wakes).toBe(1);
    expect(configured).toEqual(route);
    stop(); changed(); expect(wakes).toBe(1);
});

test('route notifications wake a fresh GM read after a canceled connection', async () => {
    await prepareDirect(endpoint);
    let refreshing: Promise<void> | undefined;
    stop = watchApprovedRoute(endpoint, () => { refreshing = prepareDirect(endpoint); });
    saved = { ...route, host: crypto.randomUUID() };
    link!.reset();
    changed(); await refreshing;
    expect(configured).toEqual(saved);
    expect((link as any).route.host).toBe(saved.host);
});
