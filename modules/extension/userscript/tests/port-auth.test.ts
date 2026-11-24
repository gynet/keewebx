import { afterEach, beforeEach, expect, test } from 'bun:test';
import { sign } from 'tweetnacl';
import { toBase64 } from '../../src/background/utils';
import { signPortReady, verifyPortReady } from '../src/port-auth';
import { AppSetupTimeoutError, PORT_MARK, SitePortLink } from '../src/direct-ports';
import { watchTransport } from '../src/transport-events';

const endpoint = new URL('https://keewebx.app/app');
const identity = () => ({ appBoot: crypto.randomUUID(), connectionId: crypto.randomUUID(), endpoint: endpoint.href, siteOrigin: 'https://login.example.org' });

test('port receipts authenticate every routing field with a separate signature domain', () => {
    const keys = sign.keyPair(), value = identity(), proof = signPortReady(value, keys.secretKey), publicKey = toBase64(keys.publicKey);
    expect(verifyPortReady(value, proof, publicKey)).toBe(true);
    for (const field of ['appBoot', 'connectionId', 'endpoint', 'siteOrigin'] as const) {
        expect(verifyPortReady({ ...value, [field]: value[field] + 'changed' }, proof, publicKey)).toBe(false);
    }
    expect(verifyPortReady(value, proof, toBase64(sign.keyPair().publicKey))).toBe(false);
    for (const bad of [undefined, null, '', 'x'.repeat(88), { proof }]) expect(verifyPortReady(value, bad, publicKey)).toBe(false);
    const rpc = toBase64(sign.detached(new TextEncoder().encode(JSON.stringify(value)), keys.secretKey));
    expect(verifyPortReady(value, rpc, publicKey)).toBe(false);
});

