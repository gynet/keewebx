import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sign } from 'tweetnacl';
import { toBase64 } from '../../src/background/utils';
import { AppBridge, appReceiptsSupported } from '../src/app-bridge';
import { BackendConnectionState as State } from '../../src/common/backend-connection-state';

// NativeRpc installs an unrelated website listener at import time. These tests
// exercise the App closure in isolation and restore every global they replace.
const originalListener = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
Object.defineProperty(globalThis, 'addEventListener', { configurable: true, writable: true, value() {} });
const { NativeHost, managerCall } = await import('../src/native-connect');
if (originalListener) Object.defineProperty(globalThis, 'addEventListener', originalListener);
else Reflect.deleteProperty(globalThis, 'addEventListener');

const endpoint = new URL('https://keewebx.app/app');
const routeKey = `keewebx-native-connect-v1:selected:${endpoint.href}`;
// An optional source path permits a read-only negative control against git show.
const source = readFileSync(
    process.env.KWX_APP_AUTHORIZATION_SOURCE ?? new URL('../src/simple-connect.ts', import.meta.url), 'utf8'
);
const start = source.indexOf('async function start(): Promise<void> {');
const website = source.indexOf('    let autoFillSingle = false;', start);
if (start < 0 || website < 0) throw new Error('The App startup closure boundaries changed. Update this fixture.');
// Execute the checked-in App branch verbatim, including its private lifecycle
// variables and callbacks. Do not duplicate onClose/restoration logic here.
const appStartup = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    source.slice(start, website) + '}\nawait start();'
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const restore of cleanup.splice(0).reverse()) restore();
});

async function settle(): Promise<void> {
    for (let turn = 0; turn < 150; turn++) await Promise.resolve();
}

async function until(predicate: () => boolean): Promise<void> {
    for (let turn = 0; turn < 500 && !predicate(); turn++) await Promise.resolve();
    expect(predicate()).toBe(true);
}

