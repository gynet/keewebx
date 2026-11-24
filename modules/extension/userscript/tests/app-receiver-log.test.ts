import { afterEach, expect, test } from 'bun:test';
import { appLogRecording, mainReceiverLines, readMainReceiverLog } from '../src/app-receiver-log';

const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(key: string, value: unknown) {
    if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
}
afterEach(() => {
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    originals.clear();
});
const record = () => ({ at: 1_795_500_000_000, event: 'main-discovery', visible: false, traceId: crypto.randomUUID(), dataReadMs: 0.25 });

test('App observer export includes only bounded public metadata', () => {
    const safe = record();
    const lines = mainReceiverLines([{ ...safe, password: 'secret-value', website: 'https://private.example', payload: { secret: true } }]);
    expect(lines).toHaveLength(1); expect(lines[0]).toContain(safe.traceId);
    expect(lines[0]).not.toContain('secret'); expect(lines[0]).not.toContain('private');
    expect(mainReceiverLines(Array.from({ length: 101 }, record))).toEqual([]);
    expect(mainReceiverLines([{ ...safe, event: 'secret-value' }, { ...safe, at: NaN }, { ...safe, visible: 'yes' }])).toEqual([]);
});
test('observer export does not invoke getters or serialize malformed identifiers', () => {
    let calls = 0;
    const item = { ...record(), traceId: 'private-origin', portId: 'password', get password() { calls++; throw Error(); } };
    expect(mainReceiverLines([item]).join('')).not.toMatch(/password|private-origin/);
    expect(calls).toBe(0);
    expect(mainReceiverLines([new Proxy({}, { getOwnPropertyDescriptor() { throw Error(); } })])).toEqual([]);
});

function fixture() {
    const attributes = new Map<string, string>(), listeners = new Set<(event: any) => void>(), posts: any[] = [];
    let expire: (() => void) | undefined;
    const window = {
        addEventListener(_type: string, listener: (event: any) => void) { listeners.add(listener); },
        removeEventListener(_type: string, listener: (event: any) => void) { listeners.delete(listener); },
        postMessage(data: unknown, origin: string) { posts.push({ data, origin }); }
    };
    replace('window', window); replace('location', { origin: 'https://keewebx.app' });
    replace('document', { documentElement: { getAttribute: (key: string) => attributes.get(key),
        setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key) } });
    replace('setTimeout', (callback: () => void) => { expire = callback; return 1; });
    replace('clearTimeout', () => { expire = undefined; });
    return { posts, listeners, expire: () => expire?.(), reply(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
        for (const listener of listeners) listener({ isTrusted: true, source: window, origin: 'https://keewebx.app', ports: [],
            data: { marker: 'keewebx-connect-observer-v1', kind: 'snapshot-reply', nonce: posts.at(-1)?.data.nonce, records: [record()], ...data }, ...overrides });
    } };
}
test('disabled recording makes no snapshot request; enabled export binds source, origin and nonce', async () => {
    const f = fixture();
    expect(await readMainReceiverLog()).toEqual([]); expect(f.posts).toEqual([]);
    appLogRecording(true);
    const reading = readMainReceiverLog();
    expect(f.posts).toHaveLength(1); expect(f.posts[0].origin).toBe('https://keewebx.app');
    for (const event of [{ isTrusted: false }, { source: {} }, { origin: 'https://login.example.org' }, { ports: [{}] }]) f.reply(event);
    f.reply({}, { nonce: crypto.randomUUID() });
    expect(f.listeners.size).toBe(1);
    f.reply(); expect(await reading).toHaveLength(1); expect(f.listeners.size).toBe(0);
    appLogRecording(false); expect(await readMainReceiverLog()).toEqual([]); expect(f.posts).toHaveLength(1);
});
test('a missing old App observer cannot strand log copying or leave a listener', async () => {
    const f = fixture(); appLogRecording(true);
    const reading = readMainReceiverLog(); f.expire();
    expect(await reading).toEqual([]); expect(f.listeners.size).toBe(0);
});
