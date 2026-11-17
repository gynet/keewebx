// Host admission and cancellation tests. Browser transport is covered by native-connect.mjs.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { sign } from 'tweetnacl';
import { AppBridge } from '../src/app-bridge';
import { toBase64 } from '../../src/background/utils';

const endpoint = new URL('https://keewebx.app/app');
const routeKey = `keewebx-native-connect-v1:selected:${endpoint.href}`;
const original = new Map<string, PropertyDescriptor | undefined>();
function replace(key: string, value: any) {
    if (!original.has(key)) original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
// Module-level setup listeners are exercised by the real browser fixture.
replace('addEventListener', () => {});
const { NativeHost, NativeRpc, approvedRoute } = await import('../src/native-connect');
let host: InstanceType<typeof NativeHost>, keys: ReturnType<typeof sign.keyPair>;
let storage: Map<string, any>, replies: any[], reads: number, lastBridge: AppBridge;
let locks: ReturnType<typeof sharedLocks>;
const requestImpl = AppBridge.prototype.request;
const replayImpl = AppBridge.prototype.replay;
const stable = (value: any): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
function envelope(packet: any) { return { packet, signature: toBase64(sign.detached(new TextEncoder().encode(stable(packet)), keys.secretKey)) }; }
function packet(overrides: any = {}) {
    return { type: 'request', host: storage.get(routeKey).host, endpoint: endpoint.href, id: crypto.randomUUID(),
        document: crypto.randomUUID(), origin: 'https://login.example.org', operation: 'hello', deadline: Date.now() + 5000, ...overrides };
}
const send = (value: any) => (host as any).receive(value);
function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function sharedLocks() {
    const tails = new Map<string, Promise<void>>();
    const requested: string[] = [], active = new Set<string>();
    return {
        requested, active,
        request(name: string, options: { mode: string }, callback: () => Promise<void>): Promise<void> {
            expect(options.mode).toBe('exclusive');
            requested.push(name);
            const result = (tails.get(name) || Promise.resolve()).then(async () => {
                expect(active.has(name)).toBe(false); active.add(name);
                try { await callback(); } finally { active.delete(name); }
            });
            tails.set(name, result.catch(() => {}));
            return result;
        },
        async idle() { await Promise.all(tails.values()); }
    };
}
async function until(predicate: () => boolean) {
    for (let turn = 0; !predicate() && turn < 100; turn++) await Promise.resolve();
    expect(predicate()).toBe(true);
}
async function session() {
    const p = packet(); await send(envelope(p));
    const scope = replies.at(-1).value.packet.body.scope;
    return { ...p, operation: 'wire', id: crypto.randomUUID(), scope, body: { action: 'kwx-features' } };
}
beforeEach(async () => {
    storage = new Map(); replies = []; reads = 0; keys = sign.keyPair();
    replace('addEventListener', () => {}); replace('removeEventListener', () => {});
    replace('location', { href: endpoint.href, origin: endpoint.origin }); replace('document', { visibilityState: 'hidden' });
    replace('window', { postMessage() {} }); replace('sessionStorage', { getItem: () => null, setItem() {} });
    replace('BroadcastChannel', class { onmessage: any; postMessage(value: any) { replies.push(structuredClone(value)); } });
    replace('navigator', { locks: locks = sharedLocks() });
    replace('GM', { async getValue(key: string) { return structuredClone(storage.get(key)); },
        async setValue(key: string, value: any) { storage.set(key, structuredClone(value)); }, async deleteValue(key: string) { storage.delete(key); } });
    AppBridge.prototype.request = async function() { reads++; lastBridge = this; return { action: 'test-wire' }; };
    AppBridge.prototype.replay = async function() { return { action: 'test-wire' }; };
    host = new NativeHost(endpoint); await host.authorize(keys);
});
afterEach(() => {
    host.pause(); AppBridge.prototype.request = requestImpl; AppBridge.prototype.replay = replayImpl;
    for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
    }
    original.clear();
});

