import { afterEach, expect, jest, mock, test } from 'bun:test';

const updateModel = { updateStatus: null as string | null, set(value: { updateStatus: string | null }) {
    this.updateStatus = value.updateStatus;
} };
mock.module('models/update-model', () => ({ UpdateModel: updateModel }));
mock.module('const/runtime-info', () => ({ RuntimeInfo: { devMode: false } }));
mock.module('comp/settings/storage-namespace', () => ({ getStorageNamespace: () => '' }));
mock.module('util/logger', () => ({ Logger: class { warn() {} } }));
const { ServiceWorkerClient } = await import('comp/browser/service-worker-client');

const originals = new Map(['navigator', 'window', 'document', 'location'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let cancel: (() => void) | undefined;
afterEach(() => {
    cancel?.(); cancel = undefined;
    jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks();
    ServiceWorkerClient.registration = null; ServiceWorkerClient.initialized = false;
    updateModel.updateStatus = null;
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function fixture() {
    jest.useFakeTimers();
    class Worker extends EventTarget {
        scriptURL = 'https://keewebx.app/service-worker.js';
        state: ServiceWorkerState = 'installed';
        posts: unknown[] = [];
        postMessage(data: unknown) { this.posts.push(data); }
    }
    const old = new Worker(), waiting = new Worker();
    let allowed = true, reloads = 0, registered = 0;
    const registration = Object.assign(new EventTarget(), {
        scope: 'https://keewebx.app/', active: old, waiting: waiting as Worker | null, installing: null as Worker | null,
        update: async () => {}
    });
    const container = Object.assign(new EventTarget(), {
        controller: old as Worker | null, ready: Promise.resolve(registration),
        register: async () => { registered++; return registration; }
    });
    const window = Object.assign(new EventTarget(), { isSecureContext: true });
    for (const [key, value] of Object.entries({
        navigator: { serviceWorker: container }, window,
        document: { baseURI: 'https://keewebx.app/next.html' },
        location: { protocol: 'https:', href: 'https://keewebx.app/next.html', reload: () => { reloads++; } }
    })) Object.defineProperty(globalThis, key, { configurable: true, value });
    ServiceWorkerClient.registration = registration as unknown as ServiceWorkerRegistration;
    const activate = () => {
        registration.active = waiting; registration.waiting = null;
        waiting.state = 'activated'; container.controller = waiting;
        waiting.dispatchEvent(new Event('statechange')); container.dispatchEvent(new Event('controllerchange'));
    };
    const apply = () => { cancel = ServiceWorkerClient.applyUpdate(() => allowed); };
    return { Worker, old, waiting, registration, container, window, activate, apply,
        deny: () => { allowed = false; }, reloads: () => reloads, registered: () => registered };
}
async function settle() { for (let n = 0; n < 20; n++) await Promise.resolve(); }

test('manual consent activates the requested worker and reloads only once', () => {
    const f = fixture(); f.apply(); f.apply();
    expect(f.waiting.posts).toEqual([{ type: 'skip-waiting' }]);
    f.activate(); f.activate(); expect(f.reloads()).toBe(1);
});

test('Classic no-argument calls can still apply a waiting web update', () => {
    const f = fixture(); cancel = ServiceWorkerClient.applyUpdate();
    expect(f.waiting.posts).toEqual([{ type: 'skip-waiting' }]);
    f.activate(); expect(f.reloads()).toBe(1);
});

test('direct updater calls in local HTML never touch service-worker APIs or reload', () => {
    const f = fixture();
    location.protocol = 'file:';
    Object.defineProperty(navigator, 'serviceWorker', { get: () => { throw new Error('Local HTML accessed service workers'); } });
    ServiceWorkerClient.init(); ServiceWorkerClient.updateReady(); cancel = ServiceWorkerClient.applyUpdate();
    expect(ServiceWorkerClient.initialized).toBe(false); expect(updateModel.updateStatus).toBeNull();
    expect(f.waiting.posts).toEqual([]); expect(f.reloads()).toBe(0);
});

test('an active vault cannot request an update or reload after activation', () => {
    const unsafe = fixture(); unsafe.deny(); unsafe.apply();
    expect(unsafe.waiting.posts).toEqual([]); unsafe.activate(); expect(unsafe.reloads()).toBe(0);
    const racing = fixture(); racing.apply(); racing.deny(); racing.activate(); expect(racing.reloads()).toBe(0);
});

test('an expired activation leaves no delayed reload even after a later lock', () => {
    const f = fixture(); f.apply(); jest.advanceTimersByTime(2500);
    f.activate(); expect(f.reloads()).toBe(0);
});

test('the deadline is enforced even when the timeout callback is queued', () => {
    const f = fixture(); let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    f.apply(); now += 2500; f.activate(); expect(f.reloads()).toBe(0);
});

test('unmount, unlock cancellation and page exit remove activation listeners', () => {
    for (const reason of ['cancel', 'pagehide']) {
        const f = fixture(); f.apply();
        if (reason === 'cancel') cancel!(); else f.window.dispatchEvent(new Event('pagehide'));
        f.activate(); expect(f.reloads()).toBe(0);
    }
});

test('an unrelated controller change cannot consume consent for the requested worker', () => {
    const f = fixture(); f.apply();
    f.container.controller = new f.Worker(); f.container.dispatchEvent(new Event('controllerchange'));
    expect(f.reloads()).toBe(0); f.activate(); expect(f.reloads()).toBe(1);
});

test('missing, foreign and failed waiting workers do not reload', () => {
    for (const reason of ['missing', 'script', 'scope', 'post', 'redundant']) {
        const f = fixture();
        if (reason === 'missing') f.registration.waiting = null;
        if (reason === 'script') f.waiting.scriptURL = 'https://keewebx.app/another.js';
        if (reason === 'scope') f.registration.scope = 'https://keewebx.app/another/';
        if (reason === 'post') f.waiting.postMessage = () => { throw new Error('Worker terminated'); };
        f.apply();
        if (reason === 'redundant') { f.waiting.state = 'redundant'; f.waiting.dispatchEvent(new Event('statechange')); }
        f.activate(); expect(f.reloads()).toBe(0);
    }
});

test('only a waiting app update is ready; initial caching and activated updates are silent', () => {
    const f = fixture(); ServiceWorkerClient.updateReady(); expect(updateModel.updateStatus).toBe('ready');
    f.container.controller = null; ServiceWorkerClient.updateReady(); expect(updateModel.updateStatus).toBeNull();
    f.activate(); ServiceWorkerClient.updateReady(); expect(updateModel.updateStatus).toBeNull();
});

test('init reuses the startup registration and observes an already installing update', async () => {
    const f = fixture(); f.registration.waiting = null; f.registration.installing = f.waiting;
    f.waiting.state = 'installing'; ServiceWorkerClient.init(); await settle();
    expect(f.registered()).toBe(0); expect(updateModel.updateStatus).toBeNull();
    f.registration.installing = null; f.registration.waiting = f.waiting;
    f.waiting.state = 'installed'; f.waiting.dispatchEvent(new Event('statechange'));
    expect(updateModel.updateStatus).toBe('ready'); f.activate(); expect(updateModel.updateStatus).toBeNull();
    expect(f.reloads()).toBe(0);
});
