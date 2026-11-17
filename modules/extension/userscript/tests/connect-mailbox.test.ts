import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ConnectMailbox, mailboxRequest } from '../src/connect-mailbox';

const ROOT = 'keewebx-connect-mailbox-v1:';
const host = crypto.randomUUID();
const key = (kind: string, id: string, owner = host) => `${ROOT}${kind}:${owner}:${id}`;
const original = new Map<string, PropertyDescriptor | undefined>();
const realNow = Date.now;
let now: number, nextTimer: number, storage: Map<string, any>, delivered: string[], errors: string[];
let timers: Map<number, { at: number; fn: () => void }>, stops: (() => void)[];
function replace(name: string, value: any) {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
async function flush() { for (let i = 0; i < 3000; i++) await Promise.resolve(); }
async function advance(ms: number) {
    const target = now + ms;
    for (;;) {
        const next = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = target; await flush();
}
function envelope(deadline = now + 10000, owner = host) {
    return { packet: { type: 'request', host: owner, id: crypto.randomUUID(), deadline }, signature: 'admission-tested-by-native-host' };
}
function start(deliver = async (value: any) => { delivered.push(value.packet.id); }) {
    const mailbox = new ConnectMailbox(host, deliver, error => errors.push(error.message));
    stops.push(() => mailbox.stop()); mailbox.start(); return mailbox;
}
beforeEach(() => {
    now = 100000; nextTimer = 0; storage = new Map(); delivered = []; errors = []; timers = new Map(); stops = [];
    Date.now = () => now;
    replace('setTimeout', (fn: () => void, delay = 0) => { const id = ++nextTimer; timers.set(id, { at: now + delay, fn }); return id; });
    replace('clearTimeout', (id: number) => { timers.delete(id); });
    replace('addEventListener', () => {}); replace('removeEventListener', () => {});
    replace('GM', {
        async getValue(name: string) { return structuredClone(storage.get(name)); },
        async setValue(name: string, value: any) { storage.set(name, structuredClone(value)); },
        async deleteValue(name: string) { storage.delete(name); },
        async listValues() { return [...storage.keys()]; }
    });
});
afterEach(async () => {
    for (const stop of stops) stop();
    await flush(); Date.now = realNow;
    for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name];
    }
    original.clear();
});

test('failed request cleanup does not prevent delivery', async () => {
    const value = envelope(); storage.set(key('request', value.packet.id), value);
    (globalThis as any).GM.deleteValue = async () => { throw new Error('Cleanup unavailable'); };
    start(); await flush();
    expect(delivered).toContain(value.packet.id);
});

test('unexpired replies cannot crowd a new request out of the scan', async () => {
    for (let i = 0; i < 128; i++) { const value = envelope(); storage.set(key('reply', value.packet.id), value); }
    const request = envelope(); storage.set(key('request', request.packet.id), request);
    start(); await flush();
    expect(delivered).toEqual([request.packet.id]);
});

test('stop and restart fence an older in-flight read before delivery', async () => {
    const value = envelope(); storage.set(key('request', value.packet.id), value);
    let release!: (value: any) => void;
    (globalThis as any).GM.getValue = () => new Promise(resolve => { release = resolve; });
    const mailbox = start(); await flush(); expect(typeof release).toBe('function');
    mailbox.stop(); storage.clear();
    (globalThis as any).GM.getValue = async (name: string) => storage.get(name);
    mailbox.start(); release(value); await flush();
    expect(delivered).toEqual([]);
});

test('a write completing after its storage timeout is removed after cancellation', async () => {
    const value = envelope(); let finish!: () => void;
    (globalThis as any).GM.setValue = (name: string, item: any) => new Promise<void>(resolve => {
        finish = () => { storage.set(name, item); resolve(); };
    });
    let stop!: () => void;
    stop = mailboxRequest(value, () => {}, error => { errors.push(error.message); stop(); }); stops.push(stop);
    await flush(); await advance(5001);
    expect(errors).toHaveLength(1); finish(); await flush();
    expect(storage.has(key('request', value.packet.id))).toBe(false);
});

