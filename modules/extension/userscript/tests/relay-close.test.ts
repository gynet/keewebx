import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { sign } from 'tweetnacl';
import { signPortReady } from '../src/port-auth';

const source = readFileSync(new URL('../../../ui/connect-port/relay.js', import.meta.url), 'utf8');
const marker = 'keewebx-connect-port-v1';
const endpoint = 'https://keewebx.app/app', site = 'https://login.example.org';

function fixture(closeAllowed = true, oldControllerInitially = false) {
    const nonce = crypto.randomUUID(), id = crypto.randomUUID(), boot = crypto.randomUUID();
    const key = sign.keyPair();
    let now = Date.now();
    const deadline = now + 10000;
    let receiptChannel: Channel | undefined;
    class Channel {
        onmessage?: (event: any) => Promise<void>;
        closed = false;
        constructor(readonly name: string) { receiptChannel = this; }
        close() { this.closed = true; }
    }
    const url = new URL('https://keewebx.app/connect-port/relay.html');
    url.searchParams.set('site', site); url.searchParams.set('nonce', nonce); url.searchParams.set('endpoint', endpoint);
    const windowListeners = new Map<string, ((event: any) => unknown)[]>(), workerListeners = new Map<string, ((event: any) => unknown)[]>();
    const timers = new Map<number, { callback: () => void; ms: number }>();
    let sequence = 0, closes = 0, heartbeat = () => {};
    const status = { textContent: '', dataset: {} as Record<string, string> };
    const buttonListeners = new Map<string, () => void>();
    const back = { disabled: false, textContent: '', addEventListener(name: string, callback: () => void) { buttonListeners.set(name, callback); } };
    const opener = { closed: false, posts: [] as unknown[], postMessage(data: unknown) { this.posts.push(data); } };
    const worker = { state: 'activated', scriptURL: 'https://keewebx.app/connect-port/worker.js', posts: [] as any[],
        addEventListener() {}, removeEventListener() {}, postMessage(data: any, ports: unknown[] = []) {
            this.posts.push({ data, ports });
            if (data.kind === 'probe-relay') queueMicrotask(() => {
                for (const callback of workerListeners.get('message') ?? []) callback({ isTrusted: true, source: worker, ports: [],
                    data: { marker, kind: 'relay-capabilities', nonce, endpoint, protocol: 'handoff-owner-v1' } });
            });
        } };
    const oldWorker = { ...worker, posts: [] as any[], postMessage(data: any, ports: unknown[] = []) {
        this.posts.push({ data, ports });
        // Even an old capability reply from the current controller cannot satisfy the new requirement.
        if (data.kind === 'probe-relay') queueMicrotask(() => {
            for (const callback of workerListeners.get('message') ?? []) callback({ isTrusted: true, source: oldWorker, ports: [],
                data: { marker, kind: 'relay-capabilities', nonce, endpoint, protocol: 'self-close-v1' } });
        });
    } };
    const serviceWorker = { controller: oldControllerInitially ? oldWorker : worker,
        addEventListener(name: string, callback: (event: any) => unknown) { workerListeners.set(name, [...workerListeners.get(name) ?? [], callback]); },
        removeEventListener() {}, async register() { return { scope: 'https://keewebx.app/connect-port/' }; }, ready: Promise.resolve() };
    const window = { opener, closed: false, top: null as unknown, isSecureContext: true,
        close() { closes++; if (closeAllowed) this.closed = true; },
        removeEventListener(name: string, callback: (event: any) => unknown) { windowListeners.set(name, (windowListeners.get(name) ?? []).filter(fn => fn !== callback)); },
        addEventListener(name: string, callback: (event: any) => unknown) { windowListeners.set(name, [...windowListeners.get(name) ?? [], callback]); } };
    window.top = window;
    runInNewContext(source, { window, navigator: { serviceWorker }, URL, TextEncoder, BroadcastChannel: Channel,
        crypto, atob, Uint8Array, Date: { now: () => now },
        location: url, document: { getElementById: (id: string) => id === 'status' ? status : id === 'back' ? back : { textContent: '' } },
        setTimeout(callback: () => void, ms: number) { const id = ++sequence; timers.set(id, { callback, ms }); return id; },
        clearTimeout(id: number) { timers.delete(id); }, setInterval(callback: () => void) { heartbeat = callback; return 0; }, clearInterval() {} });
    const completion = { marker, kind: 'handoff-complete', nonce, connectionId: id, endpoint };
    return {
        opener, worker, oldWorker, window, status, back, timers, closes: () => closes,
        async attach(expectTransfer = true, withReceipt = false) {
            const port = { closed: false, postMessage() {}, close() { this.closed = true; } };
            const event = { isTrusted: true, source: opener, origin: site, ports: [port],
                data: { marker, kind: 'attach', nonce, appBoot: boot, connectionId: id, endpoint, siteOrigin: site,
                    ...(withReceipt ? { publicKey: Buffer.from(key.publicKey).toString('base64'), deadline: String(deadline) } : {}) } };
            await Promise.all((windowListeners.get('message') ?? []).map(fn => fn(event)));
            expect(worker.posts.filter(post => post.data.kind === 'attach')).toHaveLength(expectTransfer ? 1 : 0);
        },
        async complete(data: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
            const message = { isTrusted: true, source: worker, ports: [], data: { ...completion, ...data }, ...event };
            await Promise.all((workerListeners.get('message') ?? []).map(fn => fn(message)));
        },
        async confirm(data: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
            const message = { isTrusted: true, source: opener, origin: site, ports: [], data: { ...completion, kind: 'relay-complete', ...data }, ...event };
            await Promise.all((windowListeners.get('message') ?? []).map(fn => fn(message)));
        },
        async receipt(patch: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
            expect(receiptChannel?.name).toBe(marker + ':ready:' + id);
            const data = { marker, kind: 'ready', appBoot: boot, connectionId: id, endpoint, siteOrigin: site };
            await receiptChannel?.onmessage?.({ isTrusted: true, origin: url.origin, ports: [],
                data: { ...data, proof: signPortReady(data, key.secretKey), ...patch }, ...event });
        },
        expireReceipt() { now = deadline; },
        receiptClosed: () => receiptChannel?.closed,
        clickClose() { buttonListeners.get('click')!(); },
        heartbeat() { heartbeat(); },
        upgrade() {
            serviceWorker.controller = worker;
            for (const callback of workerListeners.get('controllerchange') ?? []) callback({});
        },
        fire(ms: number) {
            for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.callback(); }
        }
    };
}