test('authorized session carries wire without storing any request or reply', async () => {
    await send(envelope(await session()));
    expect(reads).toBe(1); expect(replies.at(-1).value.packet.body.action).toBe('test-wire');
    expect([...storage.keys()]).toEqual([routeKey]);
    expect((lastBridge as any).websiteOrigin).toBe('https://login.example.org');
});
test('the local bridge pins the website independently of a requested metadata override', async () => {
    const posted: any[] = [];
    replace('window', { postMessage(value: any) { posted.push(value); } });
    const bridge = new AppBridge(endpoint.origin, 'https://login.example.org');
    const result = requestImpl.call(bridge, { action: 'ping', kwWebsiteOrigin: 'https://attacker.example' });
    const canceled = result.catch(error => error);
    expect(posted[0].kwWebsiteOrigin).toBe('https://login.example.org');
    bridge.dispose(); await canceled;
});
test('recovery distinguishes invalid saved selection from first use', async () => {
    storage.set(routeKey, { host: 'invalid' });
    await expect(approvedRoute(endpoint, true)).rejects.toThrow('Saved app selection is invalid');
    storage.delete(routeKey);
    expect(await approvedRoute(endpoint, true)).toBeUndefined();
});
test('tampered origin and forged signature never reach the app', async () => {
    const p = await session();
    const signed = envelope(p); signed.packet = { ...p, origin: 'https://attacker.example' };
    await send(signed); await send({ packet: p, signature: 'invalid' });
    expect(reads).toBe(0); expect(replies).toHaveLength(1);
});
test('consumed signed request cannot execute twice', async () => {
    const value = envelope(await session()); await send(value); await send(value);
    expect(reads).toBe(1); expect(replies).toHaveLength(2);
});
test('expired or excessively long signed request cannot execute', async () => {
    const p = await session();
    await send(envelope({ ...p, deadline: Date.now() - 1 }));
    await send(envelope({ ...p, deadline: Date.now() + 100000 }));
    expect(reads).toBe(0); expect(replies).toHaveLength(1);
});
test('wrong origin, document, scope and endpoint cannot use an existing session', async () => {
    const p = await session();
    for (const field of ['origin', 'document', 'scope', 'endpoint']) {
        const value = field === 'origin' ? 'https://attacker.example' : field === 'endpoint' ? 'https://elsewhere.example/app' : crypto.randomUUID();
        await send(envelope({ ...p, id: crypto.randomUUID(), [field]: value }));
    }
    expect(reads).toBe(0);
});
test('a fresh website session invalidates previous handles rather than sharing one native port', async () => {
    const p = await session(); await session(); await send(envelope(p));
    expect(reads).toBe(0); expect(replies.at(-1).value.packet.error).toContain('session changed');
});
test('another selected app prevents the old host from serving a still valid request', async () => {
    const p = await session(); storage.set(routeKey, { ...storage.get(routeKey), host: crypto.randomUUID() });
    await send(envelope(p)); expect(reads).toBe(0); expect(replies).toHaveLength(1);
});
test('pause and revocation reject subsequent requests', async () => {
    const p = await session(); host.pause(); await send(envelope(p)); expect(reads).toBe(0);
    host.resume(); await host.revoke(); await send(envelope(p)); expect(reads).toBe(0); expect(storage.has(routeKey)).toBe(false);
});
test('locked native endpoint cannot return fields through an existing session', async () => {
    const p = await session(); await send(envelope(p)); lastBridge.onLocked();
    await send(envelope({ ...p, id: crypto.randomUUID(), body: { action: 'kwx-get-entry-fields' } }));
    expect(reads).toBe(1); expect(replies.at(-1).value.packet.error).toContain('locked');
});
test('release while a real request is pending drops its eventual reply', async () => {
    const p = await session(); let resolve!: (value: any) => void;
    AppBridge.prototype.request = async () => { reads++; return new Promise(done => { resolve = done; }); };
    const running = send(envelope(p));
    for (let turn = 0; !resolve && turn < 20; turn++) await Promise.resolve();
    expect(reads).toBe(1);
    await send(envelope({ ...p, id: crypto.randomUUID(), operation: 'release', body: undefined }));
    resolve({ action: 'kwx-get-entry-fields', message: 'encrypted-fixture' }); await running;
    expect(replies).toHaveLength(1);
});
test('a simultaneous new website cannot steal a busy protocol session', async () => {
    const p = await session(); let resolve!: (value: any) => void;
    AppBridge.prototype.request = async () => new Promise(done => { resolve = done; });
    const running = send(envelope(p));
    for (let turn = 0; !resolve && turn < 20; turn++) await Promise.resolve();
    await send(envelope(packet())); expect(replies.at(-1).value.packet.error).toContain('finishing');
    resolve({ action: 'test-wire' }); await running;
    expect(replies.at(-1).value.packet.body.action).toBe('test-wire');
});

