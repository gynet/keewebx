import { afterEach, expect, test } from 'bun:test';
import { sign } from 'tweetnacl';
import { signPortReady } from '../src/port-auth';

const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(name: string, value: unknown) {
    if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
replace('addEventListener', () => {});
const { NativeRpc, prepareDirect, openDirect, directCredentials } = await import('../src/native-connect');
const stable = (value: any): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
const flush = async () => { for (let turn = 0; turn < 25; turn++) await Promise.resolve(); };
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

// Real NativeRpc and SitePortLink validation with signed ready/hello/wire
// envelopes. Only the manager, clock and message delivery are controlled.
async function fixture({ mailbox = false, ready = true, allowAppVisit = false } = {}) {
    const endpoint = new URL('https://keewebx.app/app?foreground=' + crypto.randomUUID()), keys = sign.keyPair();
    const route = { host: crypto.randomUUID(), owner: crypto.randomUUID(), endpoint: endpoint.href,
        publicKey: Buffer.from(keys.publicKey).toString('base64'), messagePort: 1, readyProof: 1, mailbox };
    let saved: any = route, blocked = false, reads = 0;
    replace('addEventListener', () => {}); replace('removeEventListener', () => {});
    replace('location', { href: 'https://login.example.org/login', origin: 'https://login.example.org' });
    let helpers = 0;
    replace('window', { open: () => { helpers++; return { closed: false, close() {}, postMessage() {} }; } });
    const website = Object.assign(new EventTarget(), { hidden: false });
    if (allowAppVisit) replace('document', website);
    const stored = new Map<string, any>();
    replace('GM', {
        async getValue(key: string) {
            reads++;
            if (blocked) return new Promise(() => {});
            if (key.startsWith('keewebx-connect-mailbox')) return stored.get(key);
            return key.includes(':selected:') ? saved : {
                publicKey: route.publicKey, secretKey: Buffer.from(keys.secretKey).toString('base64') };
        },
        async setValue(key: string, value: any) { stored.set(key, structuredClone(value)); },
        async deleteValue(key: string) { stored.delete(key); }
    });
    await prepareDirect(endpoint);
    let now = Date.now(), next = 0;
    const timers = new Map<number, { callback: () => void; due: number; repeat: number }>();
    const NativeDate = Date;
    replace('Date', class extends NativeDate { static now() { return now; } });
    const schedule = (callback: () => void, ms: number, repeat = 0) => {
        const id = ++next; timers.set(id, { callback, due: now + ms, repeat }); return id;
    };
    replace('setTimeout', (callback: () => void, ms: number) => schedule(callback, ms));
    replace('setInterval', (callback: () => void, ms: number) => schedule(callback, ms, ms));
    replace('clearTimeout', (id: number) => timers.delete(id));
    replace('clearInterval', (id: number) => timers.delete(id));
    const sent: any[] = [];
    class Port {
        onmessage?: (event: { data: any }) => void;
        closed = false;
        start() {} close() { this.closed = true; }
        postMessage(data: any) { if (data.kind === 'request') sent.push(structuredClone(data.value)); }
    }
    let port: Port;
    replace('MessageChannel', class { port1 = port = new Port(); port2 = new Port(); });
    expect(openDirect(endpoint)).toBe(true);
    rpc = new NativeRpc(endpoint, () => undefined);
    const connecting = rpc.connect(undefined, allowAppVisit ? (budgetMs: number) => now + budgetMs : undefined)
        .then(() => undefined, (error: Error) => error);
    link = rpc.direct;
    const outer = { marker: 'keewebx-connect-port-v1', connectionId: link.id, appBoot: route.host,
        endpoint: endpoint.href, siteOrigin: location.origin };
    if (ready) port!.onmessage!({ data: { ...outer, kind: 'ready', proof: signPortReady(outer, keys.secretKey) } });
    await flush();
    const hello = () => ({ scope: crypto.randomUUID(), appBoot: route.host, expiresAt: now + 120000 });
    return {
        endpoint, connecting, port: port!, sent, timers, route, stored, hello, website,
        get helpers() { return helpers; }, get reads() { return reads; }, get now() { return now; },
        block() { blocked = true; }, unblock(value: any = route) { blocked = false; saved = value; },
        replyMailbox() {
            const request = [...stored.entries()].find(([key, value]) =>
                key.startsWith('keewebx-connect-mailbox-v1:request:') && value.packet.operation === 'hello');
            expect(request).toBeDefined();
            const packet = { ...request![1].packet, type: 'reply', body: hello() };
            const signature = Buffer.from(sign.detached(new TextEncoder().encode(stable(packet)), keys.secretKey)).toString('base64');
            stored.set(request![0].replace(':request:', ':reply:'), { packet, signature });
        },
        reply(body: any, mismatch?: 'signature' | 'scope') {
            const packet = { ...sent.at(-1).packet, type: 'reply', body };
            if (mismatch === 'scope') packet.scope = crypto.randomUUID();
            const signature = Buffer.from(sign.detached(new TextEncoder().encode(stable(packet)),
                mismatch === 'signature' ? sign.keyPair().secretKey : keys.secretKey)).toString('base64');
            // Queue before the settings timeout and deliver afterwards.
            return () => port!.onmessage!({ data: { ...outer, kind: 'reply', value: { packet, signature } } });
        },
        revoke() { port!.onmessage!({ data: { ...outer, kind: 'closed', reason: 'authorization-ended' } }); },
        async tick(ms: number) {
            const until = now + ms;
            for (;;) {
                const entry = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
                if (!entry || entry[1].due > until) break;
                const [id, timer] = entry; now = timer.due;
                if (timer.repeat) timer.due += timer.repeat; else timers.delete(id);
                timer.callback(); await flush();
            }
            now = until;
        }
    };
}

test.each(['same grant', 'changed grant', 'expired setup'])('a direct timeout recovers only with the current grant (%s)', async scenario => {
    const setup = scenario === 'expired setup';
    const f = await fixture({ mailbox: true, ready: !setup });
    let connecting = f.connecting;
    if (!setup) {
        f.reply(f.hello())(); await connecting;
        rpc.dispose();
        expect(openDirect(f.endpoint)).toBe(true);
        rpc = new NativeRpc(f.endpoint, () => undefined);
        connecting = rpc.connect().then(() => undefined, (error: Error) => error);
        await flush();
    }
    const previous = f.sent.at(-1)?.packet;
    if (scenario === 'changed grant') f.unblock({ ...f.route, authorizationRevision: 2 });
    await f.tick(setup ? 25000 : 3000);
    expect(f.helpers).toBe(1);
    expect(f.port.closed).toBe(true);
    if (scenario === 'changed grant') {
        expect((await connecting)?.message).toBe('The selected KeeWebX App changed. Find accounts again.');
        expect(f.stored.size).toBe(0);
        return;
    }
    if (previous) {
        // Direct retransmissions use the original hello, never an account request.
        expect(previous.operation).toBe('hello');
        expect(f.sent.filter(item => item.packet.document === previous.document).every(item => item.packet.id === previous.id)).toBe(true);
    }
    f.replyMailbox(); await f.tick(100);
    expect(await connecting).toBeUndefined();
    expect(f.timers.size).toBe(0);
});

test('mailbox setup waits across a 35-second App visit and resumes only on website return', async () => {
    const f = await fixture({ mailbox: true, ready: false, allowAppVisit: true });
    let finished = false;
    void f.connecting.then(() => { finished = true; });
    await f.tick(25000);
    f.website.hidden = true;
    await f.tick(35000);
    expect(finished).toBe(false);
    f.replyMailbox(); await f.tick(100);
    expect(finished).toBe(false);
    expect(f.sent).toHaveLength(0);
    f.website.hidden = false;
    f.website.dispatchEvent(new Event('visibilitychange'));
    expect(await f.connecting).toBeUndefined();
    expect(f.timers.size).toBe(0);
});

async function failRefresh(f: Awaited<ReturnType<typeof fixture>>) {
    f.block();
    const reads = f.reads, generation = link.generation;
    const preparing = prepareDirect(f.endpoint).then(() => undefined, (error: Error) => error);
    await flush(); await f.tick(5000);
    expect((await preparing)?.message).toBe('Userscripts settings did not respond.');
    expect(f.reads).toBe(reads + 1);
    expect(directCredentials(f.endpoint)).toBeUndefined();
    expect(openDirect(f.endpoint)).toBe(false);
    expect(f.helpers).toBe(1);
    expect(f.port.closed).toBe(false);
    expect(link.generation).toBe(generation);
}

test.each([['hello', 8000], ['wire', 10000], ['wire', 15000]] as const)
('a signed %s reply survives a foreground route-read timeout (%i ms deadline)', async (operation, timeout) => {
    const f = await fixture();
    if (operation === 'wire') { f.reply(f.hello())(); expect(await f.connecting).toBeUndefined(); }
    const expected = operation === 'hello' ? f.hello() : { action: 'kwx-features', message: 'opaque encrypted reply' };
    const result = operation === 'hello' ? f.connecting : rpc.call('wire', { action: 'kwx-features' }, timeout)
        .then((body: any) => body, (error: Error) => error);
    const request = f.sent.at(-1).packet;
    expect(request.deadline - f.now).toBe(timeout);
    const deliver = f.reply(expected);
    await failRefresh(f);
    // A 15-second wire request still has exactly ten seconds to accept its
    // queued reply; a ten-second request still has five. No deadline is renewed.
    expect(request.deadline - f.now).toBe(timeout - 5000);
    deliver();
    if (operation === 'hello') expect(await result).toBeUndefined();
    else expect(await result).toEqual(expected);
    expect(link.authenticatedReady).toBe(true);
    expect(f.timers.size).toBe(0);
    // Field selection still requires a successful foreground grant check.
    const count = f.sent.length;
    const selection = rpc.assertSelected().then(() => undefined, (error: Error) => error);
    await flush(); await f.tick(5001);
    expect((await selection)?.message).toBe('Userscripts settings did not respond.');
    expect(f.sent).toHaveLength(count);
    f.unblock();
    await prepareDirect(f.endpoint);
    expect(directCredentials(f.endpoint)).toBeDefined();
    expect(openDirect(f.endpoint)).toBe(true);
    expect(f.helpers).toBe(1);
    expect(f.port.closed).toBe(false);
    await rpc.assertSelected();
});

test('a preserved wire request still expires at its original ten-second deadline', async () => {
    const f = await fixture(); f.reply(f.hello())(); expect(await f.connecting).toBeUndefined();
    const result = rpc.call('wire', { action: 'kwx-get-entry-fields' }, 10000)
        .then((body: any) => body, (error: Error) => error);
    const request = f.sent.at(-1).packet, count = f.sent.length;
    const deliver = f.reply({ action: 'kwx-get-entry-fields', message: 'opaque encrypted fields' });
    await failRefresh(f);
    await f.tick(5000);
    expect(f.now).toBe(request.deadline);
    expect((await result).message).toBe('The KeeWebX request timed out. Try Find accounts again.');
    deliver();
    expect(rpc.pending.size).toBe(0);
    expect(f.sent).toHaveLength(count);
    expect(f.timers.size).toBe(0);
});

test.each(['signature', 'scope'] as const)
('a preserved wire request still rejects a mismatched %s before accepting its valid reply', async mismatch => {
    const f = await fixture(); f.reply(f.hello())(); expect(await f.connecting).toBeUndefined();
    let settled = false;
    const result = rpc.call('wire', { action: 'kwx-get-entry-fields' }, 10000)
        .then((body: any) => { settled = true; return body; }, (error: Error) => { settled = true; return error; });
    const expected = { action: 'kwx-get-entry-fields', message: 'opaque encrypted fields' };
    const invalid = f.reply(expected, mismatch), valid = f.reply(expected);
    await failRefresh(f);
    invalid(); await flush();
    expect(settled).toBe(false);
    expect(rpc.pending.size).toBe(1);
    valid();
    expect(await result).toEqual(expected);
    expect(rpc.pending.size).toBe(0);
    expect(f.timers.size).toBe(0);
});

test.each(['revoked route', 'grant-ended message'])('%s still closes the preserved port and rejects a queued reply', async change => {
    const f = await fixture(); f.reply(f.hello())(); expect(await f.connecting).toBeUndefined();
    const result = rpc.call('wire', { action: 'kwx-features' }, 15000).then(() => undefined, (error: Error) => error);
    const deliver = f.reply({ action: 'kwx-features' });
    await failRefresh(f);
    if (change === 'revoked route') { f.unblock(null); await prepareDirect(f.endpoint); }
    else f.revoke();
    expect(f.port.closed).toBe(true);
    expect(directCredentials(f.endpoint)).toBeUndefined();
    expect(openDirect(f.endpoint)).toBe(false);
    expect(await result).toBeInstanceOf(Error);
    deliver();
    expect(rpc.pending.size).toBe(0);
    expect(f.timers.size).toBe(0);
});
