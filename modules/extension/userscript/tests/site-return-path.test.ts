import { afterEach, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { sign } from 'tweetnacl';
import { signPortReady } from '../src/port-auth';

const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(name: string, value: unknown) {
    if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
replace('addEventListener', () => {});
const { NativeRpc, prepareDirect, openDirect } = await import('../src/native-connect');
const MARK = 'keewebx-connect-port-v1';
const stable = (value: any): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
const flush = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };
const cleanup: Array<() => void> = [];
afterEach(() => {
    try { for (const dispose of cleanup.splice(0).reverse()) dispose(); }
    finally {
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete (globalThis as any)[name];
        }
        originals.clear();
    }
});

async function fixture(proof: 'valid' | 'legacy' | 'invalid' = 'valid', failInitialSend = false,
    timing: { budgetMs?: number; readyAfterMs?: number } = {}) {
    const endpoint = new URL('https://keewebx.app/app?return-path=' + crypto.randomUUID()), keys = sign.keyPair();
    const route = { host: crypto.randomUUID(), owner: crypto.randomUUID(), endpoint: endpoint.href,
        publicKey: Buffer.from(keys.publicKey).toString('base64'), messagePort: 1, ...(proof === 'legacy' ? {} : { readyProof: 1 }) };
    replace('addEventListener', () => {}); replace('removeEventListener', () => {});
    replace('location', { href: 'https://login.example.org/login', origin: 'https://login.example.org' });
    let helperOpens = 0;
    replace('window', { open() { helperOpens++; return { closed: false, close() { this.closed = true; }, postMessage() {} }; } });
    replace('GM', { async getValue(key: string) { return structuredClone(key.includes(':selected:') ? route : {
        publicKey: route.publicKey, secretKey: Buffer.from(keys.secretKey).toString('base64') }); } });
    await prepareDirect(endpoint);

    const NativeDate = Date;
    let now = Date.now(), nextTimer = 0;
    const timers = new Map<number, { callback: () => void; due: number; repeat: number }>();
    replace('Date', class extends NativeDate { static now() { return now; } });
    const schedule = (callback: () => void, ms: number, repeat: number) => {
        const id = ++nextTimer; timers.set(id, { callback, due: now + ms, repeat }); return id;
    };
    replace('setTimeout', (callback: () => void, ms: number) => schedule(callback, ms, 0));
    replace('setInterval', (callback: () => void, ms: number) => schedule(callback, ms, ms));
    replace('clearTimeout', (id: number) => timers.delete(id));
    replace('clearInterval', (id: number) => timers.delete(id));
    const sent: any[] = [];
    let failSend = failInitialSend;
    class Port {
        onmessage?: (event: { data: any }) => void;
        onmessageerror?: () => void;
        closed = false;
        start() {}
        close() { this.closed = true; }
        postMessage(data: any) {
            if (data.kind === 'request') {
                if (failSend) throw new Error('Injected port send failure');
                sent.push(structuredClone(data.value));
            }
        }
    }
    let port!: Port;
    replace('MessageChannel', class { port1 = port = new Port(); port2 = new Port(); });
    openDirect(endpoint);
    const clients: any[] = [];
    const start = async () => {
        const rpc: any = new NativeRpc(endpoint, () => undefined);
        clients.push(rpc);
        const startedAt = Date.now();
        const outcome = rpc.connect(timing.budgetMs === undefined ? undefined : startedAt + timing.budgetMs)
            .then(() => undefined, (error: Error) => error);
        await flush();
        return { rpc, outcome, startedAt };
    };
    const initial = await start(), link = initial.rpc.direct;
    cleanup.push(() => { for (const rpc of clients) rpc.dispose(); link.dispose(); });
    const outer = { marker: MARK, connectionId: link.id, appBoot: route.host, endpoint: endpoint.href, siteOrigin: location.origin };
    const ready = { ...outer, kind: 'ready' };
    now += timing.readyAfterMs ?? 0;
    port.onmessage!({ data: { ...ready, ...(proof === 'legacy' ? {} : {
        proof: signPortReady(ready, (proof === 'invalid' ? sign.keyPair() : keys).secretKey)
    }) } });
    await flush();
    const envelope = (request: any = sent.at(-1)?.packet, patch: any = {}) => {
        const packet = { ...request, type: 'reply', body: { scope: crypto.randomUUID(), appBoot: route.host, expiresAt: now + 120000 }, ...patch };
        return { packet, signature: Buffer.from(sign.detached(new TextEncoder().encode(stable(packet)), keys.secretKey)).toString('base64') };
    };
    const deliver = (value: any, patch: any = {}) => port.onmessage!({ data: { ...outer, kind: 'reply', value, ...patch } });
    return {
        ...initial, endpoint, route, keys, port, link, sent, timers, start, envelope, deliver,
        failSend() { failSend = true; },
        helperOpens: () => helperOpens,
        jump(ms: number) { now += ms; },
        advance(ms: number) {
            const until = now + ms;
            for (;;) {
                const entry = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
                if (!entry || entry[1].due > until) break;
                const [id, timer] = entry; now = Math.max(now, timer.due);
                if (timer.repeat) timer.due = now + timer.repeat; else timers.delete(id);
                timer.callback();
            }
            now = until;
        }
    };
}

