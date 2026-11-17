import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import {
    DiagnosticClient, type DiagnosticClientOptions, type DiagnosticCommandKind,
    type DiagnosticData, type DiagnosticSession, type DiagnosticState, type DiagnosticStore
} from '../src';

const HOUR = 3_600_000;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const clients: DiagnosticClient[] = [];
let time: number;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function settle() { for (let n = 0; n < 60; n++) await Promise.resolve(); }
async function advance(ms: number) { time += ms; jest.advanceTimersByTime(ms); await settle(); }

function harness(overrides: Partial<DiagnosticClientOptions> = {}) {
    const calls: { path: string; body: any; token: string | undefined; signal: AbortSignal }[] = [];
    const states: DiagnosticState[] = [];
    const snapshots: DiagnosticCommandKind[] = [];
    const saved: (DiagnosticSession | undefined)[] = [];
    let loads = 0;
    let stored: DiagnosticSession | undefined;
    let commands: unknown[] = [];
    let session = { id: id(1), token: 'private-bearer', expiresAt: time + HOUR };
    let exchange: () => unknown | Promise<unknown> = () => ({ commands, expiresAt: session.expiresAt });
    let create: () => unknown | Promise<unknown> = () => ({ ...session });
    let snapshot: DiagnosticClientOptions['snapshot'] = () => ({ locked: true });
    const store = overrides.store ?? {
        async load() { loads++; return stored && { ...stored }; },
        async save(value: DiagnosticSession | undefined) { saved.push(value); stored = value && { ...value }; }
    };
    const options: DiagnosticClientOptions = {
        source: 'app', version: '0.1.0-test', store,
        transport: async (path, body, token, signal) => {
            calls.push({ path, body, token, signal });
            return path.endsWith('/session') ? create() : exchange();
        },
        snapshot: kind => { snapshots.push(kind); return snapshot(kind); },
        onChange: state => states.push(state), now: () => time,
        ...overrides
    };
    const client = new DiagnosticClient(options);
    clients.push(client);
    return {
        client, calls, states, snapshots, saved, store,
        get loads() { return loads; },
        get stored() { return stored; }, set stored(value) { stored = value; },
        get session() { return session; }, set session(value) { session = value; },
        set commands(value: unknown[]) { commands = value; },
        set exchange(value: typeof exchange) { exchange = value; },
        set create(value: typeof create) { create = value; },
        set snapshot(value: typeof snapshot) { snapshot = value; },
        command(n = 10, extra: Record<string, unknown> = {}) {
            return { id: id(n), kind: 'snapshot', issuedAt: time, expiresAt: time + 30_000, ...extra };
        }
    };
}

/** Models a durable tombstone and fence-bound grant, including non-atomic late writes. */
function fencedStore() {
    let marker = 'initial';
    let revocations = 0;
    let grant: { session: DiagnosticSession; fence: string } | undefined;
    const writes: DiagnosticSession[] = [];
    let beforeWrite = async () => {};
    let afterWrite = async () => {};
    const store: DiagnosticStore = {
        async revision() { return marker; },
        async load() { return grant?.fence === marker ? { ...grant.session } : undefined; },
        async save(session, expectedRevision) {
            if (!session) {
                marker = `revoked:${++revocations}`;
                grant = undefined;
                return;
            }
            if (expectedRevision !== marker) throw new Error('revoked');
            await beforeWrite();
            // A late GM write may physically happen after deletion, but its old fence stays invalid.
            grant = { session: { ...session }, fence: expectedRevision };
            writes.push(session);
            await afterWrite();
        }
    };
    return {
        store, writes,
        get marker() { return marker; },
        set beforeWrite(value: typeof beforeWrite) { beforeWrite = value; },
        set afterWrite(value: typeof afterWrite) { afterWrite = value; }
    };
}

beforeEach(() => { jest.useFakeTimers(); time = 1_800_000_000_000; });
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); jest.useRealTimers(); });