async function fixture(canList = true, holdStartupAction?: string) {
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const replace = (name: string, value: unknown) => {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    cleanup.push(() => {
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });
    const listeners = new Map<string, Set<(event: any) => void>>();
    const emit = (name: string, event: any = {}) => {
        for (const listener of [...(listeners.get(name) ?? [])]) listener(event);
    };
    replace('addEventListener', (name: string, listener: (event: any) => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(listener);
    });
    replace('removeEventListener', (name: string, listener: (event: any) => void) => listeners.get(name)?.delete(listener));
    replace('location', endpoint);
    replace('document', {
        hidden: false, visibilityState: 'visible', body: {},
        documentElement: { dataset: { appInstance: 'primary' } },
        querySelector: () => ({})
    });
    const local = new Map<string, string>();
    const storage = new Map<string, any>();
    let publications = 0;
    replace('localStorage', {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => local.set(key, value),
        removeItem: (key: string) => local.delete(key)
    });
    replace('GM', {
        getValue: async (key: string) => structuredClone(storage.get(key)),
        setValue: async (key: string, value: unknown) => {
            if (key === routeKey) publications++;
            storage.set(key, structuredClone(value));
        },
        deleteValue: async (key: string) => { storage.delete(key); }
    });
    replace('navigator', {
        locks: { request: async (_name: string, _options: unknown, work: () => Promise<void>) => work() },
        serviceWorker: { addEventListener() {}, removeEventListener() {}, startMessages() {} }
    });
    replace('BroadcastChannel', class { postMessage() {} });

    let blockedAction: string | undefined = holdStartupAction;
    let held: Record<string, any> | undefined;
    let permissionRequests = 0;
    let protocolRequests = 0;
    const respond = (request: Record<string, any>) => emit('message', {
        isTrusted: true, source: window, origin: endpoint.origin,
        data: {
            ...request, kwConnect: 'response', kwReceipt: 1,
            locked: false, paired: true, canList
        }
    });
    const fakeWindow: Record<string, any> = {
        postMessage(request: Record<string, any>) {
            if (request.kwConnect !== 'request') return;
            protocolRequests++;
            if (request.action === 'kwx-get-entries') permissionRequests++;
            if (request.action === blockedAction) {
                blockedAction = undefined;
                held = request;
            } else queueMicrotask(() => respond(request));
        }
    };
    fakeWindow.top = fakeWindow;
    replace('window', fakeWindow);

    let host!: InstanceType<typeof NativeHost>;
    let ui!: UI;
    let changed!: () => void;
    let lockState!: (unlocked: boolean) => void;
    const keys = sign.keyPair();
    class CapturedHost extends NativeHost {
        constructor(...args: ConstructorParameters<typeof NativeHost>) { super(...args); host = this; }
    }
    class UI {
        status: State = State.Initializing;
        actions = new Map<string, (event: { isTrusted: boolean }) => void>();
        actionState = new Map<string, Record<string, unknown>>();
        onClose = () => {};
        onOpen = () => {};
        connectionSnapshot = () => ({});
        constructor() { ui = this; }
        state(status: State) { this.status = status; }
        action(name: string, patch: Record<string, unknown>) {
            this.actionState.set(name, { ...this.actionState.get(name), ...patch });
        }
        on(name: string, handler: (event: { isTrusted: boolean }) => void) { this.actions.set(name, handler); }
    }
    // Stub protocol semantics only. Every request uses the closure's guarded
    // adapter and the real AppBridge, including reset and late reply fencing.
    class Protocol {
        constructor(private adapter: { request(value: any): Promise<any> }) {}
        ping() { return this.adapter.request({ action: 'ping' }); }
        changePublicKeys() { return this.adapter.request({ action: 'change-public-keys' }); }
        pair() { return this.adapter.request({ action: 'kwx-pair' }); }
        features() { return this.adapter.request({ action: 'kwx-features' }); }
        getEntries() { return this.adapter.request({ action: 'kwx-get-entries' }); }
    }
    const dependencies = {
        claimRuntime: () => ({}), loadEndpoint: async () => endpoint, DEFAULT_ENDPOINT: endpoint.href,
        ConnectUI: UI, NativeHost: CapturedHost, AppBridge, managerCall,
        identity: async () => keys, ProtocolImpl: Protocol, runtime: {}, appReceiptsSupported,
        State, message: (error: Error) => error.message,
        watchAppLockState: (listener: (unlocked: boolean) => void) => { lockState = listener; },
        MutationObserver: class {
            constructor(listener: () => void) { changed = listener; }
            observe() {}
        }
    };
    await new AsyncFunction(...Object.keys(dependencies), appStartup)(...Object.values(dependencies));
    cleanup.push(() => {
        host.pause();
        // The fixture owns this receiver and its idle timer.
        (host as any).direct?.dispose();
    });
    if (holdStartupAction) await until(() => held !== undefined);
    else await until(() => ui.actionState.get('authorize')?.disabled === false);

    const direct = { origin: 'https://login.example.org', id: crypto.randomUUID() };
    const replies: any[] = [];
    const packet = (extra: Record<string, unknown> = {}) => ({
        type: 'request', host: storage.get(routeKey)?.host, endpoint: endpoint.href,
        id: crypto.randomUUID(), document: crypto.randomUUID(), origin: direct.origin,
        operation: 'hello', deadline: Date.now() + 5000, ...extra
    });
    const send = async (request: ReturnType<typeof packet>) => {
        const stable = JSON.stringify(request, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, value[key]])) : value);
        const signed = { packet: request, signature: toBase64(sign.detached(new TextEncoder().encode(stable), keys.secretKey)) };
        await (host as any).receive(signed, (reply: any) => replies.push(reply.packet), direct);
    };
    const cycle = async () => {
        const hello = packet();
        const count = replies.length;
        await send(hello);
        expect(replies).toHaveLength(count + 1);
        expect(replies.at(-1).error).toBeUndefined();
        const scope = replies.at(-1).body.scope;
        await send(packet({ document: hello.document, operation: 'probe', scope }));
        expect(replies).toHaveLength(count + 2);
        expect(replies.at(-1).error).toBeUndefined();
        await send(packet({ document: hello.document, operation: 'release', scope }));
        expect(host.diagnostics().hasSession).toBe(false);
    };
    return {
        host, ui, storage, cycle, lockState,
        publications: () => publications,
        permissionRequests: () => permissionRequests,
        protocolRequests: () => protocolRequests,
        async beginAuthorization(action = 'ping') {
            held = undefined;
            blockedAction = action;
            ui.actions.get('authorize')!({ isTrusted: true });
            await until(() => held !== undefined);
        },
        lateReply() { expect(held).toBeDefined(); respond(held!); held = undefined; },
        pageHide(persisted: boolean) { emit('pagehide', { persisted }); },
        pageShow(persisted: boolean) { emit('pageshow', { persisted }); },
        bodyMutation() { changed(); },
        foreground() { emit('focus'); emit('visibilitychange'); ui.onOpen(); changed(); }
    };
}

