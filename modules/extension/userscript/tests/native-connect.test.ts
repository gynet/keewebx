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
const { NativeHost, NativeRpc } = await import('../src/native-connect');
let host: InstanceType<typeof NativeHost>, keys: ReturnType<typeof sign.keyPair>;
let storage: Map<string, any>, replies: any[], reads: number, lastBridge: AppBridge;
let locks: ReturnType<typeof sharedLocks>;
const requestImpl = AppBridge.prototype.request;
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
    host = new NativeHost(endpoint); await host.authorize(keys);
});
afterEach(() => {
    host.pause(); AppBridge.prototype.request = requestImpl;
    for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
    }
    original.clear();
});

test('authorized session carries wire without storing any request or reply', async () => {
    await send(envelope(await session()));
    expect(reads).toBe(1); expect(replies.at(-1).value.packet.body.action).toBe('test-wire');
    expect([...storage.keys()]).toEqual([routeKey]);
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