test.each(['timer first', 'expired reply first'])('a suspended first hello automatically retries once on its proven port (%s)', async order => {
    const f = await fixture(), generation = f.link.generation, request = f.sent[0];
    const cached = f.envelope(request.packet);
    if (order === 'timer first') f.advance(10500);
    else { f.jump(10500); f.deliver(cached); }
    await flush();
    expect(f.rpc.pending.size).toBe(1); expect(f.rpc.scope).toBeUndefined();
    expect(f.port.closed).toBe(false); expect(f.link.generation).toBe(generation);
    const fresh = f.sent.at(-1);
    expect(new Set(f.sent.map(value => value.packet.id)).size).toBe(2);
    expect(fresh.packet.id).not.toBe(request.packet.id);
    expect(fresh.packet.document).toBe(request.packet.document);
    expect(fresh.packet.scope).toBeUndefined();
    expect(fresh.packet.deadline).toBeGreaterThan(request.packet.deadline);
    expect(fresh.signature).not.toBe(request.signature);
    expect(sign.detached.verify(new TextEncoder().encode(stable(fresh.packet)), Buffer.from(fresh.signature, 'base64'), f.keys.publicKey)).toBe(true);
    for (const key of ['host', 'endpoint', 'origin', 'operation']) expect(fresh.packet[key]).toBe(request.packet[key]);
    f.deliver(cached); expect(f.rpc.pending.size).toBe(1); expect(f.rpc.scope).toBeUndefined();
    const reply = f.envelope();
    f.deliver(reply); expect(await f.outcome).toBeUndefined();
    expect(f.rpc.scope).toBe(reply.packet.body.scope);
    expect(f.rpc.scope).not.toBe(cached.packet.body.scope);
    expect(f.rpc.pending.size).toBe(0); expect(f.timers.size).toBe(0);
    expect(f.helperOpens()).toBe(1); expect(f.port.closed).toBe(false);
});

test.each([35000, 36000])('an expired reply delivered before timers cannot retry beyond the 35-second budget (%s ms)', async elapsed => {
    const f = await fixture(), cached = f.envelope();
    f.jump(elapsed); f.deliver(cached); await flush();
    expect(await f.outcome).toBeInstanceOf(Error);
    expect(f.sent).toHaveLength(1); expect(f.rpc.scope).toBeUndefined();
    expect(f.rpc.pending.size).toBe(0); expect(f.timers.size).toBe(0);
    expect(f.port.closed).toBe(false); expect(f.helperOpens()).toBe(1);
    f.advance(30000); await flush(); expect(f.sent).toHaveLength(1); expect(f.helperOpens()).toBe(1);
});

test('the default 35-second budget clips the second hello after delayed port readiness', async () => {
    const f = await fixture('valid', false, { readyAfterMs: 24000 }), first = f.sent[0];
    expect(first.packet.deadline).toBe(f.startedAt + 32000);
    f.advance(8000); await flush();
    const second = f.sent.at(-1);
    expect(second.packet.id).not.toBe(first.packet.id);
    expect(second.packet.deadline).toBe(f.startedAt + 35000);
    expect(second.packet.deadline - Date.now()).toBe(3000);
    expect(f.rpc.pending.size).toBe(1); expect(f.port.closed).toBe(false);
    f.advance(3000); expect(await f.outcome).toBeInstanceOf(Error);
    expect(f.rpc.pending.size).toBe(0); expect(f.timers.size).toBe(0); expect(f.port.closed).toBe(true);
    expect(new Set(f.sent.map(value => value.packet.id)).size).toBe(2); expect(f.helperOpens()).toBe(1);
});

