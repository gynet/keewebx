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
    constructor(readonly url: string, readonly frameType = 'top-level') {}
    postMessage(data: any, ports: FakePort[] = []) {
        this.posts.push({ data: structuredClone(data), ports });
        this.onPost?.(data, ports);
    }
}

function fixture(withSilentApp = false) {
    const data = { marker, kind: 'attach', nonce: crypto.randomUUID(), appBoot: crypto.randomUUID(),
        connectionId: crypto.randomUUID(), endpoint, siteOrigin: 'https://login.example.org' };
    const relayURL = new URL('https://keewebx.app/connect-port/relay.html');
    relayURL.searchParams.set('site', data.siteOrigin);
    relayURL.searchParams.set('nonce', data.nonce);
    relayURL.searchParams.set('endpoint', data.endpoint);
    const relay = new FakeWindowClient(relayURL.href, 'auxiliary');
    const app = new FakeWindowClient(receiverEndpoint);
    const clients = new Map([[relay.id, relay], [app.id, app]]);
    const silent = new FakeWindowClient('https://keewebx.app/app');
    if (withSilentApp) clients.set(silent.id, silent);
    const website = new FakePort();
    const timers = new Map<number, () => void>();
    const channels: { port1: FakePort; port2: FakePort }[] = [];
    const listeners = new Map<string, (event: any) => void>();
    let nextTimer = 0, settled = false, work: Promise<void> | undefined;

    runInNewContext(source, {
        URL, TextEncoder, WindowClient: FakeWindowClient,
        MessageChannel: class {
            port1 = new FakePort();
            port2 = new FakePort();
            constructor() {
                this.port1.peer = this.port2; this.port2.peer = this.port1;
                channels.push(this);
            }
        },
        setTimeout(callback: () => void) { const id = ++nextTimer; timers.set(id, callback); return id; },
        clearTimeout(id: number) { timers.delete(id); },
        self: {
            location: new URL('https://keewebx.app/connect-port/worker.js'),
            addEventListener(name: string, listener: (event: any) => void) { listeners.set(name, listener); },
            clients: { async get(id: string) { return clients.get(id); }, async matchAll() { return [...clients.values()]; } }
        }
    }, { filename: 'connect-port/worker.js' });

    listeners.get('message')!({ data, source: relay, ports: [website], waitUntil(promise: Promise<void>) {
        work = promise; void promise.then(() => { settled = true; }, () => { settled = true; });
    } });
    return { data, relay, app, silent, website, timers, channels, settled: () => settled, work: () => work! };
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
    expect(f.timers.size).toBe(1);

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
    expect(f.silent.posts.map(post => post.data.kind)).toEqual(['find-app']);
    expect(f.website.messages).toEqual([]);
    expect(f.website.closed).toBe(false);
    expect(f.timers.size).toBe(0);
    expect(f.channels.every(channel => channel.port1.closed && channel.port2.closed)).toBe(true);
});