test('a worker transfer cannot close the helper before the website verifies App readiness', async () => {
    const f = fixture(); await f.attach(); await f.complete();
    expect(f.window.closed).toBe(false); expect(f.closes()).toBe(0);
    await f.confirm();
    expect(f.window.closed).toBe(true); expect(f.closes()).toBe(1);
    expect(f.worker.posts.filter(post => post.data.kind === 'attach')).toHaveLength(1);
    expect(f.status.textContent).toContain('Returning');
    await f.complete(); expect(f.closes()).toBe(1);
});
test('the verified website asks its own helper to close after App readiness', async () => {
    const f = fixture(); await f.attach(); await f.confirm();
    expect(f.window.closed).toBe(true); expect(f.closes()).toBe(1);
});
test('the originating website can cancel a failed setup without claiming App readiness', async () => {
    const f = fixture(); await f.attach(); await f.confirm({ kind: 'relay-cancel' });
    expect(f.window.closed).toBe(true); expect(f.closes()).toBe(1);
    await f.confirm(); expect(f.closes()).toBe(1);
});
test('completion cannot close a helper before attachment', async () => {
    const f = fixture(); await f.complete(); await f.confirm(); await f.confirm({ kind: 'relay-cancel' }); expect(f.closes()).toBe(0);
});
test('spoofed or mismatched worker completion is ignored', async () => {
    const f = fixture(); await f.attach();
    for (const data of [{ marker: 'wrong' }, { nonce: crypto.randomUUID() }, { connectionId: crypto.randomUUID() },
        { endpoint: 'https://keewebx.app/other' }, { extra: 'unexpected' }]) await f.complete(data);
    for (const event of [{ isTrusted: false }, { source: {} }, { ports: [{ close() {} }] }]) await f.complete({}, event);
    expect(f.closes()).toBe(0); expect(f.window.closed).toBe(false);
});
test.each(['relay-complete', 'relay-cancel'])('opener %s requires its exact source, origin and connection metadata', async kind => {
    const f = fixture(); await f.attach();
    for (const data of [{ nonce: crypto.randomUUID() }, { connectionId: crypto.randomUUID() }, { endpoint: 'https://other.example/app' }]) await f.confirm({ kind, ...data });
    for (const event of [{ isTrusted: false }, { source: {} }, { origin: 'https://attacker.example' }, { ports: [{ close() {} }] }]) await f.confirm({ kind }, event);
    expect(f.closes()).toBe(0);
});
test('a silent self-close denial gives an explicit manual close action rather than waiting forever', async () => {
    const f = fixture(false); await f.attach(); await f.confirm(); f.fire(300);
    expect(f.window.closed).toBe(false); expect(f.closes()).toBe(1);
    expect(f.status.textContent).toContain('Close this page'); expect(f.status.textContent).not.toContain('Waiting');
    expect(f.back.textContent).toBe('Close connection page');
    f.clickClose(); expect(f.closes()).toBe(2);
});
test('a missing handoff reports failure and closes within its existing budget', async () => {
    const f = fixture(); await f.attach(); f.fire(25000);
    expect(f.status.textContent).toContain('did not complete'); expect(f.back.textContent).toBe('Close connection page');
    expect(f.window.closed).toBe(true); expect(f.closes()).toBe(1);
});

