import { afterEach, expect, test } from 'bun:test';
import { startConnectReceiverObserver, type ConnectReceiverRecord } from '../src/connect-receiver-observer';

const ID = '12345678-1234-4234-8234-123456789abc';
const MARK = 'keewebx-connect-observer-v1';
const PORT = 'keewebx-connect-port-v1';
const ATTRIBUTE = 'data-kwx-connect-local-log';
const original = new Map(['window', 'document', 'navigator', 'MutationObserver', 'performance'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let stop: (() => void) | undefined;
afterEach(() => {
    stop?.(); stop = undefined;
    for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

class Target {
    listeners = new Map<string, Set<(event: any) => void>>();
    addEventListener(type: string, listener: (event: any) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(listener);
    }
    removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
    emit(type: string, event: object = {}) { for (const fn of this.listeners.get(type) ?? []) fn({ type, ...event }); }
}

function fixture(initial: string | null = 'true') {
    let attribute = initial, mutation!: (changes: { oldValue: string | null }[]) => void, options: unknown;
    let clock = 10, disconnected = false;
    const replies: { value: { records: ConnectReceiverRecord[]; [key: string]: unknown }; origin: string }[] = [];
    const worker = Object.assign(new Target(), {
        startMessages() { throw new Error('Observer must not start the queue'); }
    });
    const window = Object.assign(new Target(), {
        location: { origin: 'https://keewebx.app', protocol: 'https:' },
        postMessage(value: any, origin: string) { replies.push({ value, origin }); }
    });
    const document = Object.assign(new Target(), {
        hidden: false, baseURI: 'https://keewebx.app/app',
        documentElement: { getAttribute: (name: string) => { expect(name).toBe(ATTRIBUTE); return attribute; } }
    });
    class Observer {
        constructor(callback: typeof mutation) { mutation = callback; }
        observe(_root: unknown, value: unknown) { options = value; }
        disconnect() { disconnected = true; }
    }
    for (const [key, value] of Object.entries({ window, document, navigator: { serviceWorker: worker },
        MutationObserver: Observer, performance: { now: () => clock } })) {
        Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    stop = startConnectReceiverObserver();
    const sw = (data: unknown = { marker: PORT, kind: 'find-app', traceId: ID }, overrides: object = {}) => {
        const event = { isTrusted: true, source: { scriptURL: 'https://keewebx.app/connect-port/worker.js' },
            get data() { clock += 7; return data; },
            get ports(): never { throw new Error('SW ports were touched'); } };
        Object.defineProperties(event, Object.getOwnPropertyDescriptors(overrides));
        // Invoke the registered callback directly: native trusted events cannot be synthesized.
        for (const fn of worker.listeners.get('message') ?? []) fn(event);
    };
    const request = (data: unknown = { marker: MARK, kind: 'snapshot', nonce: ID }, overrides: object = {}) =>
        window.emit('message', { isTrusted: true, source: window, origin: window.location.origin, ports: [], data, ...overrides });
    const snapshot = () => { request(); return replies.at(-1)!.value.records; };
    return { worker, window, document, replies, sw, request, snapshot, options: () => options,
        disconnected: () => disconnected,
        set(value: string | null, flush = true) { const oldValue = attribute; attribute = value; if (flush) mutation([{ oldValue }]); return oldValue; },
        flush: mutation };
}

test('installs while disabled, observes only the opt-in attribute and clears on disable', () => {
    const f = fixture(null);
    expect(f.worker.listeners.get('message')?.size).toBe(1);
    expect(f.options()).toEqual({ attributes: true, attributeFilter: [ATTRIBUTE], attributeOldValue: true });
    let reads = 0;
    f.sw(undefined, { get data() { reads++; throw new Error('Disabled read'); } });
    f.request(); expect(reads).toBe(0); expect(f.replies).toHaveLength(0);
    f.set('TRUE'); f.request(); expect(f.replies).toHaveLength(0);
    f.set('true'); f.sw(); expect(f.snapshot().map(row => row.event)).toEqual(['main-enabled', 'main-discovery']);
    f.set('false', false); f.request(); expect(f.replies).toHaveLength(1);
    f.set('true'); expect(f.snapshot().map(row => row.event)).toEqual(['main-enabled']);
});

test('passive discovery and handoff record entry before data access, never touch SW ports or payloads', () => {
    const f = fixture();
    let readAt = 0, portReads = 0, payloadReads = 0;
    const data = { marker: PORT, kind: 'find-app', traceId: ID,
        get payload() { payloadReads++; throw new Error('Payload read'); } };
    f.sw(undefined, { get data() { readAt = Date.now(); return data; }, get ports() { portReads++; throw new Error('Port read'); } });
    f.sw({ marker: PORT, kind: 'attach-port', connectionId: ID, ignored: 'secret'.repeat(100000) });
    const rows = f.snapshot();
    expect(rows[1].at).toBeLessThanOrEqual(readAt);
    expect(rows[1]).toEqual({ at: rows[1].at, event: 'main-discovery', visible: true, traceId: ID, dataReadMs: 0 });
    expect(rows[2]).toEqual({ at: rows[2].at, event: 'main-handoff', visible: true, portId: ID, dataReadMs: 7 });
    expect(portReads).toBe(0); expect(payloadReads).toBe(0);
    expect(f.replies[0].origin).toBe('https://keewebx.app');
    expect(Object.keys(f.replies[0].value)).toEqual(['marker', 'kind', 'nonce', 'records']);
});

test('rejects untrusted and foreign or inexact workers before reading data', () => {
    const f = fixture(); let reads = 0;
    for (const overrides of [{ isTrusted: false }, { source: null },
        ...['https://evil.test/connect-port/worker.js', 'https://keewebx.app/service-worker.js',
            'https://keewebx.app/connect-port/worker.js?x=1'].map(scriptURL => ({ source: { scriptURL } }))]) {
        f.sw(undefined, { ...overrides, get data() { reads++; return {}; } });
    }
    expect(reads).toBe(0); expect(f.snapshot()).toHaveLength(1);
});

test('rejects malformed public metadata, accessors and oversized identifiers', () => {
    const f = fixture(); let reads = 0;
    for (const data of [null, [], 'x'.repeat(100000), {}, { marker: PORT, kind: 'reply', traceId: ID },
        { marker: PORT, kind: 'find-app' }, { marker: PORT, kind: 'attach-port', traceId: ID },
        { marker: PORT, kind: 'find-app', traceId: 'a'.repeat(100000) },
        { marker: PORT, kind: 'find-app', traceId: ID, connectionId: 'bad' },
        { marker: PORT, kind: 'find-app', get traceId() { reads++; return ID; } }]) f.sw(data);
    expect(reads).toBe(0); expect(f.snapshot()).toHaveLength(1);
});

test('snapshot requires trusted same-window same-origin exact three-field request without ports', () => {
    const f = fixture();
    for (const overrides of [{ isTrusted: false }, { source: {} }, { origin: 'https://evil.test' }, { ports: [{}] }]) f.request(undefined, overrides);
    for (const data of [{ marker: MARK, kind: 'snapshot', nonce: ID, extra: true },
        { marker: MARK, kind: 'snapshot', nonce: 'a'.repeat(100000) },
        { marker: MARK, kind: 'snapshot-reply', nonce: ID }, null, [],
        { marker: MARK, kind: 'snapshot', get nonce() { throw new Error('Accessor read'); } }]) f.request(data);
    expect(f.replies).toHaveLength(0);
    f.request(); expect(f.replies[0].value.nonce).toBe(ID);
    f.replies[0].value.records[0].event = 'main-hidden';
    expect(f.snapshot()[0].event).toBe('main-enabled');
});

test('ring is bounded, trusted lifecycle is sanitized and batched disable clears memory', () => {
    const f = fixture();
    f.window.emit('pagehide', { isTrusted: false, persisted: true });
    expect(f.snapshot()).toHaveLength(1);
    f.document.hidden = true;
    f.document.emit('visibilitychange', { isTrusted: true });
    f.window.emit('pagehide', { isTrusted: true, persisted: true });
    f.window.emit('pageshow', { isTrusted: true, persisted: false });
    f.document.hidden = false; f.document.emit('visibilitychange', { isTrusted: true });
    expect(f.snapshot().slice(1).map(row => [row.event, row.visible, row.persisted])).toEqual([
        ['main-hidden', false, undefined], ['main-page-hide', false, true],
        ['main-page-show', false, false], ['main-visible', true, undefined]
    ]);
    for (let i = 0; i < 150; i++) f.sw();
    expect(f.snapshot()).toHaveLength(100);
    expect(f.snapshot().every(row => row.event === 'main-discovery')).toBe(true);
    const first = f.set('false', false), second = f.set('true', false);
    f.flush([{ oldValue: first }, { oldValue: second }]);
    expect(f.snapshot().map(row => row.event)).toEqual(['main-enabled']);
    stop!(); stop = undefined;
    expect(f.disconnected()).toBe(true);
    expect(f.worker.listeners.get('message')?.size).toBe(0);
});

test('correlates delayed discovery with its original worker send time and website connection', () => {
    const f = fixture(), sentAt = Date.now() - 32000;
    f.sw({ marker: PORT, kind: 'find-app', traceId: ID, connectionId: ID, sentAt });
    const received = f.snapshot()[1];
    expect(received.sentAt).toBe(sentAt);
    expect(received.at - received.sentAt!).toBeGreaterThanOrEqual(32000);
    expect(received.traceId).toBe(ID); expect(received.portId).toBe(ID);
    for (const value of [NaN, Infinity, -1, 8.64e15 + 1, 'private-value']) {
        f.sw({ marker: PORT, kind: 'find-app', traceId: ID, sentAt: value });
        expect(f.snapshot().at(-1)?.sentAt).toBeUndefined();
    }
    let reads = 0;
    f.sw({ marker: PORT, kind: 'find-app', traceId: ID, get sentAt() { reads++; return 1; } });
    expect(reads).toBe(0); expect(f.snapshot().at(-1)?.sentAt).toBeUndefined();
});