test('constructor, recording, disabled flush and empty refresh do not collect or contact transport', async () => {
    const h = harness();
    expect(h.loads).toBe(0);
    h.client.record('app.locked', { locked: true });
    await h.client.flush();
    await advance(20_000);
    expect(h.loads).toBe(0);
    await h.client.refresh();
    expect(h.calls).toHaveLength(0);
    expect(h.snapshots).toHaveLength(0);
    expect(h.client.state).toEqual({ enabled: false, status: 'off' });
});

test('save completes before activation, collection and exchange; no pre-consent backfill', async () => {
    const gate = deferred<void>();
    let stored: DiagnosticSession | undefined;
    const h = harness({ store: {
        async load() { return stored; },
        async save(value) { await gate.promise; stored = value; }
    } });
    h.client.record('connect.error', { reason: 'locked' });
    const enabling = h.client.enable();
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.client.state.enabled).toBe(false);
    expect(h.snapshots).toHaveLength(0);
    h.client.record('page.hidden');
    gate.resolve();
    await enabling;
    expect(h.calls.map(call => call.path)).toEqual([
        '/api/connect-diagnostics/session', `/api/connect-diagnostics/${id(1)}/exchange`
    ]);
    expect(h.calls[0].body).toEqual({});
    expect(h.calls[0].token).toBeUndefined();
    expect(h.calls[1].token).toBe('private-bearer');
    expect(h.calls[1].body.events.map((event: any) => event.code)).toEqual(['session.started']);
    expect(h.client.state.status).toBe('connected');
    expect(JSON.stringify(h.states)).not.toContain('private-bearer');
});

test('a delayed server creation succeeds and persists a local grant capped from the start', async () => {
    const h = harness();
    const started = time;
    h.create = () => { time += 17; return { ...h.session, expiresAt: time + HOUR }; };
    await h.client.enable();
    expect(h.client.state.enabled).toBe(true);
    expect(h.stored?.expiresAt).toBe(started + HOUR);
    expect(h.client.state.expiresAt).toBe(started + HOUR);
});

test('real-clock HTTP latency does not reject an otherwise valid one-hour server session', async () => {
    jest.useRealTimers();
    time = Date.now();
    let firstNow: number | undefined;
    const h = harness({ now: () => { const now = Date.now(); firstNow ??= now; return now; } });
    h.create = async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return { ...h.session, expiresAt: Date.now() + HOUR };
    };
    await h.client.enable();
    expect(h.client.state.enabled).toBe(true);
    expect(h.stored!.expiresAt).toBeLessThanOrEqual(firstNow! + HOUR);
});

test('bounded server clock skew is clamped, while unreasonable lifetimes fail closed', async () => {
    const h = harness();
    h.create = () => ({ ...h.session, expiresAt: time + HOUR + 500 });
    await h.client.enable();
    expect(h.client.state.expiresAt).toBe(time + HOUR);
    const bad = harness();
    bad.create = () => ({ ...bad.session, expiresAt: time + HOUR + 60_001 });
    await bad.client.enable();
    expect(bad.client.state).toMatchObject({ enabled: false, error: 'invalid-response' });
    expect(bad.saved).toHaveLength(0);
});

test('persistence failure never enables or sends events and exposes only a fixed error', async () => {
    const h = harness({ store: {
        async load() { return undefined; },
        async save() { throw new Error('https://private/account/password'); }
    } });
    await h.client.enable();
    expect(h.client.state).toMatchObject({ enabled: false, error: 'storage' });
    expect(h.calls).toHaveLength(1);
    expect(JSON.stringify(h.states)).not.toMatch(/https|password|account/);
});

test('simultaneous enables create only one session', async () => {
    const h = harness();
    await Promise.all([h.client.enable(), h.client.enable(), h.client.enable()]);
    expect(h.calls.filter(call => call.path.endsWith('/session'))).toHaveLength(1);
});

test('shared store reuses global opt-in with distinct document UUIDs and independent sequence counters', async () => {
    const a = harness();
    await a.client.enable();
    const b = harness({ source: 'website', store: a.store });
    await b.client.refresh();
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0].body.source).toBe('website');
    const first = a.calls[1].body;
    const second = b.calls[0].body;
    expect(first.client).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.client).not.toBe(second.client);
    expect(first.events[0].seq).toBe(1);
    expect(second.events[0].seq).toBe(1);
    await a.client.disable();
    await b.client.refresh();
    expect(b.client.state.enabled).toBe(false);
    expect(b.calls).toHaveLength(1);
});

