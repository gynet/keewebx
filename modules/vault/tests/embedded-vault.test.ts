import { afterEach, expect, mock, test } from 'bun:test';

const callbacks = new Map<string, Set<() => void>>();
const events = {
    on(name: string, fn: () => void) { if (!callbacks.has(name)) callbacks.set(name, new Set()); callbacks.get(name)!.add(fn); },
    off(name: string, fn: () => void) { callbacks.get(name)?.delete(fn); },
    emit(name: string) { callbacks.get(name)?.forEach(fn => fn()); }
};
let open = false;
let state = 'open';
const model = { files: { hasOpenFiles: () => open } };
const field = mock(() => ({ text: 'synthetic secret' }));
mock.module('framework/events', () => ({ Events: events }));
mock.module('models/app-model', () => ({ AppModel: { instance: model } }));
mock.module('comp/app/session-access', () => ({ getSessionAccess: () => ({ state }) }));
mock.module('comp/app/vault-api', () => ({ VaultApi: { field } }));
mock.module('util/logger', () => ({ Logger: class { info() {} } }));
let listener: any;
(globalThis as any).location = { protocol: 'chrome-extension:' };
(globalThis as any).chrome = { runtime: {
    id: 'test-extension',
    onMessage: { addListener(fn: any) { listener = fn; }, removeListener(fn: any) { if (listener === fn) listener = undefined; } },
    sendMessage: async () => undefined
} };
const { EmbeddedVault } = await import('../src/comp/extension/embedded-vault');
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); callbacks.clear(); open = false; state = 'open'; field.mockClear(); (globalThis as any).location.search = ''; });
const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/js/background.js' };

test('rejects content-script, missing-origin and foreign-extension callers before reading fields', () => {
    dispose = EmbeddedVault.init();
    for (const untrusted of [{ id: sender.id, url: 'https://example.com' }, { id: sender.id },
        { id: 'other', url: sender.url }, { id: sender.id, url: 'chrome-extension://test-extension.evil/page' }]) {
        expect(listener({ vault: 'field' }, untrusted, () => {})).toBe(false);
    }
    expect(field).not.toHaveBeenCalled();
});

test('extension-owned requests use the shared API and cleanup removes the endpoint', async () => {
    dispose = EmbeddedVault.init();
    const response = await new Promise(resolve => listener({ vault: 'field' }, sender, resolve));
    expect(response).toEqual({ ok: true, result: { text: 'synthetic secret' } });
    dispose?.();
    expect(listener).toBeUndefined();
});

test('lock reply waits for actual file closure instead of acknowledging the event', async () => {
    open = true;
    dispose = EmbeddedVault.init();
    let done = false;
    const response = new Promise(resolve => listener({ vault: 'lock' }, sender, (value: unknown) => { done = true; resolve(value); }));
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(done).toBe(false);
    open = false;
    expect(await response).toEqual({ ok: true, result: { locked: true } });
});

test('failed safe lock rejects without claiming the open vault is closed', async () => {
    open = true;
    dispose = EmbeddedVault.init();
    events.on('lock-workspace', () => { state = 'recovery-required'; });
    const response: any = await new Promise(resolve => listener({ vault: 'lock' }, sender, resolve));
    expect(response.ok).toBe(false);
    expect(response.error).toContain('could not lock safely');
    expect(open).toBe(true);
});

test('a visible tab cannot acknowledge a lock intended for the hidden vault', async () => {
    dispose = EmbeddedVault.init();
    const request = { vault: 'lock', vaultContext: 'offscreen' };
    expect(listener(request, sender, () => {})).toBe(false);
    (globalThis as any).location.search = '?embedded=offscreen';
    expect(await new Promise(resolve => listener(request, sender, resolve)))
        .toEqual({ ok: true, result: { locked: true } });
});
