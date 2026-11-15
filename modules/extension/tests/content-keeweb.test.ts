import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

let original: Map<string, PropertyDescriptor | undefined>;
let connect: (port: any) => void;
let listeners: Set<(event: any) => void>;
let page: any;
let instance = 0;
const posted = mock((_message: unknown, _origin: string) => {});
beforeEach(async () => {
    original = new Map(['window', 'location', 'chrome'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    listeners = new Set(); posted.mockClear();
    page = { location: { origin: 'https://vault.example' },
        addEventListener: (_name: string, listener: (event: any) => void) => listeners.add(listener),
        removeEventListener: (_name: string, listener: (event: any) => void) => listeners.delete(listener), postMessage: posted };
    for (const [name, value] of Object.entries({ window: page, location: page.location, chrome: { runtime: {
        id: 'test-extension', onConnect: { addListener: (listener: typeof connect) => { connect = listener; } },
        sendMessage: async () => {}
    } } })) Object.defineProperty(globalThis, name, { value, configurable: true });
    // Exercise the real injected module in a fresh synthetic document each time.
    await import(`../src/content/content-keeweb.ts?document=${instance++}`);
});
afterEach(() => {
    for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});
function port(name: string) {
    let disconnect!: () => void, message!: (value: unknown) => void;
    const response = mock((_value: unknown) => {});
    connect({ name, sender: { id: 'test-extension' }, postMessage: response,
        onDisconnect: { addListener: (listener: typeof disconnect) => { disconnect = listener; } },
        onMessage: { addListener: (listener: typeof message) => { message = listener; } } });
    return { disconnect, message, response };
}
function deliver(data: unknown, source = page, origin = page.location.origin) {
    for (const listener of listeners) listener({ data, source, origin });
}
test('disconnect removes the old listener and identifies the abandoned port to the app', () => {
    const old = port('old'), fresh = port('new');
    old.message({ action: 'get-logins' });
    expect(posted.mock.calls[0]).toEqual([{ action: 'get-logins', kwConnect: 'request', kwConnection: 'old' }, 'https://vault.example']);
    old.disconnect();
    expect(posted.mock.calls[1]).toEqual([{ kwConnect: 'disconnected', kwConnection: 'old' }, 'https://vault.example']);
    deliver({ kwConnect: 'response', kwConnection: 'new', action: 'get-logins', message: 'new ciphertext' });
    expect(old.response).not.toHaveBeenCalled();
    expect(fresh.response).toHaveBeenCalledWith({ action: 'get-logins', message: 'new ciphertext' });
});
test('responses are scoped to their live port without mutating the shared window message', () => {
    const old = port('old'), fresh = port('new');
    const response = { kwConnect: 'response', kwConnection: 'new', message: 'ciphertext' };
    deliver(response);
    expect(old.response).not.toHaveBeenCalled(); expect(fresh.response).toHaveBeenCalledWith({ message: 'ciphertext' });
    expect(response.kwConnect).toBe('response'); expect(response.kwConnection).toBe('new');
});
test('legacy untagged app responses still reach the compatible bridge', () => {
    const client = port('compatible'); deliver({ kwConnect: 'response', message: 'legacy ciphertext' });
    expect(client.response).toHaveBeenCalledWith({ message: 'legacy ciphertext' });
});
test('another window or origin cannot send bridge responses', () => {
    const client = port('current');
    deliver({ kwConnect: 'response', message: 'foreign' }, {}, page.location.origin);
    deliver({ kwConnect: 'response', message: 'foreign' }, page, 'https://other.example');
    expect(client.response).not.toHaveBeenCalled();
});