test('undeletable requests cannot prevent a later batch from being served', async () => {
    for (let i = 0; i < 160; i++) { const value = envelope(); storage.set(key('request', value.packet.id), value); }
    (globalThis as any).GM.deleteValue = async () => { throw new Error('Cleanup unavailable'); };
    start(); await flush(); await advance(150);
    expect(new Set(delivered).size).toBe(160);
});

test('a failed record read does not permanently block later requests', async () => {
    const first = envelope(), second = envelope();
    const names = [first, second].map(value => { const name = key('request', value.packet.id); storage.set(name, value); return name; }).sort();
    (globalThis as any).GM.getValue = async (name: string) => { if (name === names[0]) throw new Error('Unreadable record'); return storage.get(name); };
    start(); await flush(); await advance(150);
    expect(delivered).toContain(storage.get(names[1])?.packet.id ?? names[1].split(':').at(-1));
});

test('expiry removes abandoned hosts without touching live routes or other scripts', async () => {
    const owner = crypto.randomUUID(), expired = envelope(now - 1, owner), live = envelope(now + 1000, owner);
    storage.set(key('request', expired.packet.id, owner), expired);
    storage.set(key('reply', live.packet.id, owner), live);
    storage.set('keewebx-userscript-connect-identity-v1', 'identity');
    storage.set('other-script-record', 'untouched');
    start(); await flush();
    expect(storage.has(key('request', expired.packet.id, owner))).toBe(false);
    expect(storage.has(key('reply', live.packet.id, owner))).toBe(true);
    expect(storage.get('keewebx-userscript-connect-identity-v1')).toBe('identity');
    expect(storage.get('other-script-record')).toBe('untouched');
    await advance(1100);
    expect(storage.has(key('reply', live.packet.id, owner))).toBe(false);
});

test('a late reply write after stop is removed even when its timeout already fired', async () => {
    const value = envelope(); storage.set(key('request', value.packet.id), value);
    let finish!: () => void;
    (globalThis as any).GM.setValue = (name: string, item: any) => new Promise<void>(resolve => {
        finish = () => { storage.set(name, item); resolve(); };
    });
    const mailbox = start(async (value, reply) => reply({ ...value, packet: { ...value.packet, type: 'reply' } }));
    await flush(); expect(typeof finish).toBe('function');
    mailbox.stop(); await advance(5001); finish(); await flush();
    expect(storage.has(key('reply', value.packet.id))).toBe(false);
    expect(errors).toEqual([]);
});

test('direct-port receivers do not keep polling idle extension storage', async () => {
    let reads = 0;
    (globalThis as any).GM.listValues = async () => { reads++; return [...storage.keys()]; };
    const mailbox = new ConnectMailbox(host, async () => {}, error => errors.push(error.message));
    stops.push(() => mailbox.stop()); mailbox.start(false); await flush();
    expect(reads).toBe(1); expect(timers.size).toBe(0);
    await advance(10000); expect(reads).toBe(1); expect(timers.size).toBe(0);
});
test('event-driven compatibility work drains once and returns to idle', async () => {
    const events = new Map<string, () => void>();
    (globalThis as any).addEventListener = (name: string, listener: () => void) => events.set(name, listener);
    let reads = 0;
    (globalThis as any).GM.listValues = async () => { reads++; return [...storage.keys()]; };
    const mailbox = new ConnectMailbox(host, async value => { delivered.push(value.packet.id); }, error => errors.push(error.message));
    stops.push(() => mailbox.stop()); mailbox.start(false); await flush();
    const value = envelope(); storage.set(key('request', value.packet.id), value);
    events.get('focus')!(); await flush(); await advance(150);
    expect(delivered).toEqual([value.packet.id]); expect(timers.size).toBe(0);
    const before = reads; await advance(10000); expect(reads).toBe(before);
});
test('unavailable idle storage does not start a permanent background retry loop', async () => {
    let reads = 0;
    (globalThis as any).GM.listValues = () => { reads++; return new Promise(() => {}); };
    const mailbox = new ConnectMailbox(host, async () => {}, error => errors.push(error.message));
    stops.push(() => mailbox.stop()); mailbox.start(false); await flush();
    await advance(10000);
    expect(errors).toHaveLength(1); expect(reads).toBe(1); expect(timers.size).toBe(0);
});