test('closing during authorization cannot activate a delayed settings write', async () => {
    await host.revoke(); let finish!: () => void;
    const gm = (globalThis as any).GM;
    gm.setValue = (key: string, value: any) => new Promise<void>(resolve => {
        finish = () => { storage.set(key, structuredClone(value)); resolve(); };
    });
    const pending = host.authorize(keys); void pending.catch(() => {});
    for (let turn = 0; !finish && turn < 20; turn++) await Promise.resolve();
    expect(typeof finish).toBe('function'); host.pause(); finish();
    await expect(pending).rejects.toThrow('canceled'); expect(storage.has(routeKey)).toBe(false);
    expect((host as any).live).toBe(false);
});
test.each(['before write', 'after write'])('canceled authorization cannot erase its replacement (%s)', async phase => {
    await host.revoke();
    const entered = deferred(), finish = deferred();
    const gm = (globalThis as any).GM, set = gm.setValue;
    let first = true;
    gm.setValue = async (key: string, value: any) => {
        if (first && key === routeKey) {
            first = false;
            if (phase === 'after write') await set(key, value);
            entered.resolve(); await finish.promise;
            if (phase === 'before write') await set(key, value);
        } else await set(key, value);
    };
    const canceled = host.authorize(keys).catch(error => error);
    await entered.promise;
    host.pause();
    const replacement = host.authorize(keys);
    finish.resolve();
    expect((await canceled).message).toContain('canceled');
    await replacement;
    expect(storage.get(routeKey)?.host).toBe((host as any).host);
    expect((host as any).live).toBe(true);
    await send(envelope(packet()));
    expect(replies.at(-1).value.packet.body.appBoot).toBe((host as any).host);
});
test('a pending revoke cannot erase a subsequent authorization on the same host', async () => {
    const entered = deferred(), finish = deferred();
    const gm = (globalThis as any).GM, get = gm.getValue;
    let first = true;
    gm.getValue = async (key: string) => {
        const value = await get(key);
        if (first && key === routeKey) { first = false; entered.resolve(); await finish.promise; }
        return value;
    };
    const revoked = host.revoke(); await entered.promise;
    const replacement = host.authorize(keys);
    finish.resolve(); await revoked; await replacement;
    expect(storage.get(routeKey)?.host).toBe((host as any).host);
    expect((host as any).live).toBe(true);
});
test.each(['before write', 'after write'])('a canceled write cannot erase another host selected afterward (%s)', async phase => {
    await host.revoke();
    const entered = deferred(), finish = deferred();
    const gm = (globalThis as any).GM, set = gm.setValue;
    const published: string[] = [];
    let first = true;
    gm.setValue = async (key: string, value: any) => {
        if (key !== routeKey) return set(key, value);
        published.push(value.host);
        if (first) {
            first = false;
            if (phase === 'after write') await set(key, value);
            entered.resolve(); await finish.promise;
            if (phase === 'before write') await set(key, value);
        } else await set(key, value);
    };
    const old = host.authorize(keys).catch(error => error);
    await entered.promise; host.pause();
    const other = new NativeHost(endpoint), requests = locks.requested.length;
    const next = other.authorize(keys);
    try {
        await until(() => locks.requested.length === requests + 1);
        expect(published).toEqual([(host as any).host]);
        finish.resolve(); expect((await old).message).toContain('canceled'); await next;
        expect(published).toEqual([(host as any).host, (other as any).host]);
        expect(storage.get(routeKey)?.host).toBe((other as any).host);
        expect((other as any).live).toBe(true);
    } finally { finish.resolve(); await Promise.allSettled([old, next]); other.pause(); }
});
test.each(['read', 'delete'])('a delayed revoke cannot delete another host publication (%s)', async phase => {
    const entered = deferred(), finish = deferred();
    const gm = (globalThis as any).GM, get = gm.getValue, remove = gm.deleteValue;
    let first = true;
    gm.getValue = async (key: string) => {
        const value = await get(key);
        if (phase === 'read' && first && key === routeKey) { first = false; entered.resolve(); await finish.promise; }
        return value;
    };
    gm.deleteValue = async (key: string) => {
        if (phase === 'delete' && first && key === routeKey) { first = false; entered.resolve(); await finish.promise; }
        await remove(key);
    };
    const old = host.revoke(); await entered.promise;
    const other = new NativeHost(endpoint), requests = locks.requested.length;
    const next = other.authorize(keys);
    try {
        await until(() => locks.requested.length === requests + 1);
        expect(storage.get(routeKey)?.host).toBe((host as any).host);
        finish.resolve(); await old; await next;
        expect(storage.get(routeKey)?.host).toBe((other as any).host);
        expect((other as any).live).toBe(true);
    } finally { finish.resolve(); await Promise.allSettled([old, next]); other.pause(); }
});
test.each(['already published', 'pending write'])('restore rechecks the owner after a newer explicit selection (%s)', async phase => {
    host.pause(); expect(await host.selected()).toBe(true);
    const other = new NativeHost(endpoint), entered = deferred(), finish = deferred();
    const gm = (globalThis as any).GM, set = gm.setValue;
    gm.setValue = async (key: string, value: any) => {
        if (phase === 'pending write' && key === routeKey && value.host === (other as any).host) {
            entered.resolve(); await finish.promise;
        }
        await set(key, value);
    };
    const explicit = other.authorize(keys);
    if (phase === 'already published') await explicit; else await entered.promise;
    const requests = locks.requested.length;
    // The protocol/features awaits have finished after selected() returned true.
    const restore = host.authorize(keys, () => true, 'restore').catch(error => error);
    try {
        await until(() => locks.requested.length === requests + 1);
        finish.resolve(); await explicit;
        expect((await restore).message).toContain('Another KeeWebX tab');
        expect(storage.get(routeKey)?.host).toBe((other as any).host);
        expect((host as any).live).toBe(false);
        // A subsequent deliberate selection is still allowed to replace it.
        await host.authorize(keys, () => true, 'explicit');
        expect(storage.get(routeKey)?.host).toBe((host as any).host);
    } finally { finish.resolve(); await Promise.allSettled([explicit, restore]); other.pause(); }
});
test('restoration for the selected owner succeeds, but cancellation during its owner read never writes', async () => {
    host.pause(); await host.authorize(keys, () => true, 'restore');
    expect((host as any).live).toBe(true); host.pause();
    const entered = deferred(), finish = deferred();
    const gm = (globalThis as any).GM, get = gm.getValue, set = gm.setValue;
    let writes = 0;
    gm.getValue = async (key: string) => {
        const value = await get(key);
        if (key === routeKey) { entered.resolve(); await finish.promise; }
        return value;
    };
    gm.setValue = async (...args: any[]) => { writes++; await set(...args); };
    const restore = host.authorize(keys, () => true, 'restore').catch(error => error);
    await entered.promise; host.pause(); finish.resolve();
    expect((await restore).message).toContain('canceled');
    expect(writes).toBe(0); expect((host as any).live).toBe(false);
});
test.each(['missing', 'rejecting', 'throwing'])('unavailable Web Locks fail closed (%s)', async failure => {
    host.pause();
    const previous = structuredClone(storage.get(routeKey));
    const request = () => {
        if (failure === 'throwing') throw new Error('SecurityError');
        return Promise.reject(new Error('SecurityError'));
    };
    replace('navigator', failure === 'missing' ? {} : { locks: { request } });
    const other = new NativeHost(endpoint);
    try {
        await expect(other.authorize(keys)).rejects.toThrow(failure === 'missing' ? 'Web Locks' : 'could not lock');
        expect(storage.get(routeKey)).toEqual(previous); expect((other as any).live).toBe(false);
        await expect(host.revoke()).rejects.toThrow(failure === 'missing' ? 'Web Locks' : 'could not lock');
        expect(storage.get(routeKey)).toEqual(previous); expect((host as any).keys).toBeUndefined();
        replace('navigator', { locks });
        await other.authorize(keys);
        expect(storage.get(routeKey)?.host).toBe((other as any).host);
    } finally { other.pause(); }
});
test('caller timeouts retain the shared lock until underlying storage and cleanup finish', async () => {
    await host.revoke();
    const entered = deferred(), finish = deferred();
    const gm = (globalThis as any).GM, set = gm.setValue;
    let writes = 0;
    gm.setValue = async (key: string, value: any) => {
        writes++;
        if (writes === 1) { entered.resolve(); await finish.promise; }
        await set(key, value);
    };
    const old = host.authorize(keys).catch(error => error);
    await entered.promise;
    const other = new NativeHost(endpoint), requests = locks.requested.length;
    const waiting = other.authorize(keys).catch(error => error);
    try {
        await until(() => locks.requested.length === requests + 1);
        expect((await old).message).toContain('did not respond');
        expect((await waiting).message).toContain('did not respond');
        expect(locks.active.size).toBe(1); expect(writes).toBe(1);
        expect(storage.has(routeKey)).toBe(false);
        finish.resolve(); await locks.idle();
        expect(locks.active.size).toBe(0); expect(writes).toBe(1);
        expect(storage.has(routeKey)).toBe(false);
        await other.authorize(keys);
        expect(storage.get(routeKey)?.host).toBe((other as any).host);
    } finally { finish.resolve(); await Promise.allSettled([old, waiting]); other.pause(); }
}, 15000);
test('pause and resume cannot admit a hello that awaited selection in the old generation', async () => {
    const entered = deferred(), finish = deferred();
    const gm = (globalThis as any).GM, get = gm.getValue;
    let first = true;
    gm.getValue = async (key: string) => {
        const value = await get(key);
        if (first && key === routeKey) { first = false; entered.resolve(); await finish.promise; }
        return value;
    };
    const old = packet(), pending = send(envelope(old)); await entered.promise;
    host.pause(); host.resume();
    const current = packet(); await send(envelope(current));
    finish.resolve(); await pending;
    expect((host as any).session.document).toBe(current.document);
    expect(replies).toHaveLength(1);
    expect(replies[0].value.packet.document).toBe(current.document);
});
test.each(['getTab failure', 'saveTab failure', 'lost tab metadata'])('explicit selection recovers from %s without restoring a duplicate', async failure => {
    const gm = (globalThis as any).GM;
    let tab: any = {};
    gm.getTab = async () => { if (failure === 'getTab failure') throw new Error('Tab unavailable'); return tab; };
    gm.saveTab = async (value: any) => { if (failure === 'saveTab failure') throw new Error('Tab unavailable'); tab = value; };
    const recovering = new NativeHost(endpoint);
    let duplicate: InstanceType<typeof NativeHost> | undefined;
    try {
        expect(await recovering.selected()).toBe(false);
        await recovering.authorize(keys);
        expect(storage.get(routeKey)?.host).toBe((recovering as any).host);
        expect((recovering as any).live).toBe(true);
        tab = {};
        duplicate = new NativeHost(endpoint);
        expect(await duplicate.selected()).toBe(false);
        expect(storage.get(routeKey)?.host).toBe((recovering as any).host);
    } finally { recovering.pause(); duplicate?.pause(); }
});
test('browser tab ownership restores across reload but not duplicated sessionStorage', async () => {
    host.pause(); let tab: any = null;
    const gm = (globalThis as any).GM;
    gm.getTab = async () => structuredClone(tab);
    gm.saveTab = async (value: any) => { tab = structuredClone(value); };
    const selected = new NativeHost(endpoint); await selected.authorize(keys);
    const reload = new NativeHost(endpoint); expect(await reload.selected()).toBe(true);
    tab = null;
    const duplicate = new NativeHost(endpoint); expect(await duplicate.selected()).toBe(false);
    selected.pause(); reload.pause(); duplicate.pause();
});

