import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { CONNECT_VERSION } from '../src/version';

const source = readFileSync(new URL('../../../ui/connect-port/worker.js', import.meta.url), 'utf8');
const marker = 'keewebx-connect-port-v1';
const endpoint = 'https://keewebx.app/app';
const receiverEndpoint = 'https://keewebx.app/app?configuration=other';

class FakePort {
    peer?: FakePort;
    onmessage: ((event: { data: any; ports: FakePort[] }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    messages: any[] = [];
    closed = false;
    start() {}
    close() { this.closed = true; }
    postMessage(value: unknown) {
        const data = structuredClone(value); this.messages.push(data);
        const peer = this.peer;
        if (peer) queueMicrotask(() => { if (!peer.closed) peer.onmessage?.({ data, ports: [] }); });
    }
}

class FakeWindowClient {
    id = crypto.randomUUID();
    posts: { data: any; ports: FakePort[] }[] = [];
    onPost?: (data: any, ports: FakePort[]) => void;
    constructor(public url: string, readonly frameType = 'top-level') {}
    postMessage(data: any, ports: FakePort[] = []) {
        this.posts.push({ data: structuredClone(data), ports });
        this.onPost?.(data, ports);
    }
}

function fixture(withSilentApp = false, options: { base?: string; endpoint?: string; appURL?: string; missingRelayLookup?: number } = {}) {
    const base = options.base ?? 'https://keewebx.app/';
    const data = { marker, kind: 'attach', nonce: crypto.randomUUID(), appBoot: crypto.randomUUID(),
        connectionId: crypto.randomUUID(), endpoint: options.endpoint ?? endpoint, siteOrigin: 'https://login.example.org' };
    const relayURL = new URL('connect-port/relay.html', base);
    relayURL.searchParams.set('site', data.siteOrigin);
    relayURL.searchParams.set('nonce', data.nonce);
    relayURL.searchParams.set('endpoint', data.endpoint);
    const relay = new FakeWindowClient(relayURL.href, 'auxiliary');
    const app = new FakeWindowClient(options.appURL ?? receiverEndpoint);
    const clients = new Map([[relay.id, relay], [app.id, app]]);
    const silent = new FakeWindowClient('https://keewebx.app/app');
    if (withSilentApp) clients.set(silent.id, silent);
    const website = new FakePort();
    const timers = new Map<number, { callback: () => void; due: number }>();
    const channels: { port1: FakePort; port2: FakePort }[] = [];
    const listeners = new Map<string, (event: any) => void>();
    const queries = { get: [] as string[], missingRelay: 0, matchAll: 0, locks: 0 };
    const navigator: { locks?: { query: () => Promise<any> } } = {};
    const browserClients = {
        async get(id: string) {
            queries.get.push(id);
            if (id === relay.id && queries.get.filter(key => key === id).length === options.missingRelayLookup) {
                queries.missingRelay++;
                return undefined;
            }
            return clients.get(id);
        },
        async matchAll() { queries.matchAll++; return [...clients.values()]; }
    };
    let nextTimer = 0, now = Date.now(), settled = false, work: Promise<void> | undefined;

    runInNewContext(source, {
        URL, TextEncoder, crypto, WindowClient: FakeWindowClient,
        MessageChannel: class {
            port1 = new FakePort();
            port2 = new FakePort();
            constructor() {
                this.port1.peer = this.port2; this.port2.peer = this.port1;
                channels.push(this);
            }
        },
        Date: { now: () => now },
        setTimeout(callback: () => void, ms: number) { const id = ++nextTimer; timers.set(id, { callback, due: now + ms }); return id; },
        clearTimeout(id: number) { timers.delete(id); },
        self: {
            location: new URL('connect-port/worker.js', base),
            addEventListener(name: string, listener: (event: any) => void) { listeners.set(name, listener); },
            clients: browserClients, navigator
        }
    }, { filename: 'connect-port/worker.js' });

    listeners.get('message')!({ data, source: relay, ports: [website], waitUntil(promise: Promise<void>) {
        work = promise; void promise.then(() => { settled = true; }, () => { settled = true; });
    } });
    return { data, relay, app, silent, website, timers, channels, clients, queries, browserClients, navigator, time: () => now, settled: () => settled, work: () => work!,
        control(value: unknown, from = app) { listeners.get('message')!({ data: value, source: from, ports: [] }); },
        async tick(ms: number) {
            const until = now + ms;
            for (;;) {
                const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
                if (!next || next[1].due > until) break;
                timers.delete(next[0]); now = next[1].due; next[1].callback(); await flush();
            }
            now = until;
        }
    };
}

// Drain promise/message delivery only. Probe timeout callbacks are never fired.
async function flush() { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); }
function mismatch(request: any, replyEndpoint = request.endpoint) {
    return { marker, kind: 'app-state', appBoot: request.appBoot, endpoint: replyEndpoint,
        state: 'address-mismatch', receiverVersion: CONNECT_VERSION };
}

test('the actual worker reports address mismatch immediately through a valid relay', async () => {
    const f = fixture();
    f.app.onPost = (request, ports) => ports[0].postMessage(mismatch(request));
    await flush();
    expect(f.settled()).toBe(true);
    await f.work();
    expect(f.app.posts).toHaveLength(1);
    expect(f.app.posts[0].data).toMatchObject({ marker, kind: 'find-app', appBoot: f.data.appBoot, endpoint });
    expect(f.website.messages).toHaveLength(1);
    expect(f.website.messages[0]).toMatchObject({ marker, kind: 'error', code: 'address',
        nonce: f.data.nonce, connectionId: f.data.connectionId });
    expect(f.relay.posts).toHaveLength(1);
    expect(f.relay.posts[0].data.code).toBe('address');
    expect(f.website.closed).toBe(true);
    expect(f.timers.size).toBe(0);
    expect(f.channels).toHaveLength(1);
    expect(f.channels[0].port1.closed).toBe(true);
    expect(f.channels[0].port2.closed).toBe(true);
});

test('the worker requires address-mismatch replies to echo the requested endpoint', async () => {
    const f = fixture();
    f.app.onPost = (request, ports) => ports[0].postMessage(mismatch(request, receiverEndpoint));
    await flush();
    expect(f.app.posts).toHaveLength(1);
    expect(f.settled()).toBe(false);
    expect(f.website.messages).toEqual([]);
    expect(f.timers.size).toBe(2);

    const probe = f.app.posts[0];
    probe.ports[0].postMessage(mismatch(probe.data));
    await flush();
    expect(f.settled()).toBe(true);
    await f.work();
    expect(f.website.messages).toHaveLength(1);
    expect(f.website.messages[0].code).toBe('address');
    expect(f.timers.size).toBe(0);
});

test('a selected App hands off immediately without waiting for a silent unrelated tab', async () => {
    const f = fixture(true);
    f.app.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-ready', appBoot: request.appBoot, endpoint: request.endpoint, state: 'enabled' });
    };
    await flush();
    expect(f.settled()).toBe(true);
    await f.work();
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(1);
    expect(f.relay.posts).toEqual([]);
    expect(f.silent.posts.map(post => post.data.kind)).toEqual(['find-app']);
    expect(f.website.messages).toEqual([]);
    expect(f.website.closed).toBe(false);
    expect(f.timers.size).toBe(0);
    expect(f.channels.every(channel => channel.port1.closed && channel.port2.closed)).toBe(true);
});

