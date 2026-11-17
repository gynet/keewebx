import { afterEach, expect, test } from 'bun:test';
import { sign } from 'tweetnacl';

const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(name: string, value: unknown) {
    if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
replace('addEventListener', () => {});
const { NativeRpc, prepareDirect, openDirect } = await import('../src/native-connect');
const stable = (value: any): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
let rpc: any, link: any;
afterEach(() => {
    try { rpc?.dispose(); link?.dispose(); }
    finally {
        rpc = link = undefined;
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete (globalThis as any)[name];
        }
        originals.clear();
    }
});

async function fixture(failInitial = false, wireReceipt = false) {
    const endpoint = new URL('https://keewebx.app/app?retry=' + crypto.randomUUID()), keys = sign.keyPair();
    const route = { host: crypto.randomUUID(), owner: crypto.randomUUID(), endpoint: endpoint.href,
        publicKey: Buffer.from(keys.publicKey).toString('base64'), messagePort: 1, ...(wireReceipt ? { wireReceipt: 1 } : {}) };
    replace('addEventListener', () => {}); replace('removeEventListener', () => {});
    replace('location', { href: 'https://login.example.org/login', origin: 'https://login.example.org' });
    replace('window', { open: () => ({ close() {} }) });
    replace('GM', { async getValue(key: string) { return key.includes(':selected:') ? route : {
        publicKey: route.publicKey, secretKey: Buffer.from(keys.secretKey).toString('base64') }; } });
    await prepareDirect(endpoint);
    let now = Date.now(), next = 0, failSend = failInitial;
    const timers = new Map<number, { callback: () => void; due: number; repeat: number }>();
    const NativeDate = Date;
    replace('Date', class extends NativeDate { static now() { return now; } });
    const schedule = (callback: () => void, ms: number, repeat: number) => {
        const id = ++next; timers.set(id, { callback, due: now + ms, repeat }); return id;
    };
    replace('setTimeout', (callback: () => void, ms: number) => schedule(callback, ms, 0));
    replace('setInterval', (callback: () => void, ms: number) => schedule(callback, ms, ms));
    replace('clearTimeout', (id: number) => timers.delete(id));
    replace('clearInterval', (id: number) => timers.delete(id));
    const sent: any[] = [];
    class Port {
        onmessage?: (event: { data: any }) => void;
        start() {} close() {}
        postMessage(data: any) {
            if (data.kind === 'request') {
                if (failSend) throw new Error('Injected send failure');
                sent.push(structuredClone(data.value));
            }
        }
    }
    let port: Port;
    replace('MessageChannel', class { port1 = port = new Port(); port2 = new Port(); });
    openDirect(endpoint);
    rpc = new NativeRpc(endpoint, () => undefined);
    const outcome = rpc.connect().then(() => undefined, (error: Error) => error);
    link = rpc.direct;
    const outer = { marker: 'keewebx-connect-port-v1', connectionId: link.id, appBoot: route.host,
        endpoint: endpoint.href, siteOrigin: location.origin };
    port!.onmessage!({ data: { ...outer, kind: 'ready' } });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    return {
        sent, timers, outcome, fail() { failSend = true; },
        tick(ms: number) {
            const until = now + ms;
            for (;;) {
                const entry = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
                if (!entry || entry[1].due > until) break;
                const [id, timer] = entry; now = timer.due;
                if (timer.repeat) timer.due += timer.repeat; else timers.delete(id);
                timer.callback();
            }
            now = until;
        },
        reply(error?: string) {
            const request = sent.at(-1).packet;
            const packet = { ...request, type: 'reply', error,
                body: { scope: crypto.randomUUID(), appBoot: route.host, expiresAt: now + 120000 } };
            const signature = Buffer.from(sign.detached(new TextEncoder().encode(stable(packet)), keys.secretKey)).toString('base64');
            port!.onmessage!({ data: { ...outer, kind: 'reply', value: { packet, signature } } });
        }
    };
}

test.each(['reply', 'error reply', 'cancel', 'reset', 'timeout', 'send error', 'initial error', 'navigation', 'generation'])
('direct hello retries stop on %s without changing the signed request or deadline', async scenario => {
    const f = await fixture(scenario === 'initial error');
    if (scenario !== 'initial error') {
        expect(f.sent).toHaveLength(1);
        f.tick(750);
        expect(f.sent).toHaveLength(2);
        expect(f.sent[1]).toEqual(f.sent[0]);
        if (scenario === 'reply') f.reply();
        else if (scenario === 'error reply') f.reply('KeeWebX is locked.');
        else if (scenario === 'cancel') rpc.dispose();
        else if (scenario === 'reset') link.reset();
        else if (scenario === 'timeout') f.tick(7250);
        else {
            if (scenario === 'send error') f.fail();
            if (scenario === 'navigation') (globalThis as any).location.href += '#changed';
            if (scenario === 'generation') link.generation++;
            f.tick(750);
        }
    }
    const error = await f.outcome;
    if (scenario === 'reply') expect(error).toBeUndefined(); else expect(error).toBeInstanceOf(Error);
    expect(rpc.pending.size).toBe(0);
    expect(f.timers.size).toBe(0);
    for (const request of f.sent) expect(request).toEqual(f.sent[0]);
    const count = f.sent.length;
    f.tick(10000);
    expect(f.sent).toHaveLength(count);
});

test('direct wire requests are sent once and never acquire a retry interval', async () => {
    const f = await fixture(); f.reply(); await f.outcome;
    const result = rpc.call('wire', { action: 'kwx-get-entry-fields' });
    const count = f.sent.length;
    expect([...f.timers.values()].filter(timer => timer.repeat)).toHaveLength(0);
    f.tick(1500);
    expect(f.sent).toHaveLength(count);
    f.reply(); await result;
    expect(f.timers.size).toBe(0);
});

test.each(['reply', 'cancel', 'reset', 'timeout', 'send error', 'navigation'])
('capable wire retries preserve the signed request and stop on %s', async scenario => {
    const f = await fixture(false, true); f.reply(); await f.outcome;
    const result = rpc.call('wire', { action: 'kwx-get-entry-fields', message: 'encrypted request', nonce: 'fixture nonce' })
        .then(() => undefined, (error: Error) => error);
    const first = f.sent.at(-1), before = f.sent.length;
    f.tick(750);
    expect(f.sent).toHaveLength(before + 1);
    expect(f.sent.at(-1)).toEqual(first);
    if (scenario === 'reply') f.reply();
    else if (scenario === 'cancel') rpc.dispose();
    else if (scenario === 'reset') link.reset();
    else if (scenario === 'timeout') f.tick(15000);
    else {
        if (scenario === 'send error') f.fail();
        else (globalThis as any).location.href += '#changed';
        f.tick(750);
    }
    const error = await result;
    if (scenario === 'reply') expect(error).toBeUndefined(); else expect(error).toBeInstanceOf(Error);
    expect(rpc.pending.size).toBe(0); expect(f.timers.size).toBe(0);
    const count = f.sent.length; f.tick(20000); expect(f.sent).toHaveLength(count);
});