test('dispose between the selection await and call continuation prevents publication', async () => {
    replace('location', { href: 'https://second.example/login', origin: 'https://second.example' });
    const client = new NativeRpc(endpoint, () => undefined);
    const sent: any[] = [];
    Object.assign(client, { keys, route: storage.get(routeKey), window: { closed: false, postMessage(value: any) { sent.push(value); } } });
    // Resolve the real selection check, then cancel before its caller resumes.
    const selected = client.assertSelected.bind(client);
    client.assertSelected = async () => { await selected(); queueMicrotask(() => client.dispose()); };
    try {
        await expect(client.call('probe', undefined, 50)).rejects.toThrow('changed');
        expect(sent).toHaveLength(0);
        expect((client as any).pending.size).toBe(0);
    } finally { client.dispose(); }
});

test('a connector closed during setup falls back to the approved mailbox', async () => {
    host.pause();
    (globalThis as any).GM.listValues = async () => [...storage.keys()];
    storage.set('keewebx-userscript-connect-identity-v1', { publicKey: toBase64(keys.publicKey), secretKey: toBase64(keys.secretKey) });
    await host.authorize(keys);
    replace('location', { href: 'https://second.example/login', origin: 'https://second.example' });
    const peer = { closed: false, postMessage() { peer.closed = true; throw new Error('Connection page closed during setup'); } };
    const client = new NativeRpc(endpoint, () => peer as unknown as Window);
    try {
        await client.connect();
        expect((await client.call('probe')).appBoot).toBe(storage.get(routeKey).host);
        expect((client as any).window).toBeUndefined();
    } finally { client.dispose(); host.pause(); }
});