test('an already closed helper cannot turn a successful port transfer into a failure', async () => {
    const f = fixture();
    f.app.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-ready', appBoot: request.appBoot, endpoint: request.endpoint, state: 'enabled' });
    };
    f.relay.onPost = () => { throw new Error('Helper already closed'); };
    await flush(); await f.work();
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(1);
    expect(f.website.messages).toEqual([]); expect(f.website.closed).toBe(false);
    expect(f.timers.size).toBe(0);
});

test('a lost discovery reply retries on a fresh channel and hands off the website port only once', async () => {
    const f = fixture();
    let probes = 0;
    f.app.onPost = (request, ports) => {
        if (request.kind !== 'find-app' || ++probes === 1) return;
        ports[0].postMessage({ marker, kind: 'app-ready', appBoot: request.appBoot, endpoint, state: 'enabled' });
    };
    await flush();
    expect(f.settled()).toBe(false);
    await f.tick(750);
    expect(f.settled()).toBe(true);
    await f.work();
    expect(probes).toBe(2);
    expect(f.channels).toHaveLength(2);
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(1);
    expect(f.website.messages).toEqual([]);
    expect(f.channels.every(channel => channel.port1.closed && channel.port2.closed)).toBe(true);
    expect(f.timers.size).toBe(0);
});