test('shared revocation fences stop a delayed simultaneous enable after another client enables and disables', async () => {
    const shared = fencedStore();
    const a = harness({ store: shared.store });
    const b = harness({ store: shared.store });
    b.session = { ...b.session, id: id(2) };
    const created = deferred<unknown>();
    b.create = () => created.promise;
    const enablingA = a.client.enable();
    const enablingB = b.client.enable();
    await settle();
    await enablingA;
    expect(a.client.state.enabled).toBe(true);
    expect(b.calls).toHaveLength(1);
    await a.client.disable();
    expect(await shared.store.load()).toBeUndefined();
    created.resolve(b.session);
    await enablingB;
    await a.client.refresh();
    expect(b.client.state.enabled).toBe(false);
    expect(a.client.state.enabled).toBe(false);
    expect(b.calls).toHaveLength(1); // Creation only, never an exchange after revocation.
    expect(shared.writes).toHaveLength(1);
    expect(shared.marker).toBe('revoked:1');
    expect(await shared.store.load()).toBeUndefined();
});

test('a grant written after revocation with its old fence is invisible and cannot be adopted', async () => {
    const shared = fencedStore();
    const owner = harness({ store: shared.store });
    await owner.client.enable();
    // A second explicit creation starts from the same empty marker before the owner publishes.
    await owner.client.disable();
    const late = harness({ store: shared.store });
    late.session = { ...late.session, id: id(2) };
    const gate = deferred<void>();
    shared.beforeWrite = () => gate.promise;
    const enabling = late.client.enable();
    await settle();
    await owner.client.disable();
    gate.resolve();
    await enabling;
    expect(shared.writes).toHaveLength(2); // Includes the physical late write under the old fence.
    expect(await shared.store.load()).toBeUndefined();
    expect(late.client.state.enabled).toBe(false);
    expect(late.calls).toHaveLength(1);
    await owner.client.refresh();
    expect(owner.client.state.enabled).toBe(false);
});

test('revocation after save but before adoption is detected by rereading the persisted grant', async () => {
    const shared = fencedStore();
    const owner = harness({ store: shared.store });
    const publishing = harness({ store: shared.store });
    const gate = deferred<void>();
    shared.afterWrite = () => gate.promise;
    const enabling = publishing.client.enable();
    await settle();
    expect(shared.writes).toHaveLength(1);
    await owner.client.disable();
    gate.resolve();
    await enabling;
    expect(publishing.client.state.enabled).toBe(false);
    expect(publishing.calls).toHaveLength(1);
    expect(await shared.store.load()).toBeUndefined();
});

test('disable aborts pending creation even when transport ignores AbortSignal', async () => {
    const h = harness();
    const gate = deferred<unknown>();
    h.create = () => gate.promise;
    const work = h.client.enable();
    await settle();
    await h.client.disable();
    expect(h.calls[0].signal.aborted).toBe(true);
    gate.resolve(h.session);
    await work;
    expect(h.client.state.enabled).toBe(false);
    expect(h.saved).toEqual([undefined]);
    expect(h.calls).toHaveLength(1);
});

test('disable during a pending save serializes clearing after that save and prevents activation', async () => {
    const gate = deferred<void>();
    const writes: (DiagnosticSession | undefined)[] = [];
    let stored: DiagnosticSession | undefined;
    const h = harness({ store: {
        async load() { return stored; },
        async save(value) { writes.push(value); if (value) await gate.promise; stored = value; }
    } });
    const work = h.client.enable();
    await settle();
    expect(writes).toHaveLength(1);
    const disabling = h.client.disable();
    gate.resolve();
    await Promise.all([work, disabling]);
    expect(stored).toBeUndefined();
    expect(h.client.state.enabled).toBe(false);
    expect(h.calls).toHaveLength(1);
    expect(writes[1]).toBeUndefined();
});

