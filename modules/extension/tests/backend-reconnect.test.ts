import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { box } from 'tweetnacl';
import { backend } from '../src/background/backend';
import { ProtocolImpl, type KeeWebXFeatures } from '../src/background/protocol/protocol-impl';
import { ProtocolError } from '../src/background/protocol/protocol-error';
import type { KeeWebConnectResponse } from '../src/background/protocol/types';

const features: KeeWebXFeatures = { features: ['entries-v1'], locked: false, paired: true, canList: true };
type Backend = typeof backend;
type Internals = { _protocol: ProtocolImpl; _paired: boolean; reconnect(): Promise<void> };
let client: Backend;
let internals: Internals;
let reconnect: ReturnType<typeof spyOn<Internals, 'reconnect'>>;
let previousChrome: PropertyDescriptor | undefined;

function protocolResponse(response: KeeWebConnectResponse): ProtocolImpl {
    const protocol = new ProtocolImpl({ request: async () => response });
    Object.assign(protocol, { _keewebPublicKey: box.keyPair().publicKey });
    return protocol;
}
function failWith(error: Error): ProtocolImpl {
    const protocol = new ProtocolImpl({ request: async () => { throw error; } });
    Object.assign(protocol, { _keewebPublicKey: box.keyPair().publicKey });
    return protocol;
}

beforeEach(() => {
    previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { i18n: { getMessage: () => 'App returned error' } } });
    const BackendClass = backend.constructor as new () => Backend;
    client = new BackendClass();
    internals = client as unknown as Internals;
    internals._paired = true;
    reconnect = spyOn(internals, 'reconnect').mockImplementation(async () => {
        internals._protocol = { features: async () => features } as ProtocolImpl;
    });
});
afterEach(() => {
    reconnect.mockRestore();
    if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
    else Reflect.deleteProperty(globalThis, 'chrome');
});

describe('backend capability discovery after app-side revocation', () => {
    test('actual code-zero disconnected-client response retries once against the fresh protocol', async () => {
        // JSON reproduces the numeric zero sent by the existing app wire protocol.
        internals._protocol = protocolResponse(JSON.parse('{"action":"kwx-features","error":"Client not connected: qf4y0grr8ODp3p8TDtuFEMLpXoY/foR8","errorCode":0}'));
        expect(await client.features()).toEqual(features);
        expect(reconnect).toHaveBeenCalledTimes(1);
    });
    test('a failed reconnect is surfaced, never reported as legacy capability support', async () => {
        internals._protocol = protocolResponse({ error: 'Client not connected: clientId' });
        reconnect.mockImplementation(async () => { throw new Error('Reconnect failed'); });
        await expect(client.features()).rejects.toThrow('Reconnect failed');
        expect(reconnect).toHaveBeenCalledTimes(1);
    });
    test('a second disconnected response is surfaced without an unbounded retry', async () => {
        internals._protocol = protocolResponse({ error: 'Client not connected: clientId' });
        reconnect.mockImplementation(async () => {});
        await expect(client.features()).rejects.toThrow('Client not connected: clientId');
        expect(reconnect).toHaveBeenCalledTimes(1);
    });
    test('only an explicit unknown kwx-features handler permits the older-app fallback', async () => {
        internals._protocol = protocolResponse({ error: 'Handler not found: kwx-features' });
        expect(await client.features()).toBeUndefined();
        expect(reconnect).not.toHaveBeenCalled();
        internals._protocol = protocolResponse({ error: 'Internal features error' });
        await expect(client.features()).rejects.toThrow('Internal features error');
        internals._protocol = protocolResponse({ error: 'Handler not found: kwx-get-entries' });
        await expect(client.features()).rejects.toThrow('kwx-get-entries');
    });
    test('an older unpaired app still does not require capability discovery', async () => {
        const probe = mock(async () => features);
        internals._protocol = { features: probe } as unknown as ProtocolImpl;
        internals._paired = false;
        expect(await client.features()).toBeUndefined();
        expect(probe).not.toHaveBeenCalled();
        expect(reconnect).not.toHaveBeenCalled();
    });
    for (const code of ['1', '6', 'kwx-expired-handle']) {
        test(`coded denial ${code} neither reconnects nor falls back, regardless of wording`, async () => {
            internals._protocol = protocolResponse({ error: 'Client not connected: clientId', errorCode: code });
            await expect(client.features()).rejects.toBeInstanceOf(ProtocolError);
            expect(reconnect).not.toHaveBeenCalled();
            internals._protocol = failWith(new ProtocolError('Timeout nonce decrypt', code));
            await expect(client.features()).rejects.toBeInstanceOf(ProtocolError);
            expect(reconnect).not.toHaveBeenCalled();
        });
    }
    test('existing uncoded crypto-session recovery remains bounded', async () => {
        internals._protocol = failWith(new Error('Bad nonce in response'));
        expect(await client.features()).toEqual(features);
        expect(reconnect).toHaveBeenCalledTimes(1);
    });
});