test.each([10000, 12000])('an App resumed at %i ms reuses the original attachment despite an unrelated refreshed tab', async resumeMs => {
    const f = fixture(true), pending: { request: any; port: FakePort }[] = [];
    f.app.onPost = (request, ports) => {
        if (request.kind === 'find-app') pending.push({ request, port: ports[0] });
    };
    f.silent.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-state', appBoot: f.silent.id, endpoint, state: 'enabled' });
    };
    await flush(); await f.tick(8000);
    expect(f.settled()).toBe(false);
    expect(f.website.messages).toEqual([]); expect(f.website.closed).toBe(false);
    expect(f.queries.matchAll).toBe(2);
    expect(f.queries.get.filter(id => id === f.relay.id)).toHaveLength(2);
    await f.tick(resumeMs - 8000);
    for (const { request, port } of pending) port.postMessage({ marker, kind: 'app-ready',
        appBoot: request.appBoot, endpoint: request.endpoint, state: 'enabled', receiverVersion: CONNECT_VERSION });
    await flush(); await f.work();
    const handoffs = f.app.posts.filter(post => post.data.kind === 'attach-port');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].ports).toEqual([f.website]);
    expect(handoffs[0].data).toMatchObject({ appBoot: f.data.appBoot, connectionId: f.data.connectionId, endpoint });
    expect(f.relay.posts).toEqual([]);
    expect(f.website.messages).toEqual([]); expect(f.website.closed).toBe(false);
    expect(f.channels.every(channel => channel.port1.closed && channel.port2.closed)).toBe(true);
    expect(f.timers.size).toBe(0);
    await f.tick(16000);
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(1);
});

test.each(['disabled', 'address-mismatch'])('selected %s fails immediately even with a silent unrelated tab', async state => {
    const f = fixture(true);
    f.app.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-state', appBoot: request.appBoot, endpoint, state });
    };
    await flush();
    expect(f.settled()).toBe(true); await f.work();
    expect(f.website.messages.at(-1).code).toBe(state === 'disabled' ? 'disabled' : 'address');
    expect(f.queries.matchAll).toBe(1);
    expect(f.app.posts.filter(post => post.data.kind === 'find-app')).toHaveLength(1);
    expect(f.channels.every(channel => channel.port1.closed && channel.port2.closed)).toBe(true);
    expect(f.timers.size).toBe(0);
});

test.each(['closed', 'navigated'])('the helper is revalidated before the recovery round (%s)', async change => {
    const f = fixture(); await flush();
    if (change === 'closed') f.clients.delete(f.relay.id);
    else f.relay.url = 'https://keewebx.app/other-page';
    await f.tick(8000); await f.work();
    expect(f.website.messages.at(-1).code).toBe('invalid');
    expect(f.app.posts.filter(post => post.data.kind === 'find-app')).toHaveLength(4);
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(0);
    expect(f.queries.matchAll).toBe(change === 'closed' ? 2 : 1);
    expect(f.timers.size).toBe(0);
});

test('recovery enumerates current App clients instead of probing a client that navigated away', async () => {
    const f = fixture(); await flush();
    f.app.url = 'https://keewebx.app/other-page';
    const replacement = new FakeWindowClient(endpoint); f.clients.set(replacement.id, replacement);
    replacement.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-ready', appBoot: request.appBoot, endpoint, state: 'enabled' });
    };
    await f.tick(8000); await f.work();
    expect(f.app.posts.filter(post => post.data.kind === 'find-app')).toHaveLength(4);
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(0);
    expect(replacement.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(1);
    expect(replacement.posts.at(-1)!.ports).toEqual([f.website]);
    expect(f.website.messages).toEqual([]);
    expect(f.timers.size).toBe(0);
});

test.each(['initial lookup', 'recovery lookup', 'handoff lookup'])(
    'a live helper survives a missing client lookup during %s', async phase => {
        const missingLookup = phase === 'initial lookup' ? 1 : 2;
        const f = fixture(false, { missingRelayLookup: missingLookup });
        acknowledge(f);
        if (phase === 'recovery lookup') {
            const answer = f.app.onPost!;
            const recoveryTime = f.time() + 8000;
            f.app.onPost = (request, ports) => {
                if (f.time() >= recoveryTime) answer(request, ports);
            };
            await flush();
            await f.tick(8000);
        }
        await flush();
        await f.work();
        expect(f.queries.missingRelay).toBe(1);
        expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(1);
        expect(f.website.messages).toEqual([]);
        expect(f.website.closed).toBe(false);
    }
);

