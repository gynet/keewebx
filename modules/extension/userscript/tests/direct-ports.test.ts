import { afterEach, beforeEach, expect, test } from 'bun:test';
import { AppPortReceiver } from '../src/direct-ports';
import { CONNECT_VERSION } from '../src/version';
import { watchTransport } from '../src/transport-events';

const marker = 'keewebx-connect-port-v1';
const endpoint = new URL('https://keewebx.app/app');
const workerURL = new URL('connect-port/worker.js', endpoint).href;
const siteOrigin = 'https://login.example.org';
const original = new Map<string, PropertyDescriptor | undefined>();

class FakeMessagePort {
    messages: any[] = [];
    onmessage: ((event: { data: any }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    started = false;
    closed = false;
    postMessage(value: unknown) { this.messages.push(structuredClone(value)); }
    start() { this.started = true; }
    close() { this.closed = true; }
    dispatch(data: unknown) { this.onmessage?.({ data }); }
}

let listener: (event: MessageEvent) => void;
let receiver: AppPortReceiver;
let state: { host: string; active: boolean };
let requests: { value: unknown; reply: (value: unknown) => void; origin: string; id: string }[];
let released: string[];
let ports: FakeMessagePort[];
let admit: () => boolean;

function replace(name: string, value: unknown) {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function receive(data: Record<string, unknown>, source: { scriptURL: string; postMessage?(value: unknown): void } = { scriptURL: workerURL }, isTrusted = false) {
    const port = new FakeMessagePort(); ports.push(port);
    listener({ data: { marker, endpoint: endpoint.href, appBoot: state.host, ...data },
        source, isTrusted, ports: [port] } as unknown as MessageEvent);
    return port;
}

beforeEach(() => {
    state = { host: crypto.randomUUID(), active: true };
    requests = []; released = []; ports = [];
    admit = () => state.active;
    replace('navigator', { serviceWorker: {
        addEventListener(type: string, callback: (event: MessageEvent) => void) {
            expect(type).toBe('message'); listener = callback;
        },
        removeEventListener() {},
        startMessages() {}
    } });
    replace('setInterval', () => 0);
    replace('setTimeout', () => 0);
    replace('clearTimeout', () => {});
    replace('localStorage', { getItem() { throw new Error('Discovery must not read storage'); } });
    receiver = new AppPortReceiver(endpoint, () => ({ ...state }), async (value, reply, origin, id) => {
        requests.push({ value, reply, origin, id });
    }, id => released.push(id), () => {}, () => admit());
});

afterEach(() => {
    try {
        receiver?.dispose();
        for (const port of ports) port.close();
    } finally {
        for (const [name, descriptor] of original) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete (globalThis as any)[name];
        }
        original.clear();
    }
});

test('a queued expired handoff is rejected before opening an App peer', () => {
    const connectionId = crypto.randomUUID();
    const port = receive({ kind: 'attach-port', connectionId, siteOrigin,
        handoffDeadline: Date.now() - 1 });
    expect(port.closed).toBe(true);
    expect(port.messages).toHaveLength(1);
    expect(port.messages[0]).toMatchObject({ marker, kind: 'error', code: 'expired' });
    expect(port.onmessage).toBeNull();
    expect(requests).toEqual([]);
});

test.each([NaN, Infinity, 'later', null])('an invalid handoff deadline cannot create a peer (%s)', handoffDeadline => {
    const port = receive({ kind: 'attach-port', connectionId: crypto.randomUUID(), siteOrigin, handoffDeadline });
    expect(port.closed).toBe(true); expect(requests).toEqual([]);
});

test.each([false, true])('setup slots expire unless the authenticated handler replies (reply=%s)', replied => {
    const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
    const timers = new Map<number, () => void>();
    (globalThis as any).setTimeout = (callback: () => void) => { timers.set(1, callback); return 1; };
    (globalThis as any).clearTimeout = (id: number) => timers.delete(id);
    try {
        const connectionId = crypto.randomUUID();
        const port = receive({ kind: 'attach-port', connectionId, siteOrigin, handoffDeadline: Date.now() + 20000 });
        expect(port.closed).toBe(false); expect(timers.size).toBe(1);
        if (replied) {
            port.dispatch({ marker, kind: 'request', connectionId, value: { signedFixture: true } });
            requests[0].reply({ signedFixtureReply: true });
            expect(timers.size).toBe(0); expect(port.closed).toBe(false);
        } else {
            timers.get(1)!();
            expect(port.closed).toBe(true); expect(released).toContain(connectionId);
        }
    } finally { globalThis.setTimeout = schedule; globalThis.clearTimeout = cancel; }
});

test('exact-worker discovery answers an untrusted event without invoking the request handler', () => {
    admit = () => { throw new Error('Discovery must not check the selection lease'); };
    const port = receive({ kind: 'find-app' });
    expect(port.messages).toHaveLength(1);
    expect(port.messages[0]).toMatchObject({ marker, kind: 'app-ready', appBoot: state.host,
        endpoint: endpoint.href, state: 'enabled' });
    expect(requests).toHaveLength(0);
    expect(released).toEqual([]);
});

test('a different worker source cannot discover or attach a port', () => {
    for (const scriptURL of ['https://attacker.example/connect-port/worker.js', 'https://keewebx.app/other-worker.js']) {
        for (const kind of ['find-app', 'attach-port']) {
            const port = receive({ kind, connectionId: crypto.randomUUID(), siteOrigin }, { scriptURL }, true);
            expect(port.messages).toEqual([]);
            expect(port.onmessage).toBeNull();
        }
    }
    expect(requests).toHaveLength(0);
    expect(released).toEqual([]);
});

test('discovery reports a same-origin address mismatch and echoes the requested endpoint', () => {
    const requested = 'https://keewebx.app/app?configuration=other';
    const port = receive({ kind: 'find-app', endpoint: requested }, { scriptURL: workerURL }, true);
    expect(port.messages).toHaveLength(1);
    expect(port.messages[0]).toMatchObject({ marker, kind: 'app-state', appBoot: state.host,
        endpoint: requested, state: 'address-mismatch' });
    expect(requests).toHaveLength(0);
    expect(released).toEqual([]);
});

test('a worker requesting the alternate discovery reply receives only the same public status', () => {
    const replies: unknown[] = [], traceId = crypto.randomUUID();
    const source = { scriptURL: workerURL, postMessage: (data: unknown) => replies.push(data) };
    const port = receive({ kind: 'find-app', traceId, replyViaWorker: true }, source, true);
    receive({ kind: 'find-app', traceId }, source, true);
    expect(replies).toEqual([port.messages[0]]);
    expect(replies[0]).toEqual({ marker, kind: 'app-ready', appBoot: state.host,
        endpoint: endpoint.href, state: 'enabled', receiverVersion: CONNECT_VERSION, traceId });
    expect(requests).toEqual([]);
});

test('discovery echoes a valid trace and records only bounded ownership metadata', () => {
    const traceId = crypto.randomUUID(), events: any[] = [];
    const unwatch = watchTransport(data => events.push(data));
    try {
        const port = receive({ kind: 'find-app', traceId, privateValue: 'Do not record this value' });
        expect(port.messages[0].traceId).toBe(traceId);
        expect(events).toContainEqual({ event: 'discovery-received', traceId, portId: undefined, detail: undefined, runtimeCount: 1 });
        expect(events).toContainEqual({ event: 'discovery-sent', traceId, portId: undefined, detail: 'matched', runtimeCount: 1 });
        expect(JSON.stringify(events)).not.toContain(endpoint.href);
        expect(JSON.stringify(events)).not.toContain('Do not record this value');
        expect(receive({ kind: 'find-app', traceId: 'invalid' }).messages[0].traceId).toBeUndefined();
    } finally { unwatch(); }
});

test('an inactive grant denies attachment without invoking the request handler', () => {
    state.active = false;
    const port = receive({ kind: 'attach-port', connectionId: crypto.randomUUID(), siteOrigin }, { scriptURL: workerURL }, true);
    expect(port.closed).toBe(true);
    expect(port.messages).toEqual([{ marker, kind: 'error', code: 'disabled',
        message: 'Connect is disabled in this KeeWebX App. Unlock it and authorize Connect, then retry.' }]);
    expect(port.messages.some(message => message.kind === 'ready')).toBe(false);
    expect(port.onmessage).toBeNull();
    expect(requests).toHaveLength(0);
    expect(released).toEqual([]);
});

test('an active discovery snapshot cannot bypass selection-lease admission during attachment', () => {
    admit = () => false;
    const port = receive({ kind: 'attach-port', connectionId: crypto.randomUUID(), siteOrigin });
    expect(port.closed).toBe(true);
    expect(port.messages).toHaveLength(1);
    expect(port.messages[0]).toMatchObject({ marker, kind: 'error', code: 'inactive' });
    expect(port.onmessage).toBeNull();
    expect(requests).toHaveLength(0);
    expect(released).toEqual([]);
});

test('address-mismatch discovery support does not permit a mismatched attachment', () => {
    admit = () => { throw new Error('Mismatched attachments must be rejected before admission'); };
    const port = receive({ kind: 'attach-port', endpoint: 'https://keewebx.app/app?configuration=other',
        connectionId: crypto.randomUUID(), siteOrigin });
    expect(port.closed).toBe(true);
    expect(port.messages.some(message => message.kind === 'ready')).toBe(false);
    expect(port.onmessage).toBeNull();
    expect(requests).toHaveLength(0);
    expect(released).toEqual([]);
});

test('an active attachment pins handler origin and physical connection id to the attached port', async () => {
    const connectionId = crypto.randomUUID();
    const port = receive({ kind: 'attach-port', connectionId, siteOrigin }, { scriptURL: workerURL }, true);
    expect(port.started).toBe(true);
    expect(port.messages).toEqual([{ marker, kind: 'ready', connectionId, appBoot: state.host,
        endpoint: endpoint.href, siteOrigin }]);
    expect(requests).toHaveLength(0);

    port.dispatch({ marker, kind: 'request', connectionId: crypto.randomUUID(), value: { operation: 'probe' } });
    expect(requests).toHaveLength(0);

    const value = { operation: 'probe', origin: 'https://attacker.example', connectionId: crypto.randomUUID() };
    port.dispatch({ marker, kind: 'request', connectionId, siteOrigin: value.origin, value });
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    expect(requests[0].value).toEqual(value);
    expect(requests[0].origin).toBe(siteOrigin);
    expect(requests[0].id).toBe(connectionId);

    requests[0].reply({ result: 'synthetic' });
    expect(port.messages.at(-1)).toEqual({ marker, kind: 'reply', connectionId, appBoot: state.host,
        endpoint: endpoint.href, siteOrigin, value: { result: 'synthetic' } });
});