test('cancellation during connector setup never starts mailbox recovery', async () => {
    host.pause();
    (globalThis as any).GM.listValues = async () => [...storage.keys()];
    storage.set('keewebx-userscript-connect-identity-v1', { publicKey: toBase64(keys.publicKey), secretKey: toBase64(keys.secretKey) });
    await host.authorize(keys);
    replace('location', { href: 'https://second.example/login', origin: 'https://second.example' });
    const peer = { closed: false, postMessage() { client.dispose(); peer.closed = true; } };
    const client = new NativeRpc(endpoint, () => peer as unknown as Window);
    try {
        await expect(client.connect()).rejects.toThrow('changed');
        expect([...storage.keys()].some(key => key.startsWith('keewebx-connect-mailbox-v1:request:'))).toBe(false);
        expect(replies).toHaveLength(0);
    } finally { client.dispose(); host.pause(); }
});


test('a website without any window association uses the same signed host and encrypted protocol admission', async () => {
    host.pause();
    (globalThis as any).GM.listValues = async () => [...storage.keys()];
    storage.set('keewebx-userscript-connect-identity-v1', { publicKey: toBase64(keys.publicKey), secretKey: toBase64(keys.secretKey) });
    await host.authorize(keys);
    replace('location', { href: 'https://second.example/login', origin: 'https://second.example' });
    const client = new NativeRpc(endpoint, () => undefined);
    try {
        await client.connect();
        expect((await client.call('probe')).appBoot).toBe(storage.get(routeKey).host);
        expect((await client.call('wire', { action: 'kwx-features' })).action).toBe('test-wire');
        expect(reads).toBe(1);
        const remove = (globalThis as any).GM.deleteValue;
        (globalThis as any).GM.deleteValue = (key: string) => {
            if (key.startsWith('keewebx-connect-mailbox-v1:reply:')) throw new Error('Cleanup unavailable');
            return remove(key);
        };
        expect((await client.call('probe')).appBoot).toBe(storage.get(routeKey).host);
    } finally { client.dispose(); host.pause(); }
});

// Direct ports pin the browser-observed site and use a synchronous App-origin
// selection lease. A native extension storage read must not stall hidden Apps.
let receiverMessage: (event: MessageEvent) => void;
async function directHost() {
    const local = new Map<string, string>();
    replace('localStorage', { getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => local.set(key, value), removeItem: (key: string) => local.delete(key) });
    replace('navigator', { locks, serviceWorker: { addEventListener(_type: string, listener: (event: MessageEvent) => void) { receiverMessage = listener; }, startMessages() {} } });
    replace('setInterval', () => 0);
    host.pause(); host = new NativeHost(endpoint); await host.authorize(keys);
    return local;
}
const directSend = (value: any, context = { origin: 'https://login.example.org', id: 'test-port' }) =>
    (host as any).receive(value, (value: any) => replies.push({ value }), context);