test('discovery retries remain bounded by two eight-second rounds and close every temporary port', async () => {
    const f = fixture(); await flush(); await f.tick(8000);
    expect(f.settled()).toBe(false);
    expect(f.website.messages).toEqual([]); expect(f.website.closed).toBe(false);
    await f.tick(7999); expect(f.settled()).toBe(false);
    await f.tick(1);
    expect(f.settled()).toBe(true); await f.work();
    expect(f.app.posts.filter(post => post.data.kind === 'find-app')).toHaveLength(8);
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(0);
    expect(f.website.messages.at(-1)).toMatchObject({ kind: 'error', code: 'app-timeout' });
    expect(f.website.closed).toBe(true);
    expect(f.channels.every(channel => channel.port1.closed && channel.port2.closed)).toBe(true);
    expect(f.timers.size).toBe(0);
});

test('an unrelated refreshed App cannot replace the selected App timeout after both rounds', async () => {
    const f = fixture(true);
    f.silent.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-state', appBoot: f.silent.id, endpoint, state: 'enabled' });
    };
    await flush(); await f.tick(16000); await f.work();
    expect(f.website.messages.at(-1).code).toBe('app-timeout');
    expect(f.queries.matchAll).toBe(2);
    expect(f.timers.size).toBe(0);
});

test('a delayed browser lookup shortens round two to the remaining sixteen-second budget', async () => {
    const f = fixture(); await flush();
    const get = f.browserClients.get;
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    f.browserClients.get = async id => { if (id === f.relay.id) await waiting; return get(id); };
    await f.tick(8000);
    expect(f.queries.matchAll).toBe(1);
    await f.tick(6000); resume(); await flush();
    expect(f.queries.matchAll).toBe(2);
    expect(f.settled()).toBe(false);
    await f.tick(1999); expect(f.settled()).toBe(false);
    await f.tick(1); await f.work();
    expect(f.website.messages.at(-1).code).toBe('app-timeout');
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(0);
    expect(f.timers.size).toBe(0);
});

test('a stalled recovery lookup cannot extend discovery or start late probes', async () => {
    const f = fixture(); await flush();
    const get = f.browserClients.get;
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    f.browserClients.get = async id => { if (id === f.relay.id) await waiting; return get(id); };
    await f.tick(15999); expect(f.settled()).toBe(false);
    await f.tick(1); await f.work();
    expect(f.website.messages.at(-1).code).toBe('app-timeout');
    resume(); await flush();
    expect(f.app.posts.filter(post => post.data.kind === 'find-app')).toHaveLength(4);
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(0);
    expect(f.timers.size).toBe(0);
});

test('a delayed first reply wins once and cancels newer probes and every retry timer', async () => {
    const f = fixture(); await flush(); await f.tick(750);
    expect(f.channels).toHaveLength(2);
    const request = f.app.posts[0].data;
    f.channels[0].port2.postMessage({ marker, kind: 'app-ready', appBoot: request.appBoot, endpoint, state: 'enabled' });
    f.channels[1].port2.postMessage({ marker, kind: 'app-ready', appBoot: request.appBoot, endpoint, state: 'enabled' });
    await flush(); await f.work(); await f.tick(8000);
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(1);
    expect(f.channels).toHaveLength(2);
    expect(f.channels.every(channel => channel.port1.closed && channel.port2.closed)).toBe(true);
    expect(f.timers.size).toBe(0);
});

test('retired support controls cannot start logging or interfere with a handoff', async () => {
    const f = fixture();
    f.control({ kwDiagnostics: 'keewebx-connect-diagnostics-v1', kind: 'control', action: 'enable', expiresAt: f.time() + 60000 });
    f.app.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-ready', appBoot: request.appBoot, endpoint, state: 'enabled' });
    };
    await flush(); await f.work();
    expect(f.app.posts.some(post => post.data.kwDiagnostics !== undefined)).toBe(false);
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(1);
    expect(f.timers.size).toBe(0);
});

test('a mismatched discovery trace cannot hand off the website port', async () => {
    const f = fixture();
    await flush();
    const probe = f.app.posts.find(post => post.data.kind === 'find-app')!;
    const reply = { marker, kind: 'app-ready', appBoot: f.data.appBoot, endpoint, state: 'enabled' };
    probe.ports[0].postMessage({ ...reply, traceId: crypto.randomUUID() });
    await flush(); expect(f.settled()).toBe(false);
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(0);
    probe.ports[0].postMessage({ ...reply, traceId: probe.data.traceId });
    await flush(); await f.work();
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(1);
});

