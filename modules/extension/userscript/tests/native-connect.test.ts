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
const { NativeHost } = await import('../src/native-connect');
let host: InstanceType<typeof NativeHost>, keys: ReturnType<typeof sign.keyPair>;
let storage: Map<string, any>, replies: any[], reads: number, lastBridge: AppBridge;
const requestImpl = AppBridge.prototype.request;
const stable = (value: any): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
function envelope(packet: any) { return { packet, signature: toBase64(sign.detached(new TextEncoder().encode(stable(packet)), keys.secretKey)) }; }
function packet(overrides: any = {}) {
    return { type: 'request', host: storage.get(routeKey).host, endpoint: endpoint.href, id: crypto.randomUUID(),
        document: crypto.randomUUID(), origin: 'https://login.example.org', operation: 'hello', deadline: Date.now() + 5000, ...overrides };
}
const send = (value: any) => (host as any).receive(value);
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