test('ordinary hello, probe and release allow another session on the same host', async () => {
    const f = await fixture();
    await f.cycle();
    await f.cycle();
    expect(f.host.diagnostics()).toMatchObject({ live: true, selected: true, locked: false });
    expect(f.publications()).toBe(1);
});

test('body mutations preserve an authorized grant while explicit reauthorization remains allowed', async () => {
    const f = await fixture();
    const original = f.storage.get(routeKey);
    const requests = f.protocolRequests();
    const authorization = f.host.diagnostics().authorization;
    f.bodyMutation(); f.foreground();
    await settle();
    expect(f.protocolRequests()).toBe(requests);
    expect(f.publications()).toBe(1);
    expect(f.host.diagnostics().authorization).toBe(authorization);
    expect(f.storage.get(routeKey)).toEqual(original);
    await f.cycle();

    await f.beginAuthorization();
    expect(f.ui.connectionSnapshot()).toMatchObject({ authorized: true, authorizing: true });
    f.lateReply();
    await settle();
    expect(f.protocolRequests()).toBeGreaterThan(requests);
    expect(f.publications()).toBe(2);
    expect(f.storage.get(routeKey)).toMatchObject({ host: original.host, publicKey: original.publicKey });
    expect(f.storage.get(routeKey).authorizationRevision).toBeGreaterThan(original.authorizationRevision);
    expect(f.ui.connectionSnapshot()).toMatchObject({ authorized: true, authorizing: false });
    expect(f.permissionRequests()).toBe(0);
    await f.cycle();
});

test('cached page returns resume signed RPC without republishing the authorized grant', async () => {
    const f = await fixture();
    const original = f.storage.get(routeKey);
    const requests = f.protocolRequests();
    await f.cycle();

    for (let visit = 0; visit < 3; visit++) {
        const authorization = f.host.diagnostics().authorization;
        f.pageHide(true);
        expect(f.host.diagnostics()).toMatchObject({ live: false, hasSession: false, authorization: authorization + 1 });
        f.pageShow(true);
        f.bodyMutation(); f.foreground();
        await settle();
        // Pause fences old work, but the saved publication still names this App.
        // A new signed session must work without equating these two generations.
        expect(f.publications()).toBe(1);
        expect(f.protocolRequests()).toBe(requests);
        expect(f.storage.get(routeKey)).toEqual(original);
        expect(f.host.diagnostics()).toMatchObject({ live: true, selected: true, locked: false, authorization: authorization + 1 });
        expect(f.ui.connectionSnapshot()).toMatchObject({ authorized: true, authorizing: false });
        await f.cycle();
    }
    expect(f.permissionRequests()).toBe(0);
});

test('body mutations do not repeat explicit authorization after disconnect, lock and unlock', async () => {
    const f = await fixture();
    const original = f.storage.get(routeKey);
    const requests = f.protocolRequests();
    f.ui.actions.get('revoke')!({ isTrusted: true });
    await settle();
    expect(f.storage.has(routeKey)).toBe(false);
    f.lockState(false);
    f.lockState(true);
    f.bodyMutation(); f.foreground();
    await settle();
    expect(f.host.diagnostics().live).toBe(false);
    expect(f.ui.connectionSnapshot()).toMatchObject({ authorized: false, authorizing: false });
    expect(f.storage.has(routeKey)).toBe(false);
    expect(f.publications()).toBe(1);
    expect(f.protocolRequests()).toBe(requests);

    await f.beginAuthorization();
    f.lateReply();
    await settle();
    expect(f.publications()).toBe(2);
    expect(f.storage.get(routeKey)).toMatchObject({ host: original.host, publicKey: original.publicKey });
    const restored = f.storage.get(routeKey);
    const authorizedRequests = f.protocolRequests();
    const authorization = f.host.diagnostics().authorization;
    await f.cycle();

    // Exercise only the body observer: foreground retry already checks authorized.
    f.bodyMutation();
    await settle();
    expect(f.publications()).toBe(2);
    expect(f.protocolRequests()).toBe(authorizedRequests);
    expect(f.storage.get(routeKey)).toEqual(restored);
    expect(f.host.diagnostics()).toMatchObject({ live: true, selected: true, locked: false, authorization });
    expect(f.ui.connectionSnapshot()).toMatchObject({ authorized: true, authorizing: false });
    expect(f.permissionRequests()).toBe(0);
    await f.cycle();
});