test('a missing probe-port reply can use the pending trace from the same window client', async () => {
    const f = fixture(true); await flush();
    const request = f.app.posts[0].data;
    expect(request.replyViaWorker).toBe(true);
    const reply = { marker, kind: 'app-ready', appBoot: request.appBoot, endpoint, traceId: request.traceId, state: 'enabled' };
    f.control(reply, f.silent);
    f.control({ ...reply, traceId: crypto.randomUUID() });
    await flush(); expect(f.settled()).toBe(false);
    f.control(reply);
    await flush(); await f.work();
    f.control(reply);
    const handoffs = f.app.posts.filter(post => post.data.kind === 'attach-port');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].ports).toEqual([f.website]);
    expect(f.website.messages).toEqual([]);
});

function primaryLocks(f: ReturnType<typeof fixture>, client = f.app) {
    const name = `keewebx-app-instance-v1:${new URL('../', f.relay.url).pathname}:`;
    const held = [
        { name, mode: 'exclusive', clientId: 'browser-lock-context' },
        { name: name + ':client:' + encodeURIComponent(client.id), mode: 'exclusive', clientId: 'browser-lock-context' }
    ];
    f.navigator.locks = { query: async () => { f.queries.locks++; return { held, pending: [] }; } };
    return held;
}

function acknowledge(f: ReturnType<typeof fixture>) {
    f.app.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-ready',
            appBoot: request.appBoot, endpoint: request.endpoint, state: 'enabled' });
    };
}

test.each(['top-level', 'auxiliary'])
('the selected older App wins over a different browser primary (%s)', async frameType => {
    const f = fixture(true), primary = new FakeWindowClient(endpoint, frameType), primaryBoot = crypto.randomUUID();
    f.clients.set(primary.id, primary);
    primaryLocks(f, primary);
    primary.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-state',
            appBoot: primaryBoot, endpoint: request.endpoint, state: 'disabled' });
    };
    acknowledge(f);
    await flush(); await f.work();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app', 'attach-port']);
    expect(primary.posts.map(post => post.data.kind)).toEqual(['find-app']);
    expect(f.silent.posts.map(post => post.data.kind)).toEqual(['find-app']);
    const handoff = f.app.posts.at(-1)!;
    expect(handoff.ports).toEqual([f.website]);
    expect(handoff.data).toEqual({ marker, kind: 'attach-port', appBoot: f.data.appBoot,
        connectionId: f.data.connectionId, endpoint: f.data.endpoint, siteOrigin: f.data.siteOrigin,
        handoffDeadline: f.time() + 25000 });
    expect(f.queries.locks).toBe(0);
    expect(f.queries.get.filter(id => id === primary.id)).toHaveLength(0);
    expect(f.relay.posts).toEqual([]);
    expect(f.website.closed).toBe(false);
    expect(f.timers.size).toBe(0);
});

test('a missing selected boot reports refreshed instead of forwarding to a different primary', async () => {
    const f = fixture(), primaryBoot = crypto.randomUUID();
    primaryLocks(f);
    f.app.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-state',
            appBoot: primaryBoot, endpoint: request.endpoint, state: 'enabled' });
    };
    await flush(); await f.work();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app']);
    expect(f.website.messages).toHaveLength(1);
    expect(f.website.messages[0]).toMatchObject({ marker, kind: 'error', code: 'refreshed',
        nonce: f.data.nonce, connectionId: f.data.connectionId });
    expect(f.website.closed).toBe(true);
    expect(f.queries.locks).toBe(0);
    expect(f.timers.size).toBe(0);
});

test.each(['disabled', 'address-mismatch'])
('the selected App rejection survives an unrelated primary lock (%s)', async state => {
    const f = fixture(true);
    primaryLocks(f, f.silent);
    f.app.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-state',
            appBoot: request.appBoot, endpoint: request.endpoint, state });
    };
    f.silent.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-state',
            appBoot: f.silent.id, endpoint: request.endpoint, state: 'enabled' });
    };
    await flush(); await f.work();
    expect(f.website.messages[0]).toMatchObject({ kind: 'error', code: state === 'disabled' ? 'disabled' : 'address' });
    expect([...f.clients.values()].flatMap(client => client.posts).some(post => post.data.kind === 'attach-port')).toBe(false);
    expect(f.queries.locks).toBe(0);
    expect(f.website.closed).toBe(true); expect(f.timers.size).toBe(0);
});

