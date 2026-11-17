import { afterEach, expect, test } from 'bun:test';

const savedListener = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value() {} });
const { diagnosticRequest } = await import('../src/diagnostics');
if (savedListener) Object.defineProperty(globalThis, 'addEventListener', savedListener);
else delete (globalThis as any).addEventListener;

const savedGM = Object.getOwnPropertyDescriptor(globalThis, 'GM');
const endpoint = '/api/connect-diagnostics/session';
const url = 'https://keewebx.app' + endpoint;
function manager(xmlHttpRequest: (details: any) => any) {
    Object.defineProperty(globalThis, 'GM', { configurable: true, value: { xmlHttpRequest } });
}
afterEach(() => {
    if (savedGM) Object.defineProperty(globalThis, 'GM', savedGM);
    else delete (globalThis as any).GM;
});

test('privileged diagnostic HTTP is restricted to the fixed support API', async () => {
    let calls = 0;
    manager(() => { calls++; });
    for (const path of ['https://evil.example/api', '/api/passkey-sync', '/api/connect-diagnostics/session?token=x',
        '/api/connect-diagnostics/../session', '/api/connect-diagnostics/session#x']) {
        await expect(diagnosticRequest(path, {}, 'temporary', new AbortController().signal)).rejects.toThrow();
    }
    expect(calls).toBe(0);
});

test('Userscripts abortable Promise is canceled when diagnostics stops', async () => {
    let aborted = 0;
    manager(details => {
        expect(details.url).toBe(url);
        expect(details.responseType).toBe('text');
        expect(details.anonymous).toBe(true);
        const request = new Promise(() => {}) as Promise<unknown> & { abort(): void };
        request.abort = () => { aborted++; details.onabort(); };
        return request;
    });
    const controller = new AbortController();
    const request = diagnosticRequest(endpoint, {}, undefined, controller.signal);
    controller.abort();
    await expect(request).rejects.toThrow('stopped');
    expect(aborted).toBe(1);
});

test('actual responseURL is checked and duplicate callback/Promise completion is harmless', async () => {
    manager(details => {
        const response = { status: 200, responseText: '{"ok":true}', responseURL: url };
        details.onload(response);
        return Promise.resolve(response);
    });
    expect(await diagnosticRequest(endpoint, {}, undefined, new AbortController().signal)).toEqual({ ok: true });
    manager(() => Promise.resolve({ status: 200, responseText: '{}', responseURL: 'https://evil.example/' }));
    await expect(diagnosticRequest(endpoint, {}, undefined, new AbortController().signal)).rejects.toThrow('Invalid');
});

test('an already aborted request never starts HTTP and late replies cannot settle cancellation', async () => {
    let calls = 0;
    manager(() => { calls++; });
    const canceled = new AbortController(); canceled.abort();
    await expect(diagnosticRequest(endpoint, {}, undefined, canceled.signal)).rejects.toThrow();
    expect(calls).toBe(0);
    let late!: (response: unknown) => void;
    manager(details => { late = details.onload; return { abort() {} }; });
    const controller = new AbortController();
    const result = diagnosticRequest(endpoint, {}, undefined, controller.signal);
    controller.abort(); late({ status: 200, responseText: '{}', responseURL: url });
    await expect(result).rejects.toThrow('stopped');
});
