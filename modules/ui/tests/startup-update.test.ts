import { afterEach, expect, jest, test } from 'bun:test';
import { checkStartupUpdate } from '../src/startup-update';

const scriptURL = 'https://keewebx.app/service-worker.js';
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
async function settle() { for (let n = 0; n < 20; n++) await Promise.resolve(); }

function fixture() {
    class Worker extends EventTarget {
        scriptURL = 'https://keewebx.app/service-worker.js';
        state: ServiceWorkerState = 'installed';
        posts: unknown[] = [];
        postMessage(data: unknown) { this.posts.push(data); }
    }
    const old = new Worker(), waiting = new Worker();
    let reloads = 0, updates = 0, registrations = 0, allowed = true;
    const registration = Object.assign(new EventTarget(), { scope: 'https://keewebx.app/',
        active: old as Worker | null, waiting: null as Worker | null, installing: null as Worker | null,
        update: async () => { updates++; } });
    const container = Object.assign(new EventTarget(), { controller: old as Worker | null,
        getRegistration: async (_url: string) => registration as unknown as ServiceWorkerRegistration | undefined,
        register: async (url: string, options: RegistrationOptions) => {
            registrations++; expect(url).toBe(scriptURL); expect(options.updateViaCache).toBe('none');
            return registration as unknown as ServiceWorkerRegistration;
        } });
    const options = { container: container as unknown as ServiceWorkerContainer, scriptURL,
        reload: () => { reloads++; }, canReload: () => allowed, timeoutMs: 2500 };
    const activate = () => {
        registration.active = waiting; registration.waiting = registration.installing = null;
        waiting.state = 'activated'; container.controller = waiting;
        container.dispatchEvent(new Event('controllerchange'));
    };
    return { Worker, old, waiting, registration, container, options, activate,
        reloads: () => reloads, updates: () => updates, registrations: () => registrations,
        deny: () => { allowed = false; } };
}

test('a waiting version is activated and reloaded before a vault may start', async () => {
    const f = fixture(); f.registration.waiting = f.waiting;
    const checking = checkStartupUpdate(f.options); await settle();
    expect(f.waiting.posts).toEqual([{ type: 'skip-waiting' }]); expect(f.reloads()).toBe(0);
    f.activate(); expect(await checking).toBe('reloading'); expect(f.reloads()).toBe(1);
    f.activate(); expect(f.reloads()).toBe(1);
});

test('every controlled startup checks the network when no update is pending', async () => {
    const f = fixture(); expect(await checkStartupUpdate(f.options)).toBe('continue');
    expect(f.updates()).toBe(1); expect(f.reloads()).toBe(0);
});

test('a first visit starts without waiting for its offline precache or reloading', async () => {
    const f = fixture(); f.container.controller = null; f.registration.active = null; f.registration.installing = f.waiting;
    expect(await checkStartupUpdate(f.options)).toBe('continue'); expect(f.reloads()).toBe(0); expect(f.updates()).toBe(0);
});

test('a download that finishes after the startup budget cannot reload a running vault', async () => {
    jest.useFakeTimers(); const f = fixture(); f.registration.installing = f.waiting; f.waiting.state = 'installing';
    const checking = checkStartupUpdate(f.options); await settle(); jest.advanceTimersByTime(2500);
    expect(await checking).toBe('continue'); f.registration.installing = null; f.registration.waiting = f.waiting;
    f.waiting.state = 'installed'; f.waiting.dispatchEvent(new Event('statechange')); f.activate();
    expect(f.waiting.posts).toEqual([]); expect(f.reloads()).toBe(0);
});

test('offline and hung version checks continue within the same startup budget', async () => {
    const offline = fixture(); offline.registration.update = async () => { throw new Error('Offline'); };
    expect(await checkStartupUpdate(offline.options)).toBe('continue'); expect(offline.reloads()).toBe(0);
    jest.useFakeTimers(); const hung = fixture(); hung.registration.update = () => new Promise(() => {});
    const checking = checkStartupUpdate(hung.options); await settle(); jest.advanceTimersByTime(2500);
    expect(await checking).toBe('continue'); expect(hung.reloads()).toBe(0);
});

test('abort while reading registrations prevents a late worker registration or reload', async () => {
    const f = fixture(), controller = new AbortController();
    let resolve!: (value: ServiceWorkerRegistration | undefined) => void;
    f.container.getRegistration = () => new Promise(yes => { resolve = yes; });
    const checking = checkStartupUpdate({ ...f.options, signal: controller.signal });
    controller.abort(); expect(await checking).toBe('continue'); resolve(undefined); await settle();
    expect(f.registrations()).toBe(0); expect(f.reloads()).toBe(0);
});

test('a new active vault or lost App ownership prevents reloading after activation', async () => {
    const f = fixture(); f.registration.waiting = f.waiting;
    const checking = checkStartupUpdate(f.options); await settle(); f.deny(); f.activate();
    expect(await checking).toBe('continue'); expect(f.reloads()).toBe(0);
});

test('expiry before a queued state event cannot activate a new worker', async () => {
    jest.useFakeTimers(); const f = fixture(); f.registration.installing = f.waiting;
    let now = 1000; jest.spyOn(Date, 'now').mockImplementation(() => now);
    const checking = checkStartupUpdate(f.options); await settle(); now += 3000;
    f.registration.waiting = f.waiting; f.waiting.dispatchEvent(new Event('statechange'));
    expect(f.waiting.posts).toEqual([]); jest.advanceTimersByTime(2500); expect(await checking).toBe('continue');
});
