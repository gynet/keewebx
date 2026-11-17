import { afterEach, beforeEach, expect, test } from 'bun:test';
import { AppBridge, watchAppLockState, type AppBridgeCapabilities } from '../src/app-bridge';

const original = new Map<string, PropertyDescriptor | undefined>();
function replace(name: string, value: unknown) {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
let bridge: AppBridge, capabilities: AppBridgeCapabilities, now: number, next: number;
let listener: (event: MessageEvent) => void, windowObject: { postMessage(value: unknown): void };
let sent: any[], timers: Map<number, { callback: () => void; due: number; repeat: number }>;
let failedSend: boolean;
const origin = 'https://keewebx.app';
beforeEach(() => {
    capabilities = { receipts: false }; now = Date.now(); next = 0; sent = []; timers = new Map(); failedSend = false;
    const NativeDate = Date;
    replace('Date', class extends NativeDate { static now() { return now; } });
    const schedule = (callback: () => void, ms: number, repeat: number) => { const id = ++next; timers.set(id, { callback, due: now + ms, repeat }); return id; };
    replace('setTimeout', (callback: () => void, ms: number) => schedule(callback, ms, 0));
    replace('setInterval', (callback: () => void, ms: number) => schedule(callback, ms, ms));
    replace('clearTimeout', (id: number) => timers.delete(id)); replace('clearInterval', (id: number) => timers.delete(id));
    replace('location', { origin });
    windowObject = { postMessage(value: unknown) { if (failedSend) throw new Error('Injected send failure'); sent.push(structuredClone(value)); } };
    replace('window', windowObject);
    replace('addEventListener', (_name: string, callback: typeof listener) => { listener = callback; });
    replace('removeEventListener', () => {});
    bridge = new AppBridge(origin, 'https://login.example.org', capabilities);
});
afterEach(() => {
    try { bridge.dispose(); } finally {
        for (const [name, descriptor] of original) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name];
        }
        original.clear();
    }
});
function tick(ms: number) {
    const until = now + ms;
    for (;;) {
        const entry = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!entry || entry[1].due > until) break;
        const [id, timer] = entry; now = timer.due;
        if (timer.repeat) timer.due += timer.repeat; else timers.delete(id);
        timer.callback();
    }
    now = until;
}
function respond(request = sent.at(-1), data: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
    listener({ isTrusted: true, source: windowObject, origin,
        data: { kwConnect: 'response', kwConnection: request.kwConnection, action: request.action,
            kwRequest: request.kwRequest, kwAttempt: request.kwAttempt, kwReceipt: 1,
            message: 'encrypted response', nonce: 'fixture nonce', ...data }, ...event } as unknown as MessageEvent);
}
test('lock state is queried and follows App unlock independently of reset bridge ports', () => {
    const states: boolean[] = [];
    const stop = watchAppLockState(unlocked => states.push(unlocked));
    try {
        expect(sent.at(-1)).toEqual({ kwConnect: 'get-state' });
        const notify = (action: string, event: Record<string, unknown> = {}) => listener({ isTrusted: true,
            source: windowObject, origin, data: { kwConnect: 'state', action }, ...event } as unknown as MessageEvent);
        notify('database-unlocked');
        bridge.reset();
        notify('database-locked');
        notify('database-unlocked');
        expect(states).toEqual([true, false, true]);
        for (const event of [{ isTrusted: false }, { source: {} }, { origin: 'https://attacker.example' }]) notify('database-locked', event);
        notify('attention-required');
        expect(states).toEqual([true, false, true]);
    } finally { stop(); }
});

test('an older App remains single-send and cannot accidentally enable request retries', async () => {
    const pending = bridge.request({ action: 'kwx-features' }, now + 3000);
    tick(750); expect(sent).toHaveLength(1);
    respond(sent[0], { kwRequest: undefined, kwAttempt: undefined, kwReceipt: undefined }); await pending;
    expect(capabilities.receipts).toBe(false); expect(timers.size).toBe(0);
});
test.each([false, true])('a new request requires its matching attempt when receipt support is %s', async supported => {
    capabilities.receipts = supported;
    let settled = false;
    const pending = bridge.request({ action: 'kwx-features' }, now + 3000).then(response => { settled = true; return response; });
    const request = sent.at(-1);
    expect(request.kwAttempt).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
    respond(request, { kwAttempt: crypto.randomUUID() });
    respond(request, { kwAttempt: undefined });
    await Promise.resolve();
    expect(settled).toBe(false); expect(capabilities.receipts).toBe(supported);
    expect(timers.size).toBe(supported ? 2 : 1);
    respond(request);
    expect(await pending).toEqual({ action: 'kwx-features', message: 'encrypted response', nonce: 'fixture nonce' });
    expect(capabilities.receipts).toBe(true); expect(timers.size).toBe(0);
});
test('capable Apps retry only the identical payload and correlate the exact request id and attempt', async () => {
    const initial = bridge.request({ action: 'kwx-features' }, now + 3000);
    const initialAttempt = sent.at(-1).kwAttempt;
    respond(); await initial; expect(capabilities.receipts).toBe(true);
    const pending = bridge.request({ action: 'kwx-get-entry-fields', message: 'encrypted request', nonce: 'fixture request nonce' }, now + 3000);
    const request = sent.at(-1), count = sent.length;
    expect(request.kwAttempt).not.toBe(initialAttempt);
    tick(750); expect(sent).toHaveLength(count + 1); expect(sent.at(-1)).toEqual(request);
    respond(request, { kwRequest: crypto.randomUUID() }); expect(timers.size).toBe(2);
    respond(request);
    expect(await pending).toEqual({ action: 'kwx-get-entry-fields', message: 'encrypted response', nonce: 'fixture nonce' });
    expect(timers.size).toBe(0); const after = sent.length; tick(6000); expect(sent).toHaveLength(after);
});
test.each(['reset', 'dispose', 'timeout', 'retry send failure'])('an inner request stops all timers on %s', async action => {
    capabilities.receipts = true;
    const result = bridge.request({ action: 'kwx-get-entry-fields', message: 'encrypted request' }, now + 3000).catch(error => error);
    tick(750);
    if (action === 'reset') bridge.reset();
    else if (action === 'dispose') bridge.dispose();
    else if (action === 'timeout') tick(3000);
    else { failedSend = true; tick(750); }
    expect(await result).toBeInstanceOf(Error); expect(timers.size).toBe(0);
    const count = sent.length; tick(6000); expect(sent).toHaveLength(count);
});
test('a failed initial send releases pending state before the next request', async () => {
    capabilities.receipts = true; failedSend = true;
    const result = await bridge.request({ action: 'kwx-features' }, now + 3000).catch(error => error);
    expect(result).toBeInstanceOf(Error); expect(timers.size).toBe(0);
    failedSend = false;
    const next = bridge.request({ action: 'kwx-features' }, now + 3000); respond(); await next;
    expect(timers.size).toBe(0);
});
test('foreign, untrusted or old replies cannot resolve a pending request or enable retries', async () => {
    const result = bridge.request({ action: 'kwx-features' }, now + 3000).catch(error => error), request = sent[0];
    for (const event of [{ isTrusted: false }, { source: {} }, { origin: 'https://attacker.example' }]) respond(request, {}, event);
    respond(request, { kwRequest: crypto.randomUUID() });
    expect(capabilities.receipts).toBe(false); expect(timers.size).toBe(1);
    bridge.reset(); expect(await result).toBeInstanceOf(Error); expect(timers.size).toBe(0);
});