class Port {
    onmessage?: (event: { data: unknown }) => void;
    onmessageerror?: () => void;
    closed = false;
    postMessage() {}
    start() {}
    close() { this.closed = true; }
}
const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(key: string, value: unknown) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
let link: SitePortLink, port: Port, helperClosed: boolean, closeAllowed: boolean, keys: ReturnType<typeof sign.keyPair>, route: any;
let closeAttempts: number;
let windowMessage: (event: MessageEvent) => void;
let helper: { readonly closed: boolean; close(): void; postMessage(data: unknown, origin: string): void }, helperPosts: { data: any; origin: string }[];
beforeEach(() => {
    helperClosed = false; closeAllowed = true; closeAttempts = 0; helperPosts = []; keys = sign.keyPair();
    route = { host: crypto.randomUUID(), endpoint: endpoint.href, publicKey: toBase64(keys.publicKey), messagePort: 1, readyProof: 1 };
    replace('location', { origin: 'https://login.example.org', href: 'https://login.example.org/login' });
    replace('addEventListener', (name: string, listener: (event: MessageEvent) => void) => {
        if (name === 'message') windowMessage = listener;
    });
    replace('removeEventListener', () => {});
    helper = { get closed() { return helperClosed; }, close() { closeAttempts++; if (closeAllowed) helperClosed = true; },
        postMessage(data, origin) { helperPosts.push({ data: structuredClone(data), origin }); } };
    replace('window', { open: () => helper });
    replace('MessageChannel', class { port1 = port = new Port(); port2 = new Port(); });
    link = new SitePortLink(endpoint); link.configure(route); link.open();
});
afterEach(() => {
    link.dispose();
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as any)[key];
    }
    originals.clear();
});
function ready() {
    return { marker: PORT_MARK, kind: 'ready', appBoot: route.host, connectionId: (link as any).id,
        endpoint: endpoint.href, siteOrigin: location.origin };
}
test('a verified receipt closes the helper synchronously before any RPC round trip', async () => {
    const connected = link.connect(), value = ready();
    let requests = 0; port.postMessage = () => { requests++; };
    port.onmessage!({ data: { ...value, proof: signPortReady(value, keys.secretKey) } });
    expect(helperClosed).toBe(true);
    expect(requests).toBe(0);
    expect(port.closed).toBe(false);
    expect(await connected).toBe(link.generation);
});
test('a queued ready event cannot revive a setup after its absolute deadline', async () => {
    const result = link.connect().catch(error => error), value = ready();
    const NativeDate = Date, now = Date.now();
    replace('Date', class extends NativeDate { static now() { return now + 26000; } });
    // Deliver the event before the delayed timeout callback, as on tab resume.
    port.onmessage!({ data: { ...value, proof: signPortReady(value, keys.secretKey) } });
    expect((await result).message).toContain('connection attempt expired');
    expect(link.authenticatedReady).toBe(false);
    expect(port.closed).toBe(true);
});
test('a silent cross-window close failure retains the helper and asks its own page to close', async () => {
    closeAllowed = false;
    const connected = link.connect(), value = ready();
    port.onmessage!({ data: { ...value, proof: signPortReady(value, keys.secretKey) } });
    await connected;
    expect(helperClosed).toBe(false); expect((link as any).helper).toBe(helper);
    expect(helperPosts).toEqual([{ origin: endpoint.origin, data: { marker: PORT_MARK, kind: 'relay-complete',
        nonce: (link as any).nonce, connectionId: value.connectionId, endpoint: endpoint.href } }]);
    link.confirm(); expect(helperPosts).toHaveLength(1);
    // The helper's page-world close later succeeds independently.
    helperClosed = true; link.confirm(); expect((link as any).helper).toBeUndefined();
    expect(port.closed).toBe(false);
});
test.each(['reset', 'reconnect', 'dispose'])('retained helper cleanup never closes a replacement document (%s)', async action => {
    closeAllowed = false;
    const connected = link.connect(), value = ready();
    port.onmessage!({ data: { ...value, proof: signPortReady(value, keys.secretKey) } }); await connected;
    expect(closeAttempts).toBe(1);
    // The retained window can navigate. Its old nonce is harmless to a new page.
    if (action === 'reset') link.reset();
    else if (action === 'reconnect') link.open(true);
    else link.dispose();
    expect(closeAttempts).toBe(1);
});
test('helper closure is never accepted as a substitute for the App signature', async () => {
    helperClosed = true;
    const result = link.connect().catch(error => error);
    port.onmessage!({ data: ready() });
    expect((await result).message).toContain('signature could not be verified');
    expect(port.closed).toBe(true);
});
test('a failed setup cancels its own helper when cross-window close is denied', async () => {
    closeAllowed = false;
    const result = link.connect().catch(error => error), value = ready();
    const nonce = (link as any).nonce;
    port.onmessage!({ data: { marker: PORT_MARK, kind: 'error', message: 'Connect is disabled.' } });
    expect((await result).message).toBe('Connect is disabled.');
    expect(helperPosts).toContainEqual({ origin: endpoint.origin, data: { marker: PORT_MARK, kind: 'relay-cancel',
        nonce, connectionId: value.connectionId, endpoint: endpoint.href } });
    expect(link.authenticatedReady).toBe(false);
});
test.each(['app-timeout', 'worker-unavailable', 'helper-unavailable', 'noapp', 'refreshed', 'disabled', 'invalid'])('the helper can report %s when the transferred port delivers no error', async code => {
    const connectionId = code === 'worker-unavailable' ? '' : ready().connectionId;
    const data = { marker: PORT_MARK, kind: 'error', code, message: 'Connection setup failed.', nonce: (link as any).nonce, connectionId };
    const event = { isTrusted: true, source: helper, origin: endpoint.origin, ports: [], data };
    for (const wrong of [{ isTrusted: false }, { source: {} }, { origin: location.origin }, { ports: [new Port()] },
        { data: { ...data, nonce: crypto.randomUUID() } }, { data: { ...data, connectionId: crypto.randomUUID() } }]) {
        windowMessage({ ...event, ...wrong } as MessageEvent);
        expect(port.closed).toBe(false);
    }
    // The caller may resume after the helper has already closed.
    windowMessage(event as unknown as MessageEvent);
    const error = await link.connect().catch(error => error);
    expect(error.message).toBe(data.message);
    expect(error instanceof AppSetupTimeoutError).toBe(['app-timeout', 'worker-unavailable', 'helper-unavailable'].includes(code));
    expect(port.closed).toBe(true);
    expect(link.authenticatedReady).toBe(false);
});
test.each(['noapp', 'refreshed', 'helper-unavailable', 'app-timeout', 'private-error-with-account-data'])
('local failure events preserve only an allowlisted relay code (%s)', async code => {
    const events: unknown[] = [];
    const stop = watchTransport(event => { if (event.event === 'relay-error') events.push(event); });
    try {
        const connectionId = ready().connectionId;
        windowMessage({ isTrusted: true, source: helper, origin: endpoint.origin, ports: [], data: {
            marker: PORT_MARK, kind: 'error', code, message: 'Never include this arbitrary message in the log.',
            nonce: (link as any).nonce, connectionId
        } } as unknown as MessageEvent);
        await link.connect().catch(() => {});
        expect(events).toEqual([{ event: 'relay-error', portId: connectionId,
            reason: code === 'app-timeout' ? 'timeout' : 'unavailable',
            ...(code.startsWith('private-') ? {} : { relayCode: code }) }]);
    } finally { stop(); }
});
test('a helper error cannot disrupt an authenticated port', async () => {
    const connected = link.connect(), value = ready();
    const nonce = (link as any).nonce;
    port.onmessage!({ data: { ...value, proof: signPortReady(value, keys.secretKey) } });
    await connected;
    windowMessage({ isTrusted: true, source: helper, origin: endpoint.origin, ports: [], data: {
        marker: PORT_MARK, kind: 'error', code: 'app-timeout', message: 'Late failure.', nonce, connectionId: value.connectionId
    } } as unknown as MessageEvent);
    expect(port.closed).toBe(false);
    expect(link.authenticatedReady).toBe(true);
});
test.each(['missing', 'forged', 'wrong connection', 'wrong site'])('a required receipt cannot be bypassed (%s)', async scenario => {
    const rejected = link.connect().catch(error => error);
    const value = ready();
    const other = { ...value, ...(scenario === 'wrong connection' ? { connectionId: crypto.randomUUID() } : scenario === 'wrong site' ? { siteOrigin: 'https://attacker.example' } : {}) };
    const proof = scenario === 'missing' ? undefined : scenario === 'forged' ? toBase64(crypto.getRandomValues(new Uint8Array(64))) : signPortReady(other, keys.secretKey);
    port.onmessage!({ data: { ...value, proof } });
    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('signature could not be verified');
    expect(port.closed).toBe(true);
});
test('an older receiver still waits for its signed RPC handshake before closing the helper', async () => {
    link.configure({ ...route, readyProof: undefined });
    const connected = link.connect(); port.onmessage!({ data: ready() });
    await connected;
    expect(helperClosed).toBe(false);
    link.confirm(); expect(helperClosed).toBe(true);
});