test('disable clears queued events and ignores a late exchange response and its commands', async () => {
    const h = harness();
    await h.client.enable();
    const gate = deferred<unknown>();
    h.exchange = () => gate.promise;
    h.client.record('connect.action', { action: 'save' });
    const work = h.client.flush();
    await settle();
    const request = h.calls.at(-1)!;
    await h.client.disable();
    expect(request.signal.aborted).toBe(true);
    gate.resolve({ commands: [h.command()], expiresAt: h.session.expiresAt });
    await work;
    expect(h.snapshots).toHaveLength(0);
    h.session = { ...h.session, id: id(2) };
    h.exchange = () => ({ commands: [], expiresAt: h.session.expiresAt });
    await h.client.enable();
    expect(h.calls.at(-1)!.body.events.map((event: any) => event.code)).toEqual(['session.started']);
});

test('shared session replacement aborts the old exchange and excludes its late commands', async () => {
    const h = harness();
    await h.client.enable();
    const gate = deferred<unknown>();
    h.exchange = () => gate.promise;
    const old = h.client.flush();
    await settle();
    const oldCall = h.calls.at(-1)!;
    h.stored = { id: id(2), token: 'replacement-token', expiresAt: time + HOUR };
    h.exchange = () => ({ commands: [], expiresAt: time + HOUR });
    await h.client.refresh();
    gate.resolve({ commands: [h.command()], expiresAt: time + HOUR });
    await old;
    expect(oldCall.signal.aborted).toBe(true);
    expect(h.client.state.id).toBe(id(2));
    expect(h.calls.at(-1)!.token).toBe('replacement-token');
    expect(h.snapshots).toHaveLength(0);
});

test('token rotation aborts the pending exchange without rerunning an already executed command', async () => {
    const h = harness();
    h.commands = [h.command()];
    await h.client.enable();
    const gate = deferred<unknown>();
    h.exchange = () => gate.promise;
    const old = h.client.flush();
    await settle();
    const oldCall = h.calls.at(-1)!;
    h.stored = { ...h.stored!, token: 'rotated-token' };
    h.exchange = () => ({ commands: [h.command()], expiresAt: h.session.expiresAt });
    await h.client.refresh();
    await old;
    gate.resolve({ commands: [h.command(11)], expiresAt: h.session.expiresAt });
    await settle();
    expect(oldCall.signal.aborted).toBe(true);
    expect(h.calls.at(-1)!.token).toBe('rotated-token');
    expect(h.snapshots).toHaveLength(1);
});

test('a delayed shared-store read cannot reactivate diagnostics after disable', async () => {
    const gate = deferred<DiagnosticSession | undefined>();
    let stored: DiagnosticSession | undefined;
    let delay = false;
    const h = harness({ store: {
        async load() { return delay ? gate.promise : stored; },
        async save(value) { stored = value; }
    } });
    await h.client.enable();
    delay = true;
    const reading = h.client.refresh();
    await settle();
    const disabling = h.client.disable();
    expect(h.client.state.enabled).toBe(false);
    gate.resolve(stored);
    await Promise.all([reading, disabling]);
    expect(stored).toBeUndefined();
    expect(h.client.state.enabled).toBe(false);
    expect(h.calls).toHaveLength(2);
});

test('late snapshot resolution after disable cannot upload into the next session', async () => {
    const h = harness();
    const gate = deferred<DiagnosticData>();
    h.commands = [h.command()];
    h.snapshot = () => gate.promise;
    const work = h.client.enable();
    await settle();
    expect(h.snapshots).toHaveLength(1);
    await h.client.disable();
    await work;
    h.session = { ...h.session, id: id(2) };
    h.commands = [];
    await h.client.enable();
    gate.resolve({ locked: false });
    await settle();
    await h.client.flush();
    expect(h.calls.at(-1)!.body.results).toEqual([]);
});