async function directSession() {
    const p = packet(); await directSend(envelope(p));
    return { ...p, operation: 'wire', id: crypto.randomUUID(), scope: replies.at(-1).value.packet.body.scope, body: { action: 'kwx-features' } };
}
test('the direct receiver registers without touching the WebStorage getter', async () => {
    await directHost();
    let storageReads = 0;
    replace('localStorage', { get getItem() { storageReads++; throw new Error('Unavailable'); } });
    host.pause(); host = new NativeHost(endpoint);
    expect(host.hasDirectReceiver).toBe(true);
    expect(storageReads).toBe(0);
});
test('authorized discovery acknowledges from memory when both storage APIs are unavailable', async () => {
    await directHost();
    let storageReads = 0, managerReads = 0;
    (globalThis as any).localStorage.getItem = () => { storageReads++; throw new Error('Unavailable'); };
    (globalThis as any).GM.getValue = () => { managerReads++; throw new Error('Unavailable'); };
    replace('setTimeout', () => 0);
    const messages: any[] = [];
    const port = { postMessage: (value: any) => messages.push(value), start() {}, close() {} };
    receiverMessage({ data: { marker: 'keewebx-connect-port-v1', kind: 'find-app', endpoint: endpoint.href, appBoot: (host as any).host },
        source: { scriptURL: new URL('connect-port/worker.js', endpoint).href }, ports: [port], isTrusted: false } as unknown as MessageEvent);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'app-ready', state: 'enabled', appBoot: (host as any).host });
    expect(storageReads).toBe(0); expect(managerReads).toBe(0); expect(reads).toBe(0);
    // An acknowledgement grants no credential access when the selection cannot be checked.
    await directSend(envelope(packet()));
    expect(storageReads).toBe(1); expect(reads).toBe(0);
});
test('receiver startup failure is observable and cannot advertise direct capability', () => {
    host.pause();
    replace('navigator', { locks, serviceWorker: { addEventListener() { throw new Error('Unavailable'); } } });
    const diagnostics: string[] = [];
    host = new NativeHost(endpoint, () => {}, value => diagnostics.push(value));
    expect(host.hasDirectReceiver).toBe(false);
    expect(diagnostics).toEqual(['Direct receiver startup failed: Error']);
});
test('direct transport still rejects unsigned or tampered hello requests', async () => {
    await directHost();
    const signed = envelope(packet());
    await directSend({ ...signed, signature: 'invalid' });
    await directSend({ ...signed, packet: { ...signed.packet, origin: 'https://attacker.example' } });
    expect(replies).toHaveLength(0); expect(reads).toBe(0);
});
test('a transient lease read failure does not permanently consume an unexecuted hello', async () => {
    await directHost();
    const local = (globalThis as any).localStorage, read = local.getItem;
    let unavailable = true;
    local.getItem = (key: string) => { if (unavailable) throw new Error('Unavailable'); return read(key); };
    const value = envelope(packet());
    await directSend(value); expect(replies).toHaveLength(0);
    unavailable = false;
    await directSend(value);
    expect(replies).toHaveLength(1); expect(replies[0].value.packet.body.scope).toBeString();
    expect(reads).toBe(0);
});
test('a lost direct hello receipt can be replayed without creating another session', async () => {
    await directHost();
    const value = envelope(packet());
    await directSend(value);
    const first = structuredClone(replies[0]), session = (host as any).session;
    replies.length = 0; // The first signed reply did not reach the website.
    await directSend(value);
    expect(replies).toEqual([first]);
    expect((host as any).session).toBe(session); expect(reads).toBe(0);
    const p = value.packet;
    const wire = envelope({ ...p, id: crypto.randomUUID(), operation: 'wire', scope: first.value.packet.body.scope, body: { action: 'kwx-features' } });
    await directSend(wire); await directSend(wire);
    expect(reads).toBe(1); expect(replies).toHaveLength(3);
    expect(replies[2]).toEqual(replies[1]);
});
test('a cached hello receipt cannot migrate to another physical port or another request', async () => {
    await directHost();
    const value = envelope(packet()); await directSend(value);
    await directSend(value, { origin: value.packet.origin, id: 'other-port' });
    await directSend(envelope({ ...value.packet, deadline: value.packet.deadline + 1 }));
    expect(replies).toHaveLength(1); expect(reads).toBe(0);
    await directSend(value); expect(replies).toHaveLength(2);
});
test.each(['selection', 'lock', 'new session', 'revoke'])('a cached hello cannot survive a changed grant or session (%s)', async change => {
    const local = await directHost();
    const value = envelope(packet()); await directSend(value);
    if (change === 'selection') local.set(`keewebx-native-connect-v1:active:${endpoint.href}`, crypto.randomUUID());
    else if (change === 'lock') host.lock();
    else if (change === 'new session') await directSend(envelope(packet()));
    else await host.revoke();
    const count = replies.length;
    await directSend(value);
    expect(replies).toHaveLength(count); expect(reads).toBe(0);
});
test('direct port hello and encrypted wire do not read background manager storage', async () => {
    await directHost();
    let managerReads = 0;
    (globalThis as any).GM.getValue = () => { managerReads++; return new Promise(() => {}); };
    const p = await directSession(); await directSend(envelope(p));
    expect(managerReads).toBe(0); expect(reads).toBe(1);
    expect(replies.at(-1).value.packet.body.action).toBe('test-wire');
});

test('direct hello can recover the same request after a transient lease admission failure', async () => {
    await directHost(); const p = packet(), local = (globalThis as any).localStorage, get = local.getItem;
    local.getItem = () => { throw new Error('Temporarily unavailable'); };
    await directSend(envelope(p));
    expect((host as any).consumed.has(p.id)).toBe(false);
    expect(replies).toHaveLength(0);
    local.getItem = get;
    await directSend(envelope(p));
    expect(replies).toHaveLength(1);
});

test('a direct hello receipt recovers a lost reply without replacing its session', async () => {
    await directHost(); const p = packet();
    await directSend(envelope(p));
    const session = (host as any).session, response = structuredClone(replies[0]);
    const reordered = Object.fromEntries(Object.entries(p).reverse());
    await directSend(envelope(reordered));
    expect(replies).toHaveLength(2);
    expect(replies[1]).toEqual(response);
    expect((host as any).session).toBe(session);
    expect(reads).toBe(0);
    await directSend(envelope(p), { origin: p.origin, id: 'another-port' });
    for (const changes of [{ document: crypto.randomUUID() }, { deadline: p.deadline - 1 }, { body: {} }, { scope: crypto.randomUUID() }]) {
        await directSend(envelope({ ...p, ...changes }));
    }
    expect(replies).toHaveLength(2);
    expect((host as any).session).toBe(session);
});