test('a closed opener cannot strand a helper before attachment', () => {
    const f = fixture(); f.opener.closed = true; f.heartbeat();
    expect(f.window.closed).toBe(true); expect(f.closes()).toBe(1);
    expect(f.worker.posts.filter(post => post.data.kind === 'attach')).toHaveLength(0);
});
test('abandoned startup reports timeout and closes without accepting a late attachment', async () => {
    const f = fixture(); f.fire(12000);
    expect(f.window.closed).toBe(true); expect(f.closes()).toBe(1);
    expect(f.opener.posts.at(-1)).toMatchObject({ kind: 'error', code: 'timeout', connectionId: '' });
    await f.attach(false);
});
test('a failed handoff still offers manual close if the browser refuses self-close', async () => {
    const f = fixture(false); await f.attach(); f.fire(25000); f.fire(300);
    expect(f.window.closed).toBe(false); expect(f.back.disabled).toBe(false);
    expect(f.status.textContent).toContain('Close this connection page');
    f.clickClose(); expect(f.closes()).toBe(2);
});

test('an old activated controller with the same URL cannot accept the first handoff during upgrade', async () => {
    const f = fixture(true, true), attached = f.attach();
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(f.oldWorker.posts.some(post => post.data.kind === 'probe-relay')).toBe(true);
    expect(f.oldWorker.posts.filter(post => post.data.kind === 'attach')).toHaveLength(0);
    expect(f.worker.posts.filter(post => post.data.kind === 'attach')).toHaveLength(0);
    f.upgrade(); await attached; await f.confirm();
    expect(f.window.closed).toBe(true);
});
test('an old controller that never upgrades fails within the existing worker budget', async () => {
    const f = fixture(true, true), attached = f.attach(false);
    f.fire(8000); await attached;
    expect(f.status.textContent).toContain('8 seconds');
    expect(f.back.textContent).toBe('Close connection page');
    expect(f.oldWorker.posts.filter(post => post.data.kind === 'attach')).toHaveLength(0);
});

test('an unavailable worker reports startup failure even before a port arrives', async () => {
    const f = fixture(true, true);
    f.fire(8000);
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(f.opener.posts.at(-1)).toMatchObject({ marker, kind: 'error', code: 'worker-unavailable', connectionId: '' });
    expect(f.window.closed).toBe(true); expect(f.closes()).toBe(1);
});

test('a matching worker failure closes its own helper without a remote close', async () => {
    const f = fixture(); await f.attach();
    await f.complete({}, { data: { marker, kind: 'error', code: 'disabled',
        message: 'Connect is disabled.', nonce: (f.worker.posts.find(post => post.data.kind === 'attach').data.nonce),
        connectionId: f.worker.posts.find(post => post.data.kind === 'attach').data.connectionId } });
    expect(f.window.closed).toBe(true); expect(f.closes()).toBe(1);
    expect(f.status.textContent).toBe('Connect is disabled.');
    expect(f.opener.posts.at(-1)).toMatchObject({ marker, kind: 'error', code: 'disabled', message: 'Connect is disabled.' });
});
test('untrusted, stale or port-bearing worker errors cannot close the helper', async () => {
    const f = fixture(); await f.attach();
    const attach = f.worker.posts.find(post => post.data.kind === 'attach').data;
    const data = { marker, kind: 'error', code: 'disabled', message: 'Connect is disabled.', nonce: attach.nonce, connectionId: attach.connectionId };
    for (const event of [{ isTrusted: false }, { source: {} }, { ports: [{ close() {} }] },
        { data: { ...data, nonce: crypto.randomUUID() } }, { data: { ...data, connectionId: crypto.randomUUID() } }])
        await f.complete({}, { data, ...event });
    expect(f.closes()).toBe(0);
});

test('the helper verifies signed App readiness before the website confirms or processes the port', async () => {
    const f = fixture();
    await f.attach(true, true);
    await f.receipt();
    expect(f.window.closed).toBe(true);
    expect(f.receiptClosed()).toBe(true);
    expect(f.status.textContent).toContain('Returning');
});

test('forged, misbound and delayed readiness receipts cannot close the helper', async () => {
    const f = fixture();
    await f.attach(true, true);
    await f.receipt({ proof: Buffer.alloc(64).toString('base64') });
    await f.receipt({ appBoot: crypto.randomUUID() });
    await f.receipt({ connectionId: crypto.randomUUID() });
    await f.receipt({ endpoint: 'https://keewebx.app/other' });
    await f.receipt({ siteOrigin: 'https://different.example' });
    await f.receipt({}, { origin: 'https://different.example' });
    await f.receipt({}, { isTrusted: false });
    expect(f.closes()).toBe(0);
    f.expireReceipt();
    await f.receipt();
    expect(f.closes()).toBe(0);
});