test('malformed, expired, future, long-lived, untargeted and extensible command envelopes are inert', async () => {
    const h = harness();
    h.commands = [
        null, 'eval(secret)', h.command(10, { kind: 'eval' }),
        h.command(11, { id: '../../private' }), h.command(12, { target: id(999) }),
        h.command(13, { issuedAt: time - 60_000, expiresAt: time + 1 }),
        h.command(14, { issuedAt: time + 1 }), h.command(15, { expiresAt: time }),
        h.command(16, { code: 'arbitrary()' }), h.command(17, { target: null }),
        h.command(18, { expiresAt: Infinity }), h.command(19, { issuedAt: 'now' }),
        Object.defineProperty(h.command(20), 'kind', { get() { throw new Error('secret'); } }),
        Object.defineProperty(h.command(21), 'target', { get() { throw new Error('secret'); } })
    ];
    await h.client.enable();
    expect(h.snapshots).toEqual([]);
    await h.client.flush();
    expect(h.calls.at(-1)!.body.results).toEqual([]);
});

test('all three fixed command kinds execute, targeting the document or omitting target', async () => {
    const h = harness();
    await h.client.enable();
    const client = h.calls[1].body.client;
    h.commands = [h.command(10, { target: client }), h.command(11, { kind: 'ping' }), h.command(12, { kind: 'receiver-check' })];
    await h.client.flush();
    expect(h.snapshots).toEqual(['snapshot', 'ping', 'receiver-check']);
    h.commands = [];
    await h.client.flush();
    expect(h.calls.at(-1)!.body.results.map((result: any) => result.status)).toEqual(['ok', 'ok', 'ok']);
});

test('duplicate command IDs execute the handler once across exchanges and concurrent flushes', async () => {
    const h = harness();
    const gate = deferred<DiagnosticData>();
    h.snapshot = () => gate.promise;
    h.commands = [h.command(), h.command(), h.command(10, { id: id(10).toUpperCase() })];
    const enabling = h.client.enable();
    await settle();
    const flushing = h.client.flush();
    await settle();
    expect(h.snapshots).toHaveLength(1);
    gate.resolve({ locked: true });
    await Promise.all([enabling, flushing]);
    await h.client.flush();
    await h.client.flush();
    expect(h.snapshots).toHaveLength(1);
});

test('duplicate IDs remain inert if shared storage switches away and back to the same live session', async () => {
    const h = harness();
    h.commands = [h.command()];
    await h.client.enable();
    const original = h.stored!;
    h.stored = { ...original, id: id(2) };
    await h.client.refresh();
    h.stored = original;
    await h.client.refresh();
    expect(h.snapshots).toHaveLength(2); // Once for each session, never twice for the original.
});

test('the callback deadline produces a fixed failed result and ignores late callback data', async () => {
    const h = harness();
    const gate = deferred<DiagnosticData>();
    h.commands = [h.command()];
    h.snapshot = () => gate.promise;
    const work = h.client.enable();
    await settle();
    await advance(8000);
    await work;
    h.commands = [];
    await h.client.flush();
    expect(h.calls.at(-1)!.body.results).toEqual([
        { id: id(10), kind: 'snapshot', status: 'failed', data: { reason: 'timeout' } }
    ]);
    gate.resolve({ locked: false });
    await settle();
    await h.client.flush();
    expect(h.calls.at(-1)!.body.results).toEqual([]);
});

test('commands are revalidated immediately before their callback after an earlier callback waits', async () => {
    const h = harness();
    const gate = deferred<DiagnosticData>();
    h.commands = [h.command(), h.command(11, { expiresAt: time + 500 })];
    h.snapshot = () => gate.promise;
    const work = h.client.enable();
    await settle();
    await advance(1000);
    gate.resolve({ locked: true });
    await work;
    expect(h.snapshots).toHaveLength(1);
});

test('callback exceptions never expose error text or arbitrary snapshot fields', async () => {
    const h = harness();
    h.commands = [h.command(), h.command(11)];
    let count = 0;
    h.snapshot = () => {
        if (!count++) throw new Error('private password');
        return { locked: true, password: 'private password', layer: 'worker', event: 'discovery-reply' } as DiagnosticData;
    };
    await h.client.enable();
    h.commands = [];
    await h.client.flush();
    expect(h.calls.at(-1)!.body.results).toEqual([
        { id: id(10), kind: 'snapshot', status: 'failed', data: { reason: 'other' } },
        { id: id(11), kind: 'snapshot', status: 'ok', data: { locked: true, layer: 'worker', event: 'discovery-reply' } }
    ]);
    expect(JSON.stringify(h.calls.at(-1)!.body)).not.toMatch(/password|private/);
});

