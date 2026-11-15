import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { box } from 'tweetnacl';
import {
    ProtocolImpl,
    type KeeWebXFeatures,
    type ProtocolRuntimeAdapter
} from '../src/background/protocol/protocol-impl';
import { ProtocolError } from '../src/background/protocol/protocol-error';
import type {
    KeeWebConnectChangePublicKeysRequest,
    KeeWebConnectChangePublicKeysResponse,
    KeeWebConnectEncryptedRequest,
    KeeWebConnectRequest,
    KeeWebConnectResponse
} from '../src/background/protocol/types';
import { fromBase64, toBase64 } from '../src/background/utils';

const features: KeeWebXFeatures = {
    features: ['entries-v1'],
    locked: false,
    paired: true,
    canList: true
};

function incrementNonce(encoded: string): string {
    const nonce = fromBase64(encoded);
    for (let i = 0; i < nonce.length; i++) {
        nonce[i] = (nonce[i] + 1) & 0xff;
        if (nonce[i] !== 0) break;
    }
    return toBase64(nonce);
}

/** App-side box transport: only the public handshake supplies the client's key. */
class FakeAppBoxTransport {
    readonly keys = box.keyPair();
    readonly requests: KeeWebConnectRequest[] = [];
    readonly payloads: Record<string, unknown>[] = [];
    handshakeOverrides: Partial<KeeWebConnectChangePublicKeysResponse> = {};
    handshakeNonce = incrementNonce;
    responseNonce = incrementNonce;
    payloadNonce: string | undefined;
    payload: Record<string, unknown> = { ...features };
    wireResponse: KeeWebConnectResponse | undefined;
    private clientPublicKey: Uint8Array | undefined;

    async request(request: KeeWebConnectRequest): Promise<KeeWebConnectResponse> {
        this.requests.push(request);
        if (request.action === 'change-public-keys') {
            const handshake = request as KeeWebConnectChangePublicKeysRequest;
            this.clientPublicKey = fromBase64(handshake.publicKey);
            return {
                action: 'change-public-keys',
                appName: 'KeeWebX',
                publicKey: toBase64(this.keys.publicKey),
                nonce: this.handshakeNonce(handshake.nonce),
                ...this.handshakeOverrides
            } as KeeWebConnectChangePublicKeysResponse;
        }

        if (!this.clientPublicKey) throw new Error('Fake app has not completed a handshake');
        const encrypted = request as KeeWebConnectEncryptedRequest;
        const data = box.open(
            fromBase64(encrypted.message),
            fromBase64(encrypted.nonce),
            this.clientPublicKey,
            this.keys.secretKey
        );
        if (!data) throw new Error('Fake app could not decrypt request');
        this.payloads.push(JSON.parse(new TextDecoder().decode(data)));
        if (this.wireResponse) return this.wireResponse;

        const nonce = this.responseNonce(encrypted.nonce);
        const payload = {
            action: request.action,
            ...this.payload,
            nonce: this.payloadNonce ?? nonce
        };
        const message = box(
            new TextEncoder().encode(JSON.stringify(payload)),
            fromBase64(nonce),
            this.clientPublicKey,
            this.keys.secretKey
        );
        return { action: request.action, nonce, message: toBase64(message) };
    }
}

function runtime(allowDebug?: boolean): ProtocolRuntimeAdapter {
    return {
        getVersion: () => 'userscripts-test',
        getMessage: (key) => `runtime:${key}`,
        allowDebug
    };
}

function setGlobal(name: string, value: unknown): void {
    Object.defineProperty(globalThis, name, { configurable: true, value });
}

let previousGlobals: [string, PropertyDescriptor | undefined][];
let log: ReturnType<typeof spyOn<typeof console, 'log'>>;