test('revalidation changes only the attempt and can return a fresh denial', async () => {
    capabilities.receipts = true;
    const request = { action: 'kwx-get-entry-fields', message: 'encrypted request', nonce: 'fixture nonce' }, deadline = now + 3000;
    const first = bridge.request(request, deadline), payload = structuredClone(sent.at(-1));
    respond(payload); await first;
    const replay = bridge.replay(request, deadline);
    const replayPayload = sent.at(-1);
    const { kwAttempt: firstAttempt, ...originalExecution } = payload;
    const { kwAttempt: replayAttempt, ...replayExecution } = replayPayload;
    expect(replayAttempt).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
    expect(replayAttempt).not.toBe(firstAttempt); expect(replayExecution).toEqual(originalExecution);
    const count = sent.length;
    tick(750); expect(sent).toHaveLength(count + 1); expect(sent.at(-1)).toEqual(replayPayload);
    respond(replayPayload, { message: undefined, nonce: undefined, error: 'Access revoked', errorCode: '6' });
    const result = await replay as Record<string, unknown>;
    expect(result.error).toBe('Access revoked'); expect(result.message).toBeUndefined();
    expect(timers.size).toBe(0);
});
test('a queued success from attempt A cannot resolve replay B before its fresh denial', async () => {
    capabilities.receipts = true;
    const request = { action: 'kwx-get-entry-fields', message: 'encrypted request', nonce: 'fixture request nonce' };
    const deadline = now + 3000, oldCiphertext = 'ciphertext prepared before permission revocation';
    const success = { message: oldCiphertext, nonce: 'original response nonce' };
    const first = bridge.request(request, deadline), attemptA = structuredClone(sent.at(-1));
    respond(attemptA, success);
    expect((await first).message).toBe(oldCiphertext);

    let settled = false;
    const replay = bridge.replay(request, deadline).then(response => { settled = true; return response; });
    const attemptB = structuredClone(sent.at(-1));
    expect(attemptB.kwAttempt).not.toBe(attemptA.kwAttempt);
    expect(attemptB.kwRequest).toBe(attemptA.kwRequest);
    // Deliver an exact copy of the successful A response after revocation, while B is pending.
    respond(attemptA, success);
    await Promise.resolve();
    expect(settled).toBe(false); expect(timers.size).toBe(2);
    respond(attemptB, { message: undefined, nonce: undefined, error: 'Access revoked', errorCode: '6' });
    const result = await replay;
    expect(result).toEqual({ action: request.action, message: undefined, nonce: undefined, error: 'Access revoked', errorCode: '6' });
    expect(JSON.stringify(result)).not.toContain(oldCiphertext);
    expect(settled).toBe(true); expect(timers.size).toBe(0);
    const count = sent.length;
    tick(6000); expect(sent).toHaveLength(count);
});
test('an App receipt cannot change its request, deadline, bridge lifetime or expired deadline', async () => {
    capabilities.receipts = true;
    const request = { action: 'kwx-get-entry-fields', message: 'encrypted request' }, deadline = now + 3000;
    const first = bridge.request(request, deadline); respond(); await first;
    const count = sent.length;
    await expect(bridge.replay({ ...request, message: 'changed' }, deadline)).rejects.toThrow('no longer available');
    await expect(bridge.replay(request, deadline + 1)).rejects.toThrow('no longer available');
    expect(sent).toHaveLength(count);
    tick(3000);
    await expect(bridge.replay(request, deadline)).rejects.toThrow('expired');
    bridge.reset();
    await expect(bridge.replay(request, deadline)).rejects.toThrow('no longer available');
    expect(timers.size).toBe(0);
});