test('a silent selected primary still requires discovery acknowledgement before handoff', async () => {
    const f = fixture(); primaryLocks(f);
    await flush();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app']);
    expect(f.settled()).toBe(false);
    expect(f.website.messages).toEqual([]);
    await f.tick(16000); await f.work();
    expect(f.app.posts.filter(post => post.data.kind === 'find-app')).toHaveLength(8);
    expect(f.app.posts.some(post => post.data.kind === 'attach-port')).toBe(false);
    expect(f.website.messages[0]).toMatchObject({ kind: 'error', code: 'app-timeout' });
    expect(f.queries.locks).toBe(0); expect(f.timers.size).toBe(0);
});

test.each(['iframe', 'foreign-origin', 'wrong-base', 'outside-enumeration', 'relay'])
('discovery cannot forward to a noncandidate even if its locator exists (%s)', async scenario => {
    const f = fixture();
    const other = scenario === 'relay' ? f.relay : new FakeWindowClient(
        scenario === 'foreign-origin' ? 'https://attacker.example/app' :
            scenario === 'wrong-base' ? 'https://keewebx.app/other/app' : endpoint,
        scenario === 'iframe' ? 'nested' : 'top-level');
    if (scenario !== 'outside-enumeration') f.clients.set(other.id, other);
    else {
        const get = f.browserClients.get;
        f.browserClients.get = async id => id === other.id ? other : get(id);
    }
    primaryLocks(f, other); acknowledge(f);
    await flush(); await f.work();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app', 'attach-port']);
    expect(other.posts.some(post => ['find-app', 'attach-port'].includes(post.data.kind))).toBe(false);
    expect(f.queries.locks).toBe(0); expect(f.timers.size).toBe(0);
});

test('discovery does not wait for an unavailable lock service', async () => {
    const f = fixture();
    f.navigator.locks = { query: () => { f.queries.locks++; return new Promise(() => {}); } };
    acknowledge(f); await flush(); await f.work();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app', 'attach-port']);
    expect(f.queries.locks).toBe(0); expect(f.timers.size).toBe(0);
});

test.each(['app-closed', 'app-navigated', 'app-iframe', 'app-replaced',
    'relay-closed', 'relay-navigated', 'relay-iframe'])
('handoff revalidates browser clients after selected-boot discovery (%s)', async scenario => {
    const f = fixture();
    f.app.onPost = (request, ports) => {
        if (request.kind !== 'find-app') return;
        ports[0].postMessage({ marker, kind: 'app-ready', appBoot: request.appBoot,
            endpoint: request.endpoint, state: 'enabled' });
        const target = scenario.startsWith('relay') ? f.relay : f.app;
        if (scenario.endsWith('closed')) f.clients.delete(target.id);
        else if (scenario.endsWith('iframe')) {
            const nested = new FakeWindowClient(target.url, 'nested'); nested.id = target.id;
            f.clients.set(target.id, nested);
        } else if (scenario === 'app-replaced') f.clients.set(target.id, new FakeWindowClient(target.url));
        else target.url = 'https://keewebx.app/other/app';
    };
    await flush(); await f.work();
    expect(f.website.messages[0]).toMatchObject({ kind: 'error',
        code: scenario.startsWith('relay') ? 'invalid' : 'refreshed' });
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app']);
    expect(f.queries.get.filter(id => id === f.relay.id)).toHaveLength(2);
    expect(f.queries.locks).toBe(0);
    expect(f.website.closed).toBe(true); expect(f.timers.size).toBe(0);
});

test.each(['/app', '/app/', '/index.html', '/next.html'])
('nested deployments keep selected-boot discovery (%s)', async path => {
    const appURL = 'https://keewebx.app/deployed' + path;
    const f = fixture(false, { base: 'https://keewebx.app/deployed/', endpoint: appURL, appURL });
    primaryLocks(f); acknowledge(f); await flush(); await f.work();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app', 'attach-port']);
    expect(f.app.posts.at(-1)!.data.endpoint).toBe(appURL);
    expect(f.app.posts.at(-1)!.ports).toEqual([f.website]);
    expect(f.queries.locks).toBe(0); expect(f.timers.size).toBe(0);
});

test.each(['https://keewebx.app/app?namespace=separate', 'https://keewebx.app/other/app'])
('selected endpoints remain isolated from the default primary lock (%s)', async appURL => {
    const f = fixture(false, { endpoint: appURL, appURL });
    primaryLocks(f); acknowledge(f); await flush(); await f.work();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app', 'attach-port']);
    expect(f.app.posts.at(-1)!.data.endpoint).toBe(appURL);
    expect(f.queries.locks).toBe(0); expect(f.timers.size).toBe(0);
});
