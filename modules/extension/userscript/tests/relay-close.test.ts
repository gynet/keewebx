import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../../ui/connect-port/relay.js', import.meta.url), 'utf8');
const marker = 'keewebx-connect-port-v1';
const endpoint = 'https://keewebx.app/app', site = 'https://login.example.org';

function fixture(closeAllowed = true, oldControllerInitially = false) {
    const nonce = crypto.randomUUID(), id = crypto.randomUUID(), boot = crypto.randomUUID();
    const url = new URL('https://keewebx.app/connect-port/relay.html');
    url.searchParams.set('site', site); url.searchParams.set('nonce', nonce); url.searchParams.set('endpoint', endpoint);
    const windowListeners = new Map<string, ((event: any) => unknown)[]>(), workerListeners = new Map<string, ((event: any) => unknown)[]>();
    const timers = new Map<number, { callback: () => void; ms: number }>();
    let sequence = 0, closes = 0;
    const status = { textContent: '', dataset: {} as Record<string, string> };
    const buttonListeners = new Map<string, () => void>();
    const back = { disabled: false, textContent: '', addEventListener(name: string, callback: () => void) { buttonListeners.set(name, callback); } };
    const opener = { closed: false, posts: [] as unknown[], postMessage(data: unknown) { this.posts.push(data); } };
    const worker = { state: 'activated', scriptURL: 'https://keewebx.app/connect-port/worker.js', posts: [] as any[],
        addEventListener() {}, removeEventListener() {}, postMessage(data: any, ports: unknown[] = []) {
            this.posts.push({ data, ports });
            if (data.kind === 'probe-relay') queueMicrotask(() => {
                for (const callback of workerListeners.get('message') ?? []) callback({ isTrusted: true, source: worker, ports: [],
                    data: { marker, kind: 'relay-capabilities', nonce, endpoint, protocol: 'self-close-v1' } });
            });
        } };
    const oldWorker = { ...worker, posts: [] as any[], postMessage(data: unknown, ports: unknown[] = []) { this.posts.push({ data, ports }); } };
    const serviceWorker = { controller: oldControllerInitially ? oldWorker : worker,
        addEventListener(name: string, callback: (event: any) => unknown) { workerListeners.set(name, [...workerListeners.get(name) ?? [], callback]); },
        removeEventListener() {}, async register() { return { scope: 'https://keewebx.app/connect-port/' }; }, ready: Promise.resolve() };
    const window = { opener, closed: false, top: null as unknown, isSecureContext: true,
        close() { closes++; if (closeAllowed) this.closed = true; },
        removeEventListener(name: string, callback: (event: any) => unknown) { windowListeners.set(name, (windowListeners.get(name) ?? []).filter(fn => fn !== callback)); },
        addEventListener(name: string, callback: (event: any) => unknown) { windowListeners.set(name, [...windowListeners.get(name) ?? [], callback]); } };
    window.top = window;
    runInNewContext(source, { window, navigator: { serviceWorker }, URL, TextEncoder,
        location: url, document: { getElementById: (id: string) => id === 'status' ? status : id === 'back' ? back : { textContent: '' } },
        setTimeout(callback: () => void, ms: number) { const id = ++sequence; timers.set(id, { callback, ms }); return id; },
        clearTimeout(id: number) { timers.delete(id); }, setInterval() { return 0; }, clearInterval() {} });
    const completion = { marker, kind: 'handoff-complete', nonce, connectionId: id, endpoint };
    return {
        opener, worker, oldWorker, window, status, back, timers, closes: () => closes,
        async attach(expectTransfer = true) {
            const port = { closed: false, postMessage() {}, close() { this.closed = true; } };
            const event = { isTrusted: true, source: opener, origin: site, ports: [port],
                data: { marker, kind: 'attach', nonce, appBoot: boot, connectionId: id, endpoint, siteOrigin: site } };
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
        clickClose() { buttonListeners.get('click')!(); },
        upgrade() {
            serviceWorker.controller = worker;
            for (const callback of workerListeners.get('controllerchange') ?? []) callback({});
        },
        fire(ms: number) {
            for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.callback(); }
        }
    };
}