test('event queues retain at most 32 recent sanitized events with monotonically increasing sequence', async () => {
    const h = harness();
    await h.client.enable();
    for (let n = 0; n < 50; n++) h.client.record('transport.event', {
        elapsedMs: n, layer: 'worker', event: 'discovery-timeout', password: 'private'
    } as DiagnosticData);
    h.client.record('unknown' as any, { locked: true });
    await h.client.flush();
    const body = h.calls.at(-1)!.body;
    expect(body.events).toHaveLength(32);
    expect(body.events[0].seq).toBe(20);
    expect(body.events[31].seq).toBe(51);
    expect(body.events[0].data).toEqual({ elapsedMs: 18, layer: 'worker', event: 'discovery-timeout' });
    expect(JSON.stringify(body)).not.toMatch(/password|private|unknown/);
});

test('oversize or malformed exchange envelopes cannot execute commands', async () => {
    const h = harness();
    h.commands = Array.from({ length: 33 }, (_, n) => h.command(n + 10));
    await h.client.enable();
    expect(h.client.state.error).toBe('invalid-response');
    expect(h.snapshots).toHaveLength(0);
    h.exchange = () => ({ commands: [h.command()], expiresAt: time + HOUR, script: 'secret()' });
    await h.client.flush();
    expect(h.snapshots).toHaveLength(0);
    expect(h.client.state.error).toBe('invalid-response');
});

test('a full command response and result payload are bounded to 32', async () => {
    const h = harness();
    h.commands = Array.from({ length: 32 }, (_, n) => h.command(n + 10));
    await h.client.enable();
    expect(h.snapshots).toHaveLength(32);
    h.commands = [];
    await h.client.flush();
    expect(h.calls.at(-1)!.body.results).toHaveLength(32);
    await h.client.flush();
    expect(h.calls.at(-1)!.body.results).toHaveLength(0);
});

test('mixed exchanges prioritize results and fit 32 combined entries while retaining excess events', async () => {
    const h = harness();
    h.commands = [h.command()];
    await h.client.enable();
    h.commands = [];
    for (let n = 0; n < 32; n++) h.client.record('transport.event', { elapsedMs: n });
    h.exchange = () => {
        const body = h.calls.at(-1)!.body;
        if (body.events.length + body.results.length > 32) throw new Error('400');
        return { commands: [], expiresAt: h.session.expiresAt };
    };
    await h.client.flush();
    const mixed = h.calls.at(-1)!.body;
    expect(mixed.results).toHaveLength(1);
    expect(mixed.events).toHaveLength(31);
    expect(h.client.state.status).toBe('connected');
    await h.client.flush();
    const rest = h.calls.at(-1)!.body;
    expect(rest.results).toHaveLength(0);
    expect(rest.events).toHaveLength(1);
    expect([...mixed.events, ...rest.events].map((event: any) => event.data.elapsedMs)).toEqual(
        Array.from({ length: 32 }, (_, n) => n)
    );
});

test('32 pending results leave all 32 events queued for the following exchange', async () => {
    const h = harness();
    h.commands = Array.from({ length: 32 }, (_, n) => h.command(n + 10));
    await h.client.enable();
    h.commands = [];
    for (let n = 0; n < 32; n++) h.client.record('page.visible', { elapsedMs: n });
    await h.client.flush();
    expect(h.calls.at(-1)!.body.results).toHaveLength(32);
    expect(h.calls.at(-1)!.body.events).toHaveLength(0);
    await h.client.flush();
    expect(h.calls.at(-1)!.body.results).toHaveLength(0);
    expect(h.calls.at(-1)!.body.events).toHaveLength(32);
});

