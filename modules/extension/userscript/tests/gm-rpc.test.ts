// Transport security only. Actual KDBX and native consent are covered by gm-connect.mjs.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { sign } from 'tweetnacl';
import { AppBridge } from '../src/app-bridge';
import { GmHost, GmRpc } from '../src/gm-rpc';
import { identity } from '../src/identity';
import { toBase64 } from '../../src/background/utils';

const endpoint = new URL('https://keewebx.app/app');
const site = 'https://first.example';
const store = new Map<string, any>();
let host: GmHost;
let client: GmRpc;
let writes: Array<{ key: string; value: any }>;
let mutate: ((key: string, value: any) => any) | undefined;
let wireReads: number;
const originals = new Map<string, PropertyDescriptor | undefined>();
const bridgeRequest = AppBridge.prototype.request;
const stableJSON = (value: any) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function globalValue(key: string, value: any) {
    if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
async function until<T>(read: () => T | Promise<T>, condition: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { const value = await read(); if (condition(value)) return value; await Bun.sleep(15); }
    throw new Error('Expected signed transport state did not arrive.');
}
const request = () => writes.find(item => item.key.includes('request-v2:') && item.value.packet.operation === 'hello')!;
const responseKey = (packet: any) => `keewebx-userscript-connect-reply-v2:${packet.host}:${packet.id}`;
async function inject(packet: any) {
    const keys = await identity();
    const value = { packet, signature: toBase64(sign.detached(new TextEncoder().encode(stableJSON(packet)), keys.secretKey)) };
    const key = `keewebx-userscript-connect-request-v2:${packet.host}:${packet.id}`;
    store.set(key, structuredClone(value));
    await until(() => store.has(key), present => !present);
}

beforeEach(async () => {
    store.clear(); writes = []; mutate = undefined; wireReads = 0;
    globalValue('location', { href: site + '/login', origin: site });
    globalValue('document', { visibilityState: 'visible' });
    globalValue('addEventListener', () => {}); globalValue('removeEventListener', () => {});
    globalValue('window', { postMessage() {} });
    globalValue('GM', {
        async getValue(key: string) { return structuredClone(store.get(key)); },
        async setValue(key: string, value: any) {
            writes.push({ key, value: structuredClone(value) });
            store.set(key, structuredClone(mutate ? mutate(key, value) : value));
        },
        async deleteValue(key: string) { store.delete(key); },
        async listValues() { return [...store.keys()]; },
        async getTab() { return {}; }, async saveTab() {}
    });
    AppBridge.prototype.request = async () => { wireReads++; return { action: 'test-wire' }; };
    host = new GmHost(endpoint);
    await host.authorize(await identity(true));
    client = new GmRpc(endpoint); await client.connect();
});
afterEach(async () => {
    client?.dispose(); host?.pause(); await Bun.sleep(5);
    AppBridge.prototype.request = bridgeRequest;
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
    }
    originals.clear();
});

test('one approved host serves a second origin without replacing the first document session', async () => {
    const first = request().value.packet;
    globalValue('location', { href: 'https://second.example/login', origin: 'https://second.example' });
    const second = new GmRpc(endpoint); await second.connect();
    const secondResult = await second.call('probe'); second.dispose();
    globalValue('location', { href: site + '/login', origin: site });
    const firstResult = await client.call('probe');
    expect(secondResult.appBoot).toBe(first.host); expect(firstResult.appBoot).toBe(first.host);
    expect(wireReads).toBe(0);
});

test('altering an origin without a new signature is rejected', async () => {
    mutate = (key, value) => key.includes('request-v2:') ? { ...value, packet: { ...value.packet, origin: 'https://attacker.example' } } : value;
    await expect(client.call('probe', undefined, 600)).rejects.toThrow();
    expect(wireReads).toBe(0);
});

test('serialized storage can reorder nested object keys without breaking a signed round trip', async () => {
    const reordered = (value: any): any => Array.isArray(value) ? value.map(reordered) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reordered(value[key])])) : value;
    mutate = (_key, value) => reordered(JSON.parse(JSON.stringify(value)));
    const response = await client.call('probe', undefined, 700);
    expect(response.appBoot).toBe(request().value.packet.host);
});

test('replaying a consumed signed hello cannot create another reply', async () => {
    const original = request(); const p = original.value.packet;
    expect(store.has(responseKey(p))).toBe(false);
    store.set(original.key, structuredClone(original.value));
    await until(() => store.has(original.key), present => !present);
    expect(store.has(responseKey(p))).toBe(false);
});

test('an expired but correctly signed wire request cannot reach the app bridge', async () => {
    const p = { ...request().value.packet, id: crypto.randomUUID(), operation: 'wire', deadline: Date.now() - 1, body: { action: 'kwx-get-entry-fields' } };
    await inject(p);
    expect(wireReads).toBe(0); expect(store.has(responseKey(p))).toBe(false);
});

test('a correctly signed request with the wrong session scope cannot read fields', async () => {
    const p = { ...request().value.packet, id: crypto.randomUUID(), operation: 'wire', scope: crypto.randomUUID(),
        deadline: Date.now() + 2000, body: { action: 'kwx-get-entry-fields' } };
    await inject(p);
    const response = await until(() => store.get(responseKey(p)), value => !!value);
    expect(response.packet.error).toContain('Find accounts again'); expect(wireReads).toBe(0);
});

test('revoking the selected host cancels new calls instead of selecting another app', async () => {
    await host.revoke();
    await expect(client.call('probe')).rejects.toThrow('authorized KeeWebX tab changed');
    expect(wireReads).toBe(0);
});

test('disposing a waiting client removes its pending request', async () => {
    host.pause();
    const waiting = client.call('probe');
    void waiting.catch(() => {});
    await until(() => writes.filter(item => item.value?.packet?.operation === 'probe').length, count => count > 0);
    const p = writes.find(item => item.value?.packet?.operation === 'probe')!.value.packet;
    client.dispose(); await expect(waiting).rejects.toThrow('canceled');
    await until(() => store.has(`keewebx-userscript-connect-request-v2:${p.host}:${p.id}`), present => !present);
});

test('a manager read that never settles cannot bypass the absolute request timeout', async () => {
    const nativeGet = (globalThis as any).GM.getValue;
    (globalThis as any).GM.getValue = (key: string) => key.includes('reply-v2:') ? new Promise(() => {}) : nativeGet(key);
    await expect(client.call('probe', undefined, 180)).rejects.toThrow('did not reply');
});

test('a manager write that never settles cannot bypass the absolute request timeout', async () => {
    const nativeSet = (globalThis as any).GM.setValue;
    (globalThis as any).GM.setValue = (key: string, value: any) => key.includes('request-v2:') ? new Promise(() => {}) : nativeSet(key, value);
    await expect(client.call('probe', undefined, 180)).rejects.toThrow('did not reply');
});

test('a website detects an old app script before waiting for an incompatible reply', async () => {
    const key = `keewebx-userscript-connect-route-v2:${endpoint.href}`;
    const route = { ...store.get(key) }; delete route.format; store.set(key, route);
    const next = new GmRpc(endpoint);
    await expect(next.connect()).rejects.toThrow('Reload the authorized KeeWebX tab');
    next.dispose();
});
