import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { AppPortReceiver, PORT_MARK } from '../src/direct-ports';

const endpoint = new URL('https://keewebx.app/app');
const workerURL = new URL('connect-port/worker.js', endpoint).href;
const workerSource = readFileSync(new URL('../../../ui/connect-port/worker.js', import.meta.url), 'utf8');
const original = new Map<string, PropertyDescriptor | undefined>();
const realSetTimeout = setTimeout, realClearTimeout = clearTimeout;
let cleanup: (() => void)[] = [];

function replace(name: string, value: unknown) {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

afterEach(() => {
    for (const close of cleanup.reverse()) close();
    cleanup = [];
    for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as any)[name];
    }
    original.clear();
});

class ObservedPort {
    closed = false;
    messages: any[] = [];
    onmessage: unknown = null;
    onmessageerror: unknown = null;
    postMessage(value: unknown) { if (!this.closed) this.messages.push(structuredClone(value)); }
    start() {}
    close() { this.closed = true; }
}

function fixture(order: string[]) {
    const selected = crypto.randomUUID(), old = crypto.randomUUID();
    const listeners = new Set<(event: MessageEvent) => void>();
    const intervals = new Map<number, () => void>(), timers = new Map<number, () => void>();
    const receivers = new Map<string, AppPortReceiver>(), logs: string[] = [];
    let nextTimer = 0, requests = 0;
    const container = {
        addEventListener(_name: string, listener: (event: MessageEvent) => void) { listeners.add(listener); },
        removeEventListener(_name: string, listener: (event: MessageEvent) => void) { listeners.delete(listener); },
        startMessages() {}
    };
    replace('navigator', { serviceWorker: container });
    replace('setInterval', (callback: () => void) => { const id = ++nextTimer; intervals.set(id, callback); return id; });
    replace('clearInterval', (id: number) => intervals.delete(id));
    replace('setTimeout', (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; });
    replace('clearTimeout', (id: number) => timers.delete(id));
    for (const name of order) {
        const receiver = new AppPortReceiver(endpoint, () => ({ host: name === 'selected' ? selected : old, active: name === 'selected' }),
            async (_value, reply) => { requests++; reply({ ok: true }); }, () => {}, value => logs.push(name + ': ' + value));
        receivers.set(name, receiver);
        cleanup.push(() => receiver.dispose());
    }
    function dispatch(data: Record<string, unknown>, port: unknown) {
        const event = { data: { marker: PORT_MARK, endpoint: endpoint.href, appBoot: selected, ...data },
            ports: [port], source: { scriptURL: workerURL }, isTrusted: true } as unknown as MessageEvent;
        for (const listener of [...listeners]) listener(event);
    }
    const client = {
        id: 'original-app',
        postMessage(data: Record<string, unknown>, ports: any[]) {
            const transferred = structuredClone(ports, { transfer: ports });
            cleanup.push(() => transferred.forEach((port: any) => port.close()));
            dispatch(data, transferred[0]);
        }
    };
    function probe(appBoot = selected, requestedEndpoint = endpoint.href): Promise<{ state: string }> {
        const actual = runInNewContext(workerSource + '\nprobe;', {
            URL, TextEncoder, MessageChannel, Date, crypto, setTimeout: realSetTimeout, clearTimeout: realClearTimeout,
            self: { location: new URL(workerURL), addEventListener() {} }
        });
        return actual(client, appBoot, requestedEndpoint, 1000).result;
    }
    return { selected, old, listeners, intervals, timers, receivers, logs, dispatch, client, probe, requests: () => requests };
}

test.each([['old', 'selected'], ['selected', 'old']])('only the selected receiver replies to discovery (%s then %s)', async (first, second) => {
    const f = fixture([first, second]);
    expect((await f.probe()).state).toBe('ready');
    expect(f.logs.filter(value => value.includes('Discovery reply posted'))).toHaveLength(1);
});

test.each([['old', 'selected'], ['selected', 'old']])('a stale receiver cannot close the selected return port (%s then %s)', async (first, second) => {
    const f = fixture([first, second]), channel = new MessageChannel(), kinds: string[] = [];
    cleanup.push(() => { channel.port1.close(); channel.port2.close(); });
    const connectionId = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout>;
    const replied = new Promise<void>(resolve => {
        timer = realSetTimeout(resolve, 250);
        channel.port1.onmessage = event => {
            kinds.push(event.data.kind);
            if (event.data.kind === 'ready') channel.port1.postMessage({ marker: PORT_MARK, kind: 'request', connectionId, value: { operation: 'probe' } });
            if (event.data.kind === 'reply') resolve();
        };
    });
    f.client.postMessage({ kind: 'attach-port', connectionId, siteOrigin: 'https://login.example.org' }, [channel.port2]);
    await replied; realClearTimeout(timer!);
    expect(kinds).toEqual(['ready', 'reply']);
    expect(f.requests()).toBe(1);
});

test('unknown boot discovery preserves one stale App reply', async () => {
    const f = fixture(['old', 'selected']);
    expect((await f.probe(crypto.randomUUID())).state).toBe('refreshed');
    expect(f.logs.filter(value => value.includes('Discovery reply posted'))).toHaveLength(1);
});

test('an attachment addressed to an unknown boot leaves the shared port untouched', () => {
    const f = fixture(['old', 'selected']), port = new ObservedPort();
    f.dispatch({ kind: 'attach-port', appBoot: crypto.randomUUID(), connectionId: crypto.randomUUID(), siteOrigin: 'https://login.example.org' }, port);
    expect(port.closed).toBe(false);
    expect(port.messages).toEqual([]);
    expect(port.onmessage).toBeNull();
});

test('a known boot reports its own address mismatch once', async () => {
    const f = fixture(['old', 'selected']);
    expect((await f.probe(f.selected, endpoint.href + '?configuration=other')).state).toBe('address-mismatch');
    expect(f.logs.filter(value => value.includes('Discovery reply posted'))).toHaveLength(1);
});

test('dispose removes only its receiver and the last receiver releases the dispatcher and timers', async () => {
    const f = fixture(['old', 'selected']);
    expect(f.listeners.size).toBe(1);
    f.receivers.get('old')!.dispose();
    expect(f.listeners.size).toBe(1);
    expect(f.intervals.size).toBe(1);
    expect((await f.probe()).state).toBe('ready');
    const port = new ObservedPort();
    f.dispatch({ kind: 'find-app' }, port);
    expect(f.timers.size).toBeGreaterThan(0);
    f.receivers.get('selected')!.dispose();
    expect(port.closed).toBe(true);
    expect(f.listeners.size).toBe(0);
    expect(f.intervals.size).toBe(0);
    expect(f.timers.size).toBe(0);
});
