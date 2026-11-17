import { afterEach, expect, test } from 'bun:test';
import { prepareInstanceReturn, returnToInstance } from '../src/app-instance-return';
import { APP_INSTANCE_MARK } from '../src/app-instance';

const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete (globalThis as any).navigator;
});
const url = 'https://keewebx.app/connect-port/worker.js';
function navigatorWith(serviceWorker: unknown) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker } });
}

test('a broader offline registration must not prevent installing the actual Connect return worker', async () => {
    let installed = 0, updated = 0;
    const offline = { scope: 'https://keewebx.app/', active: { scriptURL: 'https://keewebx.app/service-worker.js' },
        update: async () => { updated++; } };
    const connect = { scope: 'https://keewebx.app/connect-port/', active: { scriptURL: url } };
    navigatorWith({ getRegistration: async () => offline, register: async (script: string, options: RegistrationOptions) => {
        expect(script).toBe(url); expect(options.scope).toBe(connect.scope); expect(options.updateViaCache).toBe('none');
        installed++; return connect;
    } });
    expect(await prepareInstanceReturn('https://keewebx.app/app')).toBe(connect as any);
    expect(installed).toBe(1); expect(updated).toBe(0);
});

test('an exact existing worker is updated without creating another registration', async () => {
    let updated = 0;
    const connect = { scope: 'https://keewebx.app/connect-port/', active: { scriptURL: url }, update: async () => { updated++; } };
    navigatorWith({ getRegistration: async () => connect, register: () => { throw new Error('Unexpected registration'); } });
    expect(await prepareInstanceReturn('https://keewebx.app/next.html')).toBe(connect as any);
    expect(updated).toBe(1);
});

test('a disabled worker service gives a manual fallback', async () => {
    navigatorWith(undefined);
    const registration = prepareInstanceReturn('https://keewebx.app/app');
    expect(await returnToInstance(registration, APP_INSTANCE_MARK + ':/:')).toBe(false);
});

test('focus uses one direct message port with no navigation or new window', async () => {
    const lockName = APP_INSTANCE_MARK + ':/:', calls: unknown[] = [];
    const registration = { active: { postMessage(data: unknown, ports: MessagePort[]) {
        calls.push(data);
        ports[0].postMessage({ marker: APP_INSTANCE_MARK, kind: 'focused', ok: true });
    } } } as unknown as ServiceWorkerRegistration;
    expect(await returnToInstance(Promise.resolve(registration), lockName)).toBe(true);
    expect(calls).toEqual([{ marker: APP_INSTANCE_MARK, kind: 'focus', lockName }]);
});

test('a departed page cannot send focus after a pending registration resolves', async () => {
    let resolve!: (value: ServiceWorkerRegistration) => void;
    let calls = 0;
    const registration = new Promise<ServiceWorkerRegistration>(yes => { resolve = yes; });
    const controller = new AbortController();
    const returning = returnToInstance(registration, APP_INSTANCE_MARK + ':/:', controller.signal);
    controller.abort();
    resolve({ active: { postMessage() { calls++; } } } as any);
    expect(await returning).toBe(false); expect(calls).toBe(0);
});