beforeEach(() => {
    previousGlobals = ['chrome', 'window', 'self'].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name)
    ]);
    for (const [name] of previousGlobals) Reflect.deleteProperty(globalThis, name);
    log = spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    log.mockRestore();
    for (const [name, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

describe('ProtocolImpl runtime adapter', () => {
    test('handshakes and exchanges encrypted features without Chrome', async () => {
        const app = new FakeAppBoxTransport();
        const protocol = new ProtocolImpl(app, runtime());
        expect('chrome' in globalThis).toBe(false);
        expect(protocol.connectedAppName).toBeUndefined();

        await protocol.changePublicKeys();
        expect(protocol.connectedAppName).toBe('KeeWebX');
        const handshake = app.requests[0] as KeeWebConnectChangePublicKeysRequest;
        expect(handshake).toMatchObject({
            action: 'change-public-keys',
            extensionName: 'KeeWeb Connect',
            version: 'userscripts-test'
        });
        expect(fromBase64(handshake.publicKey)).toHaveLength(32);
        expect(fromBase64(handshake.nonce)).toHaveLength(24);
        expect(fromBase64(handshake.clientID)).toHaveLength(24);

        expect(await protocol.features()).toMatchObject(features);
        expect(app.payloads).toEqual([{ action: 'kwx-features' }]);
        expect(app.requests[1]).toEqual({
            action: 'kwx-features',
            clientID: handshake.clientID,
            message: expect.any(String),
            nonce: expect.any(String)
        });
        expect(log).not.toHaveBeenCalled();
    });

    test('keeps the default Chrome version, localization, and debug behavior', async () => {
        const getManifest = mock(() => ({ version: '1.0.3' }));
        const getMessage = mock((key: string) => `chrome:${key}`);
        setGlobal('chrome', { runtime: { getManifest }, i18n: { getMessage } });
        setGlobal('window', { logDecryptedPayload: true });
        const app = new FakeAppBoxTransport();
        const protocol = new ProtocolImpl(app);

        await protocol.changePublicKeys();
        expect(app.requests[0]).toMatchObject({
            extensionName: 'KeeWeb Connect',
            version: '1.0.3'
        });
        expect(getManifest).toHaveBeenCalledTimes(1);
        expect(await protocol.features()).toMatchObject(features);
        expect(log).toHaveBeenCalledWith('Request payload', { action: 'kwx-features' });
        expect(log).toHaveBeenCalledWith('Response payload', expect.objectContaining(features));

        app.wireResponse = { error: 'Unavailable', keeWebConnectError: 'errorNotConnected' };
        await expect(protocol.features()).rejects.toThrow('chrome:errorNotConnected');
        expect(getMessage).toHaveBeenLastCalledWith('errorNotConnected');
        app.wireResponse = undefined;
        app.payload = { error: 'Denied', errorCode: '6' };
        await expect(protocol.features()).rejects.toMatchObject({
            message: 'chrome:errorAppReturnedError: [code=6] Denied',
            code: '6'
        });
        expect(getMessage).toHaveBeenLastCalledWith('errorAppReturnedError');
    });

    for (const layer of ['wire', 'encrypted'] as const) {
        for (const error of [
            {
                response: { error: 'Unavailable', keeWebConnectError: 'errorNotConnected' },
                message: 'runtime:errorNotConnected'
            },
            {
                response: { error: 'Denied', errorCode: '6' },
                message: 'runtime:errorAppReturnedError: [code=6] Denied'
            },
            {
                response: { error: 'App failure' },
                message: 'runtime:errorAppReturnedError: App failure'
            }
        ]) {
            test(`localizes ${layer} error: ${error.response.error}`, async () => {
                const app = new FakeAppBoxTransport();
                const protocol = new ProtocolImpl(app, runtime());
                await protocol.changePublicKeys();
                if (layer === 'wire') app.wireResponse = error.response;
                else app.payload = error.response;
                const result = protocol.features();
                await expect(result).rejects.toThrow(error.message);
                if (error.response.errorCode) {
                    await expect(result).rejects.toBeInstanceOf(ProtocolError);
                    await expect(result).rejects.toMatchObject({ code: '6' });
                }
            });
        }
    }

    test.each(['window', 'self', 'both'])(
        'disables all plaintext logs with %s debug flags enabled',
        async (scope) => {
            if (scope !== 'self') setGlobal('window', { logDecryptedPayload: true });
            if (scope !== 'window') setGlobal('self', { logDecryptedPayload: true });
            const app = new FakeAppBoxTransport();
            const protocol = new ProtocolImpl(app, runtime(false));
            await protocol.changePublicKeys();
            app.payload = { values: { password: 'secret-response' } };
            expect(await protocol.getEntryFields('secret-handle', ['password'])).toEqual({
                password: 'secret-response'
            });
            expect(app.payloads).toEqual([
                { action: 'kwx-get-entry-fields', handle: 'secret-handle', fields: ['password'] }
            ]);
            expect(log).not.toHaveBeenCalled();
        }
    );

    test.each([
        ['omitted', undefined],
        ['true', true]
    ] as const)('preserves opt-in logging with allowDebug %s', async (_label, allowDebug) => {
        setGlobal('self', { logDecryptedPayload: true });
        const app = new FakeAppBoxTransport();
        const protocol = new ProtocolImpl(app, runtime(allowDebug));
        await protocol.changePublicKeys();
        expect(await protocol.features()).toMatchObject(features);
        expect(log).toHaveBeenCalledTimes(2);
        expect(log).toHaveBeenCalledWith('Request payload', { action: 'kwx-features' });
        expect(log).toHaveBeenCalledWith('Response payload', expect.objectContaining(features));
    });
});

describe('ProtocolImpl handshake validation', () => {
    for (const [label, nonce] of [
        ['unchanged', (value: string) => value],
        ['incremented twice', (value: string) => incrementNonce(incrementNonce(value))],
        ['missing', () => '']
    ] as const) {
        test(`rejects ${label} handshake nonce before accepting the app`, async () => {
            const app = new FakeAppBoxTransport();
            app.handshakeNonce = nonce;
            const protocol = new ProtocolImpl(app, runtime());
            await expect(protocol.changePublicKeys()).rejects.toThrow('Bad nonce in response');
            expect(protocol.connectedAppName).toBeUndefined();
            await expect(protocol.features()).rejects.toThrow('KeeWeb public key is not set');
            expect(app.requests).toHaveLength(1);
        });
    }

    for (const [label, publicKey, message] of [
        ['short', toBase64(new Uint8Array(31)), 'Bad publicKey length: expected 32 bytes'],
        ['long', toBase64(new Uint8Array(33)), 'Bad publicKey length: expected 32 bytes'],
        ['malformed', 'not!base64', 'Bad value publicKey: failed to decode base64'],
        ['empty', '', 'Empty value publicKey: expected base64'],
        ['missing', undefined, 'Empty value publicKey: expected base64']
    ] as const) {
        test(`rejects ${label} app key before accepting the app`, async () => {
            const app = new FakeAppBoxTransport();
            app.handshakeOverrides = { publicKey };
            const protocol = new ProtocolImpl(app, runtime());
            await expect(protocol.changePublicKeys()).rejects.toThrow(message);
            expect(protocol.connectedAppName).toBeUndefined();
            await expect(protocol.features()).rejects.toThrow('KeeWeb public key is not set');
            expect(app.requests).toHaveLength(1);
        });
    }

    test.each(['nonce', 'key'])(
        'does not overwrite accepted state on an invalid %s',
        async (field) => {
            const app = new FakeAppBoxTransport();
            const protocol = new ProtocolImpl(app, runtime());
            await protocol.changePublicKeys();
            app.handshakeOverrides = {
                appName: 'Unvalidated app',
                publicKey: toBase64(box.keyPair().publicKey)
            };
            if (field === 'nonce') app.handshakeNonce = (value) => value;
            else app.handshakeOverrides.publicKey = toBase64(new Uint8Array(31));
            await expect(protocol.changePublicKeys()).rejects.toThrow();
            expect(protocol.connectedAppName).toBe('KeeWebX');
            expect(await protocol.features()).toMatchObject(features);
        }
    );

    test('still rejects an encrypted response with a non-incremented nonce', async () => {
        const app = new FakeAppBoxTransport();
        const protocol = new ProtocolImpl(app, runtime());
        await protocol.changePublicKeys();
        app.responseNonce = (value) => value;
        await expect(protocol.features()).rejects.toThrow('Bad nonce in response');
    });

    test('still rejects a decrypted payload whose nonce differs from the envelope', async () => {
        const app = new FakeAppBoxTransport();
        const protocol = new ProtocolImpl(app, runtime());
        await protocol.changePublicKeys();
        app.payloadNonce = toBase64(new Uint8Array(24));
        await expect(protocol.features()).rejects.toThrow("Response nonce doesn't match");
    });
});
