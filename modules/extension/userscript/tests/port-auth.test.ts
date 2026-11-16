import { afterEach, beforeEach, expect, test } from 'bun:test';
import { sign } from 'tweetnacl';
import { toBase64 } from '../../src/background/utils';
import { signPortReady, verifyPortReady } from '../src/port-auth';
import { PORT_MARK, SitePortLink } from '../src/direct-ports';

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
let link: SitePortLink, port: Port, helperClosed: boolean, keys: ReturnType<typeof sign.keyPair>, route: any;
beforeEach(() => {
    helperClosed = false; keys = sign.keyPair();
    route = { host: crypto.randomUUID(), endpoint: endpoint.href, publicKey: toBase64(keys.publicKey), messagePort: 1, readyProof: 1 };
    replace('location', { origin: 'https://login.example.org', href: 'https://login.example.org/login' });
    replace('addEventListener', () => {}); replace('removeEventListener', () => {});
    replace('window', { open: () => ({ close() { helperClosed = true; } }) });
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