test('network deadlines abort ignored signals after eight seconds and stop automatic polling', async () => {
    const h = harness();
    h.exchange = () => new Promise(() => {});
    const work = h.client.enable();
    await settle();
    expect(h.client.state.status).toBe('sending');
    await advance(7999);
    expect(h.client.state.status).toBe('sending');
    await advance(1);
    await work;
    expect(h.calls.at(-1)!.signal.aborted).toBe(true);
    expect(h.client.state).toMatchObject({ enabled: true, status: 'offline', error: 'timeout' });
    await advance(30_000);
    expect(h.calls).toHaveLength(2);
    h.exchange = () => ({ commands: [], expiresAt: h.session.expiresAt });
    await h.client.flush();
    expect(h.client.state.status).toBe('connected');
});

test('creation has the same eight second deadline and never enables on timeout', async () => {
    const h = harness();
    h.create = () => new Promise(() => {});
    const work = h.client.enable();
    await settle();
    await advance(8000);
    await work;
    expect(h.client.state).toMatchObject({ enabled: false, error: 'timeout' });
    expect(h.saved).toEqual([]);
});

test('polls every five seconds while connected and stops on explicit offline state', async () => {
    const h = harness();
    await h.client.enable();
    await advance(4999);
    expect(h.calls).toHaveLength(2);
    await advance(1);
    expect(h.calls).toHaveLength(3);
    h.client.setOnline(false);
    await advance(20_000);
    expect(h.calls).toHaveLength(3);
    expect(h.client.state.status).toBe('offline');
    h.client.setOnline(true);
    await settle();
    expect(h.calls).toHaveLength(4);
    expect(h.client.state.status).toBe('connected');
});

test('an offline client neither creates sessions nor sends exchanges until connectivity returns', async () => {
    const h = harness();
    h.client.setOnline(false);
    await h.client.enable();
    expect(h.calls).toHaveLength(0);
    h.stored = h.session;
    await h.client.refresh();
    await h.client.flush();
    expect(h.calls).toHaveLength(0);
    expect(h.client.state).toMatchObject({ enabled: true, status: 'offline' });
    h.client.setOnline(true);
    await settle();
    expect(h.calls).toHaveLength(1);
});

test('going offline aborts a pending exchange and ignores late commands before reconnection', async () => {
    const h = harness();
    await h.client.enable();
    const gate = deferred<unknown>();
    h.exchange = () => gate.promise;
    const work = h.client.flush();
    await settle();
    const request = h.calls.at(-1)!;
    h.client.setOnline(false);
    gate.resolve({ commands: [h.command()], expiresAt: time + HOUR });
    await work;
    expect(request.signal.aborted).toBe(true);
    expect(h.snapshots).toHaveLength(0);
    await advance(10_000);
    expect(h.calls).toHaveLength(3);
    h.exchange = () => ({ commands: [], expiresAt: time + HOUR });
    h.client.setOnline(true);
    await settle();
    expect(h.client.state.status).toBe('connected');
    expect(h.calls).toHaveLength(4);
});

test('network errors are fixed codes, retries preserve bounded sanitized events', async () => {
    const h = harness();
    await h.client.enable();
    h.client.record('connect.error', { reason: 'unavailable' });
    h.exchange = () => { throw new Error('password=https://private'); };
    await h.client.flush();
    expect(h.client.state.error).toBe('network');
    h.exchange = () => ({ commands: [], expiresAt: time + HOUR });
    await h.client.flush();
    expect(h.calls.at(-1)!.body.events.map((event: any) => event.code)).toEqual(['connect.error']);
    expect(JSON.stringify(h.states)).not.toMatch(/password|https|private/);
});

test('expiry aborts work, drops queues, and forbids commands and polling', async () => {
    const h = harness();
    h.session = { ...h.session, expiresAt: time + 1000 };
    await h.client.enable();
    const gate = deferred<unknown>();
    h.exchange = () => gate.promise;
    h.client.record('page.visible');
    const work = h.client.flush();
    await settle();
    await advance(1000);
    expect(h.calls.at(-1)!.signal.aborted).toBe(true);
    gate.resolve({ commands: [h.command()], expiresAt: time + HOUR });
    await work;
    expect(h.client.state).toMatchObject({ enabled: false, status: 'off', error: 'expired' });
    expect(h.snapshots).toEqual([]);
    await advance(HOUR);
    expect(h.calls).toHaveLength(3);
});