test.each(['ping', 'kwx-features'])
('closing the panel leaves silent startup restoration running during %s', async action => {
    const f = await fixture(true, action);
    expect(f.publications()).toBe(0);
    expect(f.ui.actionState.get('authorize')?.disabled).toBe(true);
    f.ui.onClose();
    f.lateReply();
    // No focus, visibility, mutation, unlock or reopen event follows the close.
    await settle();
    expect(f.host.diagnostics()).toMatchObject({ live: true, selected: true, locked: false });
    expect(f.ui.status).toBe(State.Connected);
    expect(f.ui.actionState.get('authorize')?.disabled).toBe(false);
    expect(f.publications()).toBe(1);
    expect(f.permissionRequests()).toBe(0);
    await f.cycle();
});

test.each(['lock', 'disconnect', 'pagehide', 'cached pagehide'])
('%s still cancels silent restoration after the panel closes', async action => {
    const f = await fixture(true, 'ping');
    f.ui.onClose();
    if (action === 'lock') f.lockState(false);
    else if (action === 'disconnect') f.ui.actions.get('revoke')!({ isTrusted: true });
    else f.pageHide(action === 'cached pagehide');
    f.lateReply();
    await settle();
    expect(f.host.diagnostics().live).toBe(false);
    expect(f.storage.has(routeKey)).toBe(false);
    expect(f.publications()).toBe(0);
    expect(f.permissionRequests()).toBe(0);
});

test('closing repeat authorization restores the saved grant and accepts the next hello', async () => {
    const f = await fixture();
    await f.cycle();
    const originalHost = f.storage.get(routeKey).host;
    await f.beginAuthorization();
    f.ui.onClose();
    expect(f.host.diagnostics().live).toBe(false);
    f.lateReply();
    // Restoration must be queued by cancellation, without another user tap.
    await settle();
    expect(f.host.diagnostics()).toMatchObject({ live: true, selected: true, locked: false });
    expect(f.storage.get(routeKey).host).toBe(originalHost);
    expect(f.ui.status).toBe(State.Connected);
    expect(f.permissionRequests()).toBe(0);
    await f.cycle();
});

test('canceling initial permission approval cannot authorize through a late reply or foreground retry', async () => {
    const f = await fixture(false);
    expect(f.publications()).toBe(0);
    await f.beginAuthorization('kwx-get-entries');
    expect(f.permissionRequests()).toBe(1);
    expect(f.ui.actionState.get('authorize')?.disabled).toBe(true);
    f.ui.onClose();
    // Explicit cancellation must take effect before the held request replies.
    expect(f.ui.actionState.get('authorize')?.disabled).toBe(false);
    expect(f.ui.status).toBe(State.ReadyToConnect);
    f.lateReply();
    await settle();
    f.foreground();
    await settle();
    expect(f.host.diagnostics().live).toBe(false);
    expect(f.storage.has(routeKey)).toBe(false);
    expect(f.publications()).toBe(0);
    expect(f.permissionRequests()).toBe(1);
    expect(f.ui.actionState.get('authorize')?.disabled).toBe(false);
});

test('disconnect fences the queued recovery after repeat authorization is canceled', async () => {
    const f = await fixture();
    await f.beginAuthorization();
    f.ui.onClose();
    f.ui.actions.get('revoke')!({ isTrusted: true });
    f.lateReply();
    await settle();
    f.foreground();
    await settle();
    expect(f.host.diagnostics().live).toBe(false);
    expect(f.storage.has(routeKey)).toBe(false);
    expect(f.publications()).toBe(1);
    expect(f.permissionRequests()).toBe(0);
});

test('locking fences queued recovery and unlocking can restore the previous grant', async () => {
    const f = await fixture();
    await f.beginAuthorization();
    f.ui.onClose();
    f.lockState(false);
    f.lateReply();
    await settle();
    expect(f.host.diagnostics()).toMatchObject({ live: false, locked: true });
    expect(f.publications()).toBe(1);
    f.lockState(true);
    await settle();
    expect(f.host.diagnostics()).toMatchObject({ live: true, selected: true, locked: false });
    expect(f.permissionRequests()).toBe(0);
    await f.cycle();
});