test('a direct wire retry resends its encrypted receipt without reexecuting the request', async () => {
    await directHost(); const p = await directSession(), receipt = (host as any).session.hello;
    await directSend(envelope(p)); await directSend(envelope(p));
    expect(reads).toBe(1);
    expect(replies).toHaveLength(3);
    expect(replies[2]).toEqual(replies[1]);
    expect((host as any).session.hello).toBe(receipt);
    expect(receipt.reply.packet.operation).toBe('hello');
});
test('an in-flight wire retry cannot execute work twice and a finished retry revalidates its receipt', async () => {
    await directHost(); const p = await directSession(), gate = deferred<Record<string, string>>();
    let checked = 0;
    AppBridge.prototype.request = async () => { reads++; return gate.promise; };
    AppBridge.prototype.replay = async () => { checked++; return { action: 'kwx-get-entry-fields', message: 'encrypted response', nonce: 'nonce' }; };
    const value = envelope(p), first = directSend(value);
    await Promise.resolve(); await directSend(value);
    expect(reads).toBe(1); expect(replies).toHaveLength(1);
    gate.resolve({ action: 'kwx-get-entry-fields', message: 'encrypted response', nonce: 'nonce' }); await first;
    await directSend(value);
    expect(reads).toBe(1); expect(checked).toBe(1); expect(replies).toHaveLength(3);
    expect(replies[2]).toEqual(replies[1]);
});
test('a wire receipt never bypasses current App permissions after a lost reply', async () => {
    await directHost(); const p = await directSession();
    AppBridge.prototype.request = async () => { reads++; return { action: 'kwx-get-entry-fields', message: 'old encrypted fields', nonce: 'nonce' }; };
    await directSend(envelope(p));
    AppBridge.prototype.replay = async () => ({ action: 'kwx-get-entry-fields', error: 'Access revoked', errorCode: '6' });
    await directSend(envelope(p));
    expect(reads).toBe(1);
    expect(replies.at(-1).value.packet.body.error).toBe('Access revoked');
    expect(JSON.stringify(replies.at(-1))).not.toContain('old encrypted fields');
});
test.each(['origin', 'scope', 'document', 'body', 'deadline', 'port', 'selection', 'lock', 'reauthorize', 'new session', 'revoke'])
('a wire receipt cannot cross a changed binding (%s)', async change => {
    const local = await directHost(), p = await directSession();
    let checked = 0;
    AppBridge.prototype.replay = async () => { checked++; return { action: 'test-wire' }; };
    await directSend(envelope(p));
    const changed = { ...p };
    if (change === 'origin') changed.origin = 'https://attacker.example';
    else if (change === 'scope' || change === 'document') changed[change] = crypto.randomUUID();
    else if (change === 'body') changed.body = { action: 'kwx-get-entry-fields' };
    else if (change === 'deadline') changed.deadline--;
    else if (change === 'selection') local.set(`keewebx-native-connect-v1:active:${endpoint.href}`, crypto.randomUUID());
    else if (change === 'lock') host.lock();
    else if (change === 'reauthorize') await host.authorize(keys);
    else if (change === 'new session') await directSend(envelope(packet()));
    else if (change === 'revoke') await host.revoke();
    const count = replies.length;
    await directSend(envelope(changed), { origin: p.origin, id: change === 'port' ? 'another-port' : 'test-port' });
    expect(checked).toBe(0); expect(replies).toHaveLength(count); expect(reads).toBe(1);
});

test('a direct hello receipt cannot cross reauthorization or a replacement session', async () => {
    await directHost(); const p = packet(); await directSend(envelope(p));
    await host.authorize(keys);
    await directSend(envelope(p));
    expect(replies).toHaveLength(1);
    const replacement = packet(); await directSend(envelope(replacement));
    const session = (host as any).session;
    await directSend(envelope(p));
    expect(replies).toHaveLength(2);
    expect((host as any).session).toBe(session);
});

test('a direct hello receipt is cleared by bridge lock and session release', async () => {
    await directHost(); const p = packet(); await directSend(envelope(p));
    (host as any).session.bridge.onLocked();
    expect((host as any).session.hello).toBeUndefined();
    await directSend(envelope(p)); expect(replies).toHaveLength(1);
    const fresh = packet(); await directSend(envelope(fresh));
    const scope = replies.at(-1).value.packet.body.scope;
    await directSend(envelope({ ...fresh, id: crypto.randomUUID(), operation: 'release', scope }));
    expect((host as any).session).toBeUndefined();
    await directSend(envelope(fresh)); expect(replies).toHaveLength(2);
});
test('direct port cannot override its browser-observed website origin', async () => {
    await directHost();
    await directSend(envelope(packet({ origin: 'https://attacker.example' })));
    expect(replies).toHaveLength(0); expect(reads).toBe(0);
});
test('an unrelated physical port cannot use another port session', async () => {
    await directHost(); const p = await directSession();
    await directSend(envelope(p), { origin: p.origin, id: 'another-port' });
    expect(reads).toBe(0); expect(replies.at(-1).value.packet.error).toContain('session changed');
});
test('changing App selection synchronously rejects a previous direct grant', async () => {
    const local = await directHost(), p = await directSession();
    local.set(`keewebx-native-connect-v1:active:${endpoint.href}`, crypto.randomUUID());
    await directSend(envelope(p)); expect(reads).toBe(0); expect(replies).toHaveLength(1);
});
test('a changed selection drops a delayed encrypted direct response', async () => {
    const local = await directHost(), p = await directSession(), gate = deferred<any>();
    AppBridge.prototype.request = () => gate.promise;
    const running = directSend(envelope(p)); await Promise.resolve();
    local.set(`keewebx-native-connect-v1:active:${endpoint.href}`, crypto.randomUUID());
    gate.resolve({ action: 'test-wire' }); await running;
    expect(replies).toHaveLength(1);
});
test('locking or revoking the App prevents existing direct scopes from reading', async () => {
    await directHost(); const p = await directSession(); host.lock();
    await directSend(envelope(p)); expect(replies.at(-1).value.packet.error).toContain('locked');
    await host.revoke(); await directSend(envelope({ ...p, id: crypto.randomUUID() })); expect(reads).toBe(0);
});

test('unlocking avoids GM reads and unavailable revocation metadata fails closed', async () => {
    await directHost(); let managerReads = 0;
    (globalThis as any).GM.getValue = () => { managerReads++; return new Promise(() => {}); };
    host.lock(); expect(host.unlock()).toBe(true);
    const p = await directSession(); await directSend(envelope(p)); expect(reads).toBe(1);
    expect(managerReads).toBe(0);
    await host.revoke(); expect(host.unlock()).toBe(false);
    expect(storage.has(routeKey)).toBe(true); expect(managerReads).toBe(1);
    await directSend(envelope({ ...p, id: crypto.randomUUID() })); expect(reads).toBe(1);
});