test('server expiry can shorten but cannot extend or revive the original local grant', async () => {
    const h = harness();
    h.exchange = () => ({ commands: [], expiresAt: time + 1000 });
    await h.client.enable();
    expect(h.client.state.expiresAt).toBe(time + 1000);
    h.exchange = () => ({ commands: [], expiresAt: time + HOUR });
    await h.client.flush();
    expect(h.client.state.expiresAt).toBe(time + 1000);
    await advance(1000);
    await h.client.refresh();
    expect(h.client.state.enabled).toBe(false);
    expect(h.calls).toHaveLength(3);
});

test('expired response sessions do not execute otherwise valid commands', async () => {
    const h = harness();
    h.exchange = () => ({ commands: [h.command()], expiresAt: time });
    await h.client.enable();
    expect(h.client.state).toMatchObject({ enabled: false, error: 'expired' });
    expect(h.snapshots).toHaveLength(0);
});

test('a full hour ends the grant even when every server reply tries to extend it', async () => {
    const h = harness();
    h.exchange = () => ({ commands: [], expiresAt: time + HOUR });
    await h.client.enable();
    await advance(HOUR - 1);
    expect(h.client.state.enabled).toBe(true);
    await advance(1);
    expect(h.client.state).toMatchObject({ enabled: false, error: 'expired' });
    await h.client.refresh();
    expect(h.client.state.enabled).toBe(false);
});

test('failed shared-store reads stop an active client and abort its pending exchange', async () => {
    let fail = false;
    let stored: DiagnosticSession | undefined;
    const h = harness({ store: {
        async load() { if (fail) throw new Error('secret'); return stored; },
        async save(value) { stored = value; }
    } });
    await h.client.enable();
    h.exchange = () => new Promise(() => {});
    const work = h.client.flush();
    await settle();
    fail = true;
    await h.client.refresh();
    await work;
    expect(h.client.state).toMatchObject({ enabled: false, error: 'storage' });
    expect(h.calls.at(-1)!.signal.aborted).toBe(true);
});

test('failed disable persistence keeps this document disabled even if storage retains the old session', async () => {
    let stored: DiagnosticSession | undefined;
    const h = harness({ store: {
        async load() { return stored; },
        async save(value) { if (!value) throw new Error('secret'); stored = value; }
    } });
    await h.client.enable();
    await h.client.disable();
    expect(h.client.state).toMatchObject({ enabled: false, error: 'storage' });
    await h.client.refresh();
    expect(h.client.state.enabled).toBe(false);
    expect(h.calls).toHaveLength(2);
});

test('dispose aborts pending work and clears local state without clearing shared consent or notifying again', async () => {
    const h = harness();
    await h.client.enable();
    h.exchange = () => new Promise(() => {});
    const work = h.client.flush();
    await settle();
    const notifications = h.states.length;
    h.client.dispose();
    await work;
    expect(h.calls.at(-1)!.signal.aborted).toBe(true);
    expect(h.client.state).toEqual({ enabled: false, status: 'off' });
    expect(h.stored).toBeDefined();
    await h.client.enable();
    await h.client.refresh();
    await h.client.disable();
    h.client.record('app.locked');
    await advance(HOUR);
    expect(h.states).toHaveLength(notifications);
    expect(h.saved).toHaveLength(1);
});

test('state snapshots cannot mutate consent or expiry, and observer failures are isolated', async () => {
    const h = harness({ onChange() { throw new Error('private'); } });
    await h.client.enable();
    const state = h.client.state;
    state.enabled = false;
    state.expiresAt = 0;
    expect(h.client.state.enabled).toBe(true);
    expect(h.client.state.expiresAt).toBe(time + HOUR);
});

test('an observer disabling at activation prevents all collection callbacks and exchanges', async () => {
    let client!: DiagnosticClient;
    const h = harness({ onChange(state) { if (state.enabled) void client.disable(); } });
    client = h.client;
    h.commands = [h.command()];
    await client.enable();
    await settle();
    expect(client.state.enabled).toBe(false);
    expect(h.snapshots).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
    expect(h.stored).toBeUndefined();
});