test('the routing helper closes itself after a validated worker handoff without requiring website execution', async () => {
    const f = fixture(); await f.attach(); await f.complete();
    expect(f.window.closed).toBe(true); expect(f.closes()).toBe(1);
    expect(f.worker.posts.filter(post => post.data.kind === 'attach')).toHaveLength(1);
    expect(f.status.textContent).toContain('Returning');
    await f.complete(); expect(f.closes()).toBe(1);
});
test('the verified website can ask its own helper to close as a compatible fallback', async () => {
    const f = fixture(); await f.attach(); await f.confirm();
    expect(f.window.closed).toBe(true); expect(f.closes()).toBe(1);
});
test('completion cannot close a helper before attachment', async () => {
    const f = fixture(); await f.complete(); await f.confirm(); expect(f.closes()).toBe(0);
});
test('spoofed or mismatched worker completion is ignored', async () => {
    const f = fixture(); await f.attach();
    for (const data of [{ marker: 'wrong' }, { nonce: crypto.randomUUID() }, { connectionId: crypto.randomUUID() },
        { endpoint: 'https://keewebx.app/other' }, { extra: 'unexpected' }]) await f.complete(data);
    for (const event of [{ isTrusted: false }, { source: {} }, { ports: [{ close() {} }] }]) await f.complete({}, event);
    expect(f.closes()).toBe(0); expect(f.window.closed).toBe(false);
});
test('opener closure control requires its exact source, origin and connection metadata', async () => {
    const f = fixture(); await f.attach();
    for (const data of [{ nonce: crypto.randomUUID() }, { connectionId: crypto.randomUUID() }, { endpoint: 'https://other.example/app' }]) await f.confirm(data);
    for (const event of [{ isTrusted: false }, { source: {} }, { origin: 'https://attacker.example' }, { ports: [{ close() {} }] }]) await f.confirm({}, event);
    expect(f.closes()).toBe(0);
});
test('a silent self-close denial gives an explicit manual close action rather than waiting forever', async () => {
    const f = fixture(false); await f.attach(); await f.complete(); f.fire(300);
    expect(f.window.closed).toBe(false); expect(f.closes()).toBe(1);
    expect(f.status.textContent).toContain('Close this page'); expect(f.status.textContent).not.toContain('Waiting');
    expect(f.back.textContent).toBe('Close connection page');
    f.clickClose(); expect(f.closes()).toBe(2);
});
test('a missing handoff has a bounded failure state with a real close action', async () => {
    const f = fixture(); await f.attach(); f.fire(25000);
    expect(f.status.textContent).toContain('did not complete'); expect(f.back.textContent).toBe('Close connection page');
    f.clickClose(); expect(f.window.closed).toBe(true);
});

test('an old activated controller with the same URL cannot accept the first handoff during upgrade', async () => {
    const f = fixture(true, true), attached = f.attach();
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(f.oldWorker.posts.some(post => post.data.kind === 'probe-relay')).toBe(true);
    expect(f.oldWorker.posts.filter(post => post.data.kind === 'attach')).toHaveLength(0);
    expect(f.worker.posts.filter(post => post.data.kind === 'attach')).toHaveLength(0);
    f.upgrade(); await attached; await f.complete();
    expect(f.window.closed).toBe(true);
});
test('an old controller that never upgrades fails within the existing worker budget', async () => {
    const f = fixture(true, true), attached = f.attach(false);
    f.fire(8000); await attached;
    expect(f.status.textContent).toContain('8 seconds');
    expect(f.back.textContent).toBe('Close connection page');
    expect(f.oldWorker.posts.filter(post => post.data.kind === 'attach')).toHaveLength(0);
});

test('a matching worker failure closes its own helper without a remote close', async () => {
    const f = fixture(); await f.attach();
    await f.complete({}, { data: { marker, kind: 'error', code: 'disabled',
        message: 'Connect is disabled.', nonce: (f.worker.posts.find(post => post.data.kind === 'attach').data.nonce),
        connectionId: f.worker.posts.find(post => post.data.kind === 'attach').data.connectionId } });
    expect(f.window.closed).toBe(true); expect(f.closes()).toBe(1);
    expect(f.status.textContent).toBe('Connect is disabled.');
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