test('an explicit 10-second budget clamps the second hello to its remaining two seconds', async () => {
    const f = await fixture('valid', false, { budgetMs: 10000 }), first = f.sent[0];
    expect(first.packet.deadline).toBe(f.startedAt + 8000);
    f.advance(8000); await flush();
    const second = f.sent.at(-1);
    expect(second.packet.id).not.toBe(first.packet.id);
    expect(second.packet.deadline).toBe(f.startedAt + 10000);
    expect(second.packet.deadline - Date.now()).toBe(2000);
    f.deliver(f.envelope(first.packet)); expect(f.rpc.pending.size).toBe(1);
    f.advance(2000); expect(await f.outcome).toBeInstanceOf(Error);
    expect(f.rpc.pending.size).toBe(0); expect(f.timers.size).toBe(0); expect(f.port.closed).toBe(true);
    expect(new Set(f.sent.map(value => value.packet.id)).size).toBe(2); expect(f.helperOpens()).toBe(1);
});

test('two consecutive proven-port hello timeouts close the dead port', async () => {
    const f = await fixture(), generation = f.link.generation;
    f.advance(8000); await flush();
    expect(f.port.closed).toBe(false); expect(f.rpc.pending.size).toBe(1);
    expect(new Set(f.sent.map(value => value.packet.id)).size).toBe(2);
    f.advance(8000); expect(await f.outcome).toBeInstanceOf(Error); f.rpc.dispose();
    expect(f.port.closed).toBe(true); expect(f.link.generation).toBe(generation + 1);
    expect(f.timers.size).toBe(0); expect(f.helperOpens()).toBe(1);
    const count = f.sent.length; f.advance(20000); await flush(); expect(f.sent).toHaveLength(count);
});

test.each(['success', 'signed error'])('a fresh matching signed reply clears the consecutive timeout count (%s)', async reply => {
    const f = await fixture();
    f.advance(8000); await flush();
    f.deliver(f.envelope(undefined, reply === 'signed error' ? { error: 'KeeWebX is locked.' } : {}));
    const result = await f.outcome;
    if (reply === 'success') expect(result).toBeUndefined(); else expect(result).toBeInstanceOf(Error);
    f.rpc.dispose();
    const next = await f.start();
    f.advance(8000); await flush();
    expect(f.port.closed).toBe(false);
    expect(next.rpc.pending.size).toBe(1);
    f.advance(8000); expect(await next.outcome).toBeInstanceOf(Error);
    expect(f.port.closed).toBe(true);
});

test('canceling hello after a verified ready retains only transport, with no session or retry', async () => {
    const f = await fixture(), generation = f.link.generation, canceled = f.envelope();
    f.rpc.dispose(); expect(await f.outcome).toBeInstanceOf(Error);
    expect(f.port.closed).toBe(false); expect(f.link.generation).toBe(generation);
    expect(f.timers.size).toBe(0); expect(f.rpc.scope).toBeUndefined();
    const count = f.sent.length; f.advance(20000); expect(f.sent).toHaveLength(count);
    const next = await f.start(); f.deliver(canceled); expect(next.rpc.pending.size).toBe(1);
    f.deliver(f.envelope()); expect(await next.outcome).toBeUndefined(); expect(f.helperOpens()).toBe(1);
});

test.each(['before retry continuation', 'during second hello'])('canceling hello prevents further recovery (%s)', async phase => {
    const f = await fixture(), cached = f.envelope();
    f.advance(8000);
    if (phase === 'during second hello') await flush();
    f.rpc.dispose(); expect(await f.outcome).toBeInstanceOf(Error);
    const count = f.sent.length;
    expect(new Set(f.sent.map(value => value.packet.id)).size).toBe(phase === 'during second hello' ? 2 : 1);
    expect(f.rpc.pending.size).toBe(0); expect(f.rpc.scope).toBeUndefined(); expect(f.timers.size).toBe(0);
    f.deliver(cached); f.advance(30000); await flush();
    expect(f.sent).toHaveLength(count); expect(f.port.closed).toBe(false); expect(f.helperOpens()).toBe(1);
});

test.each(['The KeeWebX request timed out. Try Find accounts again.', 'The reply expired. Retry.', 'KeeWebX is locked.'])
('a signed server error never becomes an automatic hello retry: %s', async error => {
    const f = await fixture();
    f.deliver(f.envelope(undefined, { error }));
    expect((await f.outcome)?.message).toBe(error);
    const count = f.sent.length; f.advance(30000); await flush();
    expect(f.sent).toHaveLength(count); expect(count).toBe(1);
    expect(f.rpc.scope).toBeUndefined(); expect(f.rpc.pending.size).toBe(0); expect(f.timers.size).toBe(0);
    expect(f.helperOpens()).toBe(1);
});

