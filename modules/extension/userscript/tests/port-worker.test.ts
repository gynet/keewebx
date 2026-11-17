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

function fixture(withSilentApp = false, options: { base?: string; endpoint?: string; appURL?: string } = {}) {
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
    const queries = { get: [] as string[], matchAll: 0, locks: 0 };
    const navigator: { locks?: { query: () => Promise<any> } } = {};
    const browserClients = {
        async get(id: string) { queries.get.push(id); return clients.get(id); },
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
    expect(f.relay.posts).toHaveLength(1);
    expect(f.relay.posts[0].data).toEqual({ marker, kind: 'handoff-complete', nonce: f.data.nonce,
        connectionId: f.data.connectionId, endpoint });
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
    expect(f.relay.posts).toHaveLength(1);
    expect(f.relay.posts[0].data).toMatchObject({ kind: 'handoff-complete', nonce: f.data.nonce, connectionId: f.data.connectionId });
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
    expect(f.queries.matchAll).toBe(1);
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

test('discovery retries remain bounded by two eight-second rounds and close every temporary port', async () => {
    const f = fixture(); await flush(); await f.tick(8000);
    expect(f.settled()).toBe(false);
    expect(f.website.messages).toEqual([]); expect(f.website.closed).toBe(false);
    await f.tick(7999); expect(f.settled()).toBe(false);
    await f.tick(1);
    expect(f.settled()).toBe(true); await f.work();
    expect(f.app.posts.filter(post => post.data.kind === 'find-app')).toHaveLength(8);
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(0);
    expect(f.website.messages.at(-1)).toMatchObject({ kind: 'error', code: 'timeout' });
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
    expect(f.website.messages.at(-1).code).toBe('timeout');
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
    expect(f.website.messages.at(-1).code).toBe('timeout');
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
    expect(f.website.messages.at(-1).code).toBe('timeout');
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

const diagnosticMarker = 'keewebx-connect-diagnostics-v1';
const diagnosticEvents = (f: ReturnType<typeof fixture>) => f.app.posts
    .filter(post => post.data.kwDiagnostics === diagnosticMarker).map(post => post.data);
test('worker diagnostics require App opt-in and contain only fixed transport stage metadata', async () => {
    const f = fixture();
    f.control({ kwDiagnostics: diagnosticMarker, kind: 'control', action: 'enable', expiresAt: Date.now() + 60000 });
    f.app.onPost = (request, ports) => {
        if (request.kind === 'find-app') ports[0].postMessage({ marker, kind: 'app-ready', appBoot: request.appBoot, endpoint, state: 'enabled' });
    };
    await flush(); await f.work();
    const events = diagnosticEvents(f);
    expect(events.map(value => value.data.event)).toEqual(['discovery', 'discovery-received', 'discovery-reply', 'handoff']);
    const traceId = f.app.posts.find(post => post.data.kind === 'find-app')!.data.traceId;
    expect(traceId).toMatch(/^[a-f0-9-]{36}$/);
    for (const value of events) {
        expect(value).toMatchObject({ kwDiagnostics: diagnosticMarker, kind: 'event', code: 'transport.event',
            data: { layer: 'worker', portId: f.data.connectionId } });
        expect(Object.keys(value.data).every(key => ['layer', 'event', 'traceId', 'portId', 'detail'].includes(key))).toBe(true);
    }
    expect(events.slice(0, 3).every(value => value.data.traceId === traceId)).toBe(true);
    expect(events[2].data.detail).toBe('legacy');
});

test('discovery traces distinguish a rejected reply from a matching acknowledgement', async () => {
    const f = fixture();
    f.control({ kwDiagnostics: diagnosticMarker, kind: 'control', action: 'enable', expiresAt: Date.now() + 60000 });
    f.app.onPost = (request, ports) => {
        if (request.kind !== 'find-app') return;
        const reply = { marker, kind: 'app-ready', appBoot: request.appBoot, endpoint, state: 'enabled' };
        ports[0].postMessage({ ...reply, traceId: crypto.randomUUID() });
        ports[0].postMessage({ ...reply, traceId: request.traceId });
    };
    await flush(); await f.work();
    const events = diagnosticEvents(f).map(value => value.data);
    expect(events.filter(value => value.event === 'discovery-rejected')).toEqual([
        { layer: 'worker', event: 'discovery-rejected', detail: 'wrong-shape',
            traceId: events[0].traceId, portId: f.data.connectionId }
    ]);
    expect(events.find(value => value.event === 'discovery-reply')?.detail).toBe('matched');
    expect(f.app.posts.filter(post => post.data.kind === 'attach-port')).toHaveLength(1);
});

test.each(['helper', 'subframe', 'foreign', 'expired', 'overlong', 'disabled'])
('worker diagnostics reject %s controls without affecting the discovery deadline', async scenario => {
    const f = fixture();
    const enable = { kwDiagnostics: diagnosticMarker, kind: 'control', action: 'enable', expiresAt: Date.now() + 60000 };
    const from = scenario === 'helper' ? f.relay : scenario === 'subframe' ? new FakeWindowClient(endpoint, 'nested')
        : scenario === 'foreign' ? new FakeWindowClient('https://attacker.example/app') : f.app;
    f.control({ ...enable, ...(scenario === 'expired' ? { expiresAt: f.time() - 1 }
        : scenario === 'overlong' ? { expiresAt: f.time() + 3600001 } : {}) }, from);
    if (scenario === 'disabled') f.control({ ...enable, action: 'disable' });
    await flush(); await f.tick(16000); await f.work();
    expect(diagnosticEvents(f)).toEqual([]);
    expect(f.website.messages.at(-1).code).toBe('timeout');
});

test('worker diagnostic opt-in expires during discovery and cannot emit later stages', async () => {
    const f = fixture();
    f.control({ kwDiagnostics: diagnosticMarker, kind: 'control', action: 'enable', expiresAt: Date.now() + 500 });
    await flush(); await f.tick(16000); await f.work();
    expect(diagnosticEvents(f).map(event => event.data.event)).toEqual(['discovery']);
    expect(f.website.messages.at(-1).code).toBe('timeout');
});

test('an opted-in App receives discovery-timeout when every reply is lost', async () => {
    const f = fixture();
    f.control({ kwDiagnostics: diagnosticMarker, kind: 'control', action: 'enable', expiresAt: Date.now() + 60000 });
    await flush(); await f.tick(16000); await f.work();
    expect(diagnosticEvents(f).map(event => event.data.event)).toEqual([
        'discovery', 'discovery', 'discovery', 'discovery', 'discovery-timeout',
        'discovery', 'discovery', 'discovery', 'discovery', 'discovery-timeout'
    ]);
});

test('worker diagnostic grants are bounded to 32 clients', async () => {
    const f = fixture();
    const enable = { kwDiagnostics: diagnosticMarker, kind: 'control', action: 'enable', expiresAt: f.time() + 60000 };
    f.control(enable);
    for (let index = 0; index < 32; index++) f.control(enable, new FakeWindowClient(endpoint));
    await flush(); await f.tick(16000); await f.work();
    expect(diagnosticEvents(f)).toEqual([]);
    expect(f.website.messages.at(-1).code).toBe('timeout');
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

test.each(['top-level', 'auxiliary'])('browser primary routing needs no discovery acknowledgement (%s)', async frameType => {
    const f = fixture(true);
    const primary = new FakeWindowClient(receiverEndpoint, frameType);
    // The lock identifies a browser execution context, never the WindowClient ID.
    primary.id = '{actual-WindowClient-42}';
    f.clients.set(primary.id, primary);
    primaryLocks(f, primary);
    await flush(); await f.work();
    expect(f.settled()).toBe(true);
    expect(primary.posts).toHaveLength(1);
    expect(primary.posts[0]).toEqual({ data: { marker, kind: 'attach-port', appBoot: f.data.appBoot,
        connectionId: f.data.connectionId, endpoint: f.data.endpoint, siteOrigin: f.data.siteOrigin }, ports: [f.website] });
    expect(f.app.posts).toEqual([]); expect(f.silent.posts).toEqual([]);
    expect(f.channels).toHaveLength(0); expect(f.queries.locks).toBe(1);
    expect(f.queries.get.filter(id => id === primary.id)).toHaveLength(2);
    expect(f.queries.get.filter(id => id === f.relay.id)).toHaveLength(2);
    expect(f.relay.posts[0].data.kind).toBe('handoff-complete');
    expect(f.website.messages).toEqual([]); expect(f.website.closed).toBe(false);
    expect(f.timers.size).toBe(0);
    await f.tick(16000);
    expect(primary.posts).toHaveLength(1);
});

test.each([
    'no-owner', 'shared-owner', 'empty-owner', 'duplicate-owner', 'foreign-owner', 'wrong-base',
    'namespaced', 'missing-locator', 'shared-locator', 'foreign-locator', 'wrong-base-locator',
    'ambiguous-locator', 'duplicate-locator', 'malformed-locator', 'noncanonical-locator', 'missing-client'
])('unreliable primary proof uses unchanged discovery (%s)', async scenario => {
    const f = fixture(true), held = primaryLocks(f);
    switch (scenario) {
        case 'no-owner': held.splice(0, 1); break;
        case 'shared-owner': held[0].mode = 'shared'; break;
        case 'empty-owner': held[0].clientId = ''; break;
        case 'duplicate-owner': held.push({ ...held[0] }); break;
        case 'foreign-owner': held[0].clientId = 'foreign-context'; break;
        case 'wrong-base': held[0].name = 'keewebx-app-instance-v1:/other/:'; break;
        case 'namespaced':
            held[0].name += 'separate';
            held[1].name = held[0].name + ':client:' + f.app.id;
            break;
        case 'missing-locator': held.pop(); break;
        case 'shared-locator': held[1].mode = 'shared'; break;
        case 'foreign-locator': held[1].clientId = 'foreign-context'; break;
        case 'wrong-base-locator': held[1].name = 'keewebx-app-instance-v1:/other/::client:' + f.app.id; break;
        case 'ambiguous-locator': held.push({ ...held[1], name: held[0].name + ':client:' + f.silent.id }); break;
        case 'duplicate-locator': held.push({ ...held[1] }); break;
        case 'malformed-locator': held[1].name = held[0].name + ':client:%zz'; break;
        case 'noncanonical-locator': held[1].name = held[0].name + ':client:%' + f.app.id.charCodeAt(0).toString(16) + f.app.id.slice(1); break;
        case 'missing-client': held[1].name = held[0].name + ':client:closed-client'; break;
    }
    acknowledge(f);
    await flush(); await f.work();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app', 'attach-port']);
    expect(f.app.posts.at(-1)!.ports).toEqual([f.website]);
    expect(f.channels.length).toBeGreaterThan(0); expect(f.queries.locks).toBe(1);
    expect(f.website.messages).toEqual([]); expect(f.website.closed).toBe(false);
    expect(f.timers.size).toBe(0);
});

test.each(['iframe', 'foreign-origin', 'wrong-base', 'outside-enumeration', 'relay'])
('a locator cannot select a noncandidate (%s)', async scenario => {
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
    expect(other.posts.some(post => post.data.kind === 'attach-port')).toBe(false);
    expect(f.queries.locks).toBe(1); expect(f.timers.size).toBe(0);
});

test.each(['throw', 'reject', 'bad-snapshot', 'bad-held'])('lock query failures preserve discovery (%s)', async scenario => {
    const f = fixture();
    f.navigator.locks = { query: () => {
        f.queries.locks++;
        if (scenario === 'throw') throw new Error('Unavailable');
        return scenario === 'reject' ? Promise.reject(new Error('Unavailable')) :
            Promise.resolve(scenario === 'bad-held' ? { held: {} } : null);
    } };
    acknowledge(f); await flush(); await f.work();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app', 'attach-port']);
    expect(f.queries.locks).toBe(1); expect(f.timers.size).toBe(0);
});

test.each(['app-closed', 'app-navigated', 'app-iframe', 'relay-closed', 'relay-navigated', 'relay-iframe'])
('handoff rechecks browser App and relay after primary lookup (%s)', async scenario => {
    const f = fixture(); primaryLocks(f);
    const get = f.browserClients.get;
    let relayReads = 0;
    f.browserClients.get = async id => {
        if (id === f.relay.id && ++relayReads === 1) {
            const target = scenario.startsWith('relay') ? f.relay : f.app;
            if (scenario.endsWith('closed')) f.clients.delete(target.id);
            else if (scenario.endsWith('iframe')) {
                const nested = new FakeWindowClient(target.url, 'nested'); nested.id = target.id;
                f.clients.set(target.id, nested);
            } else target.url = 'https://keewebx.app/other/app';
        }
        return get(id);
    };
    await flush(); await f.work();
    expect(f.website.messages.at(-1).code).toBe(scenario.startsWith('relay') ? 'invalid' : 'refreshed');
    expect(f.app.posts).toEqual([]); expect(f.channels).toHaveLength(0);
    expect(f.website.closed).toBe(true); expect(f.timers.size).toBe(0);
});

test('a client that moves before locator resolution falls back to current discovery', async () => {
    const f = fixture(true); primaryLocks(f, f.silent);
    const get = f.browserClients.get;
    f.browserClients.get = async id => {
        if (id === f.silent.id) f.silent.url = 'https://keewebx.app/other/app';
        return get(id);
    };
    acknowledge(f); await flush(); await f.work();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app', 'attach-port']);
    expect(f.silent.posts.some(post => post.data.kind === 'attach-port')).toBe(false);
    expect(f.timers.size).toBe(0);
});

test.each(['query', 'client-get'])('a hung %s lookup falls back at 500ms and cannot hand off late', async stage => {
    const f = fixture(), held = primaryLocks(f);
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    if (stage === 'query') f.navigator.locks!.query = async () => {
        f.queries.locks++; await waiting; return { held };
    };
    else {
        const get = f.browserClients.get;
        let reads = 0;
        f.browserClients.get = async id => {
            if (id === f.app.id && ++reads === 1) await waiting;
            return get(id);
        };
    }
    await flush();
    expect(f.app.posts).toEqual([]);
    await f.tick(499); expect(f.app.posts).toEqual([]); expect(f.settled()).toBe(false);
    await f.tick(1);
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app']);
    resume(); await flush();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app']);
    await f.tick(15499); expect(f.settled()).toBe(false);
    await f.tick(1); await f.work();
    expect(f.website.messages.at(-1).code).toBe('timeout');
    expect(f.app.posts.filter(post => post.data.kind === 'find-app')).toHaveLength(8);
    expect(f.app.posts.some(post => post.data.kind === 'attach-port')).toBe(false);
    expect(f.queries.locks).toBe(1); expect(f.timers.size).toBe(0);
    expect(f.channels.every(channel => channel.port1.closed && channel.port2.closed)).toBe(true);
});

test.each(['/app', '/app/', '/index.html', '/next.html'])('a nested deployment proves only its exact default main lock (%s)', async path => {
    const appURL = 'https://keewebx.app/deployed' + path;
    const f = fixture(false, { base: 'https://keewebx.app/deployed/', endpoint: appURL, appURL });
    primaryLocks(f); await flush(); await f.work();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['attach-port']);
    expect(f.app.posts[0].data.endpoint).toBe(appURL);
    expect(f.channels).toHaveLength(0); expect(f.queries.locks).toBe(1);
    expect(f.timers.size).toBe(0);
});

test('a different endpoint deployment cannot use this worker primary lock', async () => {
    const appURL = 'https://keewebx.app/other/app';
    const f = fixture(false, { endpoint: appURL, appURL });
    primaryLocks(f); acknowledge(f); await flush(); await f.work();
    expect(f.app.posts.map(post => post.data.kind)).toEqual(['find-app', 'attach-port']);
    expect(f.queries.locks).toBe(0); expect(f.timers.size).toBe(0);
});