test('unlock discards a session locked by an App notification before a new handshake', async () => {
    await directHost(); const previous = await directSession();
    await directSend(envelope(previous));
    lastBridge.onLocked();
    expect(host.diagnostics().locked).toBe(true);
    expect(host.unlock()).toBe(true);
    expect(host.diagnostics().hasSession).toBe(false);
    await directSend(envelope({ ...previous, id: crypto.randomUUID(), body: { action: 'kwx-get-entry-fields' } }));
    expect(reads).toBe(1);
    expect(replies.at(-1).value.packet.error).toContain('session changed');
    const fresh = await directSession(); await directSend(envelope(fresh));
    expect(reads).toBe(2);
    expect(replies.at(-1).value.packet.error).toBeUndefined();
});

test('host diagnostics are a frozen primitive snapshot without manager reads or private metadata', async () => {
    const local = await directHost();
    (globalThis as any).GM.getValue = () => { throw new Error('Diagnostics must not read manager storage'); };
    const before = host.diagnostics();
    expect(Object.isFrozen(before)).toBe(true);
    expect(before).toEqual({ locked: false, live: true, selected: true, direct: true, hasSession: false, authorization: 1, runtimeCount: 1 });
    await directSession(); host.lock();
    expect(host.diagnostics()).toEqual({ ...before, locked: true });
    expect(before.locked).toBe(false);
    local.clear();
    expect(host.diagnostics().selected).toBe(false);
    host.pause();
    expect(host.diagnostics()).toEqual({ ...before, locked: true, live: false, selected: false, authorization: 2 });
});

test('a legacy-only host selection invalidates the previous direct marker', async () => {
    const local = await directHost(), p = await directSession();
    replace('navigator', { locks });
    const other = new NativeHost(endpoint);
    try {
        await other.authorize(keys);
        expect(local.has(`keewebx-native-connect-v1:active:${endpoint.href}`)).toBe(false);
        await directSend(envelope(p)); expect(reads).toBe(0);
    } finally { other.pause(); }
});
test('canceling another App publication leaves no previous direct grant active', async () => {
    const local = await directHost(), p = await directSession(), gate = deferred();
    const gm = (globalThis as any).GM, set = gm.setValue;
    gm.setValue = async (key: string, value: any) => { await set(key, value); await gate.promise; };
    const other = new NativeHost(endpoint), pending = other.authorize(keys).catch(error => error);
    try {
        await until(() => storage.get(routeKey)?.host === (other as any).host);
        other.pause(); gate.resolve(); expect((await pending).message).toContain('canceled');
        expect(local.has(`keewebx-native-connect-v1:active:${endpoint.href}`)).toBe(false);
        expect(storage.has(routeKey)).toBe(false);
        await directSend(envelope(p)); expect(reads).toBe(0);
    } finally { gate.resolve(); await pending; other.pause(); }
});
test('failed synchronous marker publication cannot leave a previous direct grant active', async () => {
    const local = await directHost(), p = await directSession();
    (globalThis as any).localStorage.setItem = () => { throw new Error('Storage unavailable'); };
    const other = new NativeHost(endpoint);
    try {
        await expect(other.authorize(keys)).rejects.toThrow('Storage unavailable');
        expect(storage.has(routeKey)).toBe(false);
        expect(local.has(`keewebx-native-connect-v1:active:${endpoint.href}`)).toBe(false);
        await directSend(envelope(p)); expect(reads).toBe(0);
    } finally { other.pause(); }
});

function grantEvents() {
    const listeners = new Set<(changes: any, area: string) => void>();
    (globalThis as any).GM.info = { scriptHandler: 'Userscripts', script: { filename: 'Connect.user.js' } };
    replace('browser', { storage: { onChanged: { addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) } } });
    return (oldValue: any, newValue: any) => { for (const listener of listeners) listener({ ['Connect.user.js---' + routeKey]: { oldValue, newValue } }, 'local'); };
}
test('an actual older-version selection event invalidates a current direct grant without GM reads', async () => {
    const change = grantEvents(), local = await directHost(), p = await directSession();
    change(structuredClone(storage.get(routeKey)), { host: crypto.randomUUID() });
    expect(local.has(`keewebx-native-connect-v1:active:${endpoint.href}`)).toBe(false);
    await directSend(envelope(p)); expect(reads).toBe(0);
});
test('a delayed old selection event cannot revoke a freshly republished grant', async () => {
    const change = grantEvents(), local = await directHost(), previous = structuredClone(storage.get(routeKey));
    await host.authorize(keys);
    change(previous, { host: crypto.randomUUID() });
    expect(local.get(`keewebx-native-connect-v1:active:${endpoint.href}`)).toBe((host as any).host);
    await directSend(envelope(await directSession())); expect(reads).toBe(1);
});

test('revoking with a stale public marker never deletes an older receiver selection', async () => {
    await directHost(); const other = { ...storage.get(routeKey), host: crypto.randomUUID() };
    storage.set(routeKey, other); // An older loaded receiver does not publish a direct marker.
    await host.revoke(); expect(storage.get(routeKey)).toEqual(other);
});

test('explicit disconnect prevents automatic restoration even if GM cleanup cannot read ownership', async () => {
    await directHost();
    (globalThis as any).GM.getValue = () => new Promise(() => {});
    await host.revoke(); const other = new NativeHost(endpoint);
    try {
        expect(await other.selected()).toBe(false);
        await expect(other.authorize(keys, () => true, 'restore')).rejects.toThrow('disconnected');
        await other.authorize(keys); // Only explicit authorization clears the persistent intent.
        expect((other as any).live).toBe(true);
    } finally { other.pause(); }
});