test('wire timeout retains the proven port without a fresh hello or a repeated field request', async () => {
    const f = await fixture(); f.deliver(f.envelope()); expect(await f.outcome).toBeUndefined();
    const outcome = f.rpc.call('wire', { action: 'kwx-get-entry-fields' }, 1000)
        .then(() => undefined, (error: Error) => error);
    const count = f.sent.length;
    f.advance(1000); expect(await outcome).toBeInstanceOf(Error); await flush();
    expect(f.sent.filter(value => value.packet.operation === 'wire')).toHaveLength(1);
    expect(f.sent.filter(value => value.packet.operation === 'hello')).toHaveLength(1);
    expect(f.port.closed).toBe(false); expect(f.rpc.pending.size).toBe(0); expect(f.timers.size).toBe(0);
    f.advance(30000); await flush(); expect(f.sent).toHaveLength(count); expect(f.helperOpens()).toBe(1);
});

test.each(['cancel', 'timeout', 'invalid RPC signature'])('legacy ready alone cannot preserve a failed hello (%s)', async failure => {
    const f = await fixture('legacy');
    if (failure === 'invalid RPC signature') f.deliver({ ...f.envelope(), signature: 'invalid' });
    if (failure === 'cancel') f.rpc.dispose(); else f.advance(8000);
    expect(await f.outcome).toBeInstanceOf(Error); f.rpc.dispose();
    expect(f.port.closed).toBe(true); expect(f.timers.size).toBe(0);
});

test('a forged ready proof never sends hello or retains the port', async () => {
    const f = await fixture('invalid');
    expect(await f.outcome).toBeInstanceOf(Error); f.rpc.dispose();
    expect(f.sent).toHaveLength(0); expect(f.port.closed).toBe(true); expect(f.timers.size).toBe(0);
});

test.each(['initial', 'retry'])('a proven port still resets on a send error (%s)', async phase => {
    const f = await fixture('valid', phase === 'initial');
    if (phase === 'retry') { f.failSend(); f.advance(750); }
    expect(await f.outcome).toBeInstanceOf(Error); f.rpc.dispose();
    expect(f.port.closed).toBe(true); expect(f.timers.size).toBe(0);
});

test.each(['signature', 'outer connection', 'outer host', 'outer endpoint', 'outer origin', 'id', 'scope', 'document', 'host', 'endpoint', 'origin', 'operation', 'deadline'])
('a rejected %s cannot reset the timeout count', async field => {
    const f = await fixture();
    f.advance(8000); await flush();
    const patch: any = {}, outer: any = {};
    if (field.startsWith('outer ')) {
        const key = { connection: 'connectionId', host: 'appBoot', endpoint: 'endpoint', origin: 'siteOrigin' }[field.slice(6)]!;
        outer[key] = 'different';
    } else if (field !== 'signature') patch[field] = field === 'deadline' ? f.sent.at(-1).packet.deadline + 1 : 'different';
    const value = f.envelope(undefined, patch);
    if (field === 'signature') value.signature = 'invalid';
    f.deliver(value, outer); expect(f.rpc.pending.size).toBe(1);
    f.advance(8000); expect(await f.outcome).toBeInstanceOf(Error);
    expect(f.port.closed).toBe(true); expect(f.timers.size).toBe(0);
});

test.each(['navigation', 'authorization ended', 'port error', 'decode error', 'public key changed', 'App changed'])
('a proven port still resets immediately on %s', async reason => {
    const f = await fixture();
    if (reason === 'navigation') { (globalThis as any).location.href += '#changed'; f.rpc.dispose(); }
    else if (reason === 'port error') f.port.onmessage!({ data: { marker: MARK, kind: 'error', message: 'Unavailable' } });
    else if (reason === 'decode error') f.port.onmessageerror!();
    else if (reason === 'authorization ended') f.port.onmessage!({ data: { marker: MARK, kind: 'closed', connectionId: f.link.id,
        appBoot: f.route.host, endpoint: f.endpoint.href, siteOrigin: location.origin, reason: 'authorization-ended' } });
    else f.link.configure({ ...f.route, ...(reason === 'App changed' ? { host: crypto.randomUUID() } : {
        publicKey: Buffer.from(sign.keyPair().publicKey).toString('base64') }) });
    expect(await f.outcome).toBeInstanceOf(Error); expect(f.port.closed).toBe(true); expect(f.timers.size).toBe(0);
});

test('a JSON-serialized foreign-realm signed hello keeps outer request scope and accepts body scope', async () => {
    const f = await fixture(), reply = f.envelope();
    const data = runInNewContext('JSON.parse(serialized)', { serialized: JSON.stringify(reply) });
    expect(Object.getPrototypeOf(data)).not.toBe(Object.prototype);
    expect(data.packet.scope).toBeUndefined();
    f.deliver(data); expect(await f.outcome).toBeUndefined();
    expect(f.rpc.scope).toBe(reply.packet.body.scope); expect(f.timers.size).toBe(0);
});
