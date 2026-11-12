import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { box as naclBox } from 'tweetnacl';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import { Timeouts } from 'const/timeouts';
import type { ProtocolUi } from '../../../../vault/src/comp/extension/protocol-ui';

/**
 * Protocol-impl integration tests.
 *
 * These exercise the KeePassXC-Browser NaCl box protocol implemented in
 * modules/ui-classic/app/scripts/comp/extension/protocol-impl.ts:
 *
 *   - Curve25519 key exchange (change-public-keys handshake)
 *   - XSalsa20 + Poly1305 encrypted request/response via tweetnacl.box
 *   - 24-byte nonces + libsodium little-endian incrementNonce()
 *   - decryptRequest / encryptResponse byte boundaries
 *
 * We inject a UI decision port and mock non-UI dependencies so the module loads in a
 * Bun test process without webpack or DOM, then drive the real
 * ProtocolHandlers from test code end-to-end. The crypto is real:
 * tweetnacl and kdbxweb.ByteUtils are the exact libraries used at runtime.
 *
 * Scope: handlers that do NOT require an open file or a DOM view:
 *   - ping (trivial request passthrough)
 *   - change-public-keys (handshake, no encryption)
 *   - get-databasehash (full encrypt -> decrypt round-trip)
 *   - associate  / test-associate (ensureAtLeastOneFileIsOpen + crypto)
 *   - lock-database (emits a framework event + crypto)
 */

// `kdbxweb` is intentionally NOT mocked here. The polluter
// (`tests/storage/storage-webdav.test.ts`) installs its mock via the
// `installMockedModule` helper from `tests/helpers/mock-isolation.ts`,
// which captures a snapshot of the real module first and registers an
// `afterAll(restoreAllMockedModules)` cleanup. By the time this test
// file runs, the real `kdbxweb` namespace is back in place and we can
// rely on it directly via the bare specifier import below.

// The shared engine has no view imports. Explicit test UI denies every prompt
// unless a test supplies a decision; cryptographic commands still run normally.
function testUi(overrides: Partial<ProtocolUi> = {}): ProtocolUi {
    return {
        isBusy: () => false,
        connect: async () => null,
        selectEntry: async () => null,
        selectField: async () => null,
        saveEntry: async () => null,
        createGroup: async () => null,
        showTouch: (_input, cancel) => { cancel(); return { dispose() {} }; },
        ...overrides
    };
}

mock.module('comp/app/generator-presets', () => ({
    GeneratorPresets: { browserExtensionPreset: {} }
}));
mock.module('util/generators/password-generator', () => ({
    PasswordGenerator: { generate: () => 'generated-password' }
}));
mock.module('util/locale', () => ({
    Locale: {
        extensionErrorNoOpenFiles: 'No files are open',
        extensionErrorUserRejected: 'Rejected by user',
        extensionErrorNoMatches: 'No matches found',
        extensionErrorAlertDisplayed: 'Alert already displayed',
        extensionSelectPasswordFor: 'Select password for {}'
    }
}));
mock.module('models/runtime-data-model', () => ({
    RuntimeDataModel: {}
}));
mock.module('models/app-settings-model', () => ({
    AppSettingsModel: {}
}));

// --- Import the real module under test AFTER mocks are installed ---
// Shared ranking detects browser collation at module load; no DOM is needed.
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
if (!previousWindow) Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
const protocolModule = await import('../../../app/scripts/comp/extension/protocol-impl');
if (!previousWindow) Reflect.deleteProperty(globalThis, 'window');
const { ProtocolImpl } = protocolModule;
const { createClassicProtocolAccess, createSessionProtocolAccess } = await import('../../../../vault/src/comp/extension/protocol-access');
const { getSessionAccess } = await import('../../../../vault/src/comp/app/session-access');
const { Events } = await import('framework/events');
const { SettingsStore } = await import('comp/settings/settings-store');
const { Model } = await import('framework/model');
class FixtureEntry extends Model {}
FixtureEntry.defineModelProperties({}, { extensions: true });

// Real kdbxweb. The mock-isolation helper used by storage-webdav.test.ts
// guarantees that any partial mock installed earlier in the run has
// been restored before this file imports `kdbxweb` here.
const kdbxweb = await import('kdbxweb');

// Known hash exported by the module: sha256('KeeWeb'), hex.
const KEEWEB_HASH = '398d9c782ec76ae9e9877c2321cbda2b31fc6d18ccf0fed5ca4bd746bab4d64a';

// ---------- Helpers ----------

type ProtocolResponse = Record<string, unknown>;

interface ProtocolRequest {
    action: string;
    clientID?: string;
    nonce?: string;
    message?: string;
    publicKey?: string;
    version?: string;
    [key: string]: unknown;
}

interface ClientState {
    clientId: string;
    keys: { publicKey: Uint8Array; secretKey: Uint8Array };
    appPublicKey: Uint8Array;
}

/**
 * Initialize ProtocolImpl with a fake appModel. Each test gets a clean
 * init + cleanup so connectedClients state does not leak across tests.
 */
function initProtocol(options: { hasOpenFiles?: boolean } = {}) {
    const hasOpen = options.hasOpenFiles ?? true;
    const sentEvents: ProtocolResponse[] = [];
    const logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {}
    };
    const fakeAppModel = {
        files: {
            hasOpenFiles: () => hasOpen,
            map: (_fn: unknown) => [],
            filter: (_fn: unknown) => (hasOpen ? [{ id: 'f1', active: true }] : []),
            forEach: () => {},
            length: hasOpen ? 1 : 0,
            [Symbol.iterator]: function* () {
                if (hasOpen) yield { id: 'f1', active: true, groups: [] };
            }
        }
    };
    ProtocolImpl.init({
        appModel: fakeAppModel as unknown as AppModel,
        access: createClassicProtocolAccess(fakeAppModel as unknown as AppModel),
        ui: testUi(),
        logger: logger as unknown as Parameters<typeof ProtocolImpl.init>[0]['logger'],
        sendEvent: (data: ProtocolResponse) => {
            sentEvents.push(data);
        }
    });
    return { sentEvents };
}

/**
 * Perform a real change-public-keys handshake:
 *   1. Generate a Curve25519 keypair (simulating the extension side).
 *   2. Send the public key to ProtocolImpl.
 *   3. Receive the app's generated public key.
 *   4. Verify the nonce round-trip and bytes.
 */
async function handshake(clientId: string = 'test-client-1'): Promise<ClientState> {
    const extKeys = naclBox.keyPair();
    const nonceBytes = new Uint8Array(24);
    for (let i = 0; i < nonceBytes.length; i++) nonceBytes[i] = i;

    const request: ProtocolRequest = {
        action: 'change-public-keys',
        clientID: clientId,
        publicKey: kdbxweb.ByteUtils.bytesToBase64(extKeys.publicKey),
        nonce: kdbxweb.ByteUtils.bytesToBase64(nonceBytes),
        version: 'test-1.0'
    };

    const response = (await ProtocolImpl.handleRequest(request, {
        connectionId: 1,
        extensionName: 'KeePassXC-Browser'
    })) as ProtocolResponse;

    if (response.error) {
        throw new Error(`Handshake failed: ${String(response.error)}`);
    }
    if (!response.publicKey) {
        throw new Error('Handshake response missing publicKey');
    }

    const appPublicKey = new Uint8Array(
        kdbxweb.ByteUtils.base64ToBytes(response.publicKey as string)
    );

    return {
        clientId,
        keys: extKeys,
        appPublicKey
    };
}

/**
 * Build an encrypted protocol request using the extension's tweetnacl box.
 * The app decrypts using (client.publicKey, app.secretKey) from its side.
 */
function buildEncryptedRequest(
    client: ClientState,
    action: string,
    payload: Record<string, unknown>,
    nonceOverride?: Uint8Array
): ProtocolRequest {
    const nonce = nonceOverride ?? naclBox.before(client.appPublicKey, client.keys.secretKey).subarray(0, 24);
    // Use a fresh random-ish nonce for this test
    const nonceBytes = nonceOverride ?? new Uint8Array(24);
    if (!nonceOverride) {
        for (let i = 0; i < 24; i++) nonceBytes[i] = (Date.now() + i) & 0xff;
    }

    const payloadWithAction = { action, ...payload };
    const json = JSON.stringify(payloadWithAction);
    const data = new TextEncoder().encode(json);

    const encrypted = naclBox(
        data,
        nonceBytes,
        client.appPublicKey,
        client.keys.secretKey
    );

    return {
        action,
        clientID: client.clientId,
        nonce: kdbxweb.ByteUtils.bytesToBase64(nonceBytes),
        message: kdbxweb.ByteUtils.bytesToBase64(encrypted),
        // Silence an unused-var warning on `nonce`
        ...(nonce ? {} : {})
    };
}

/**
 * Decrypt a protocol response on the extension side.
 *
 * Correctness note: per the KeePassXC-Browser / KeeWeb Connect protocol
 * spec, `response.nonce` must equal `increment(request.nonce)` and the
 * ciphertext is sealed with that incremented nonce. This helper
 * therefore decrypts directly with `response.nonce` as the naclBox
 * key — whatever the server sent MUST be what the server encrypted
 * with, otherwise the extension would reject the response.
 *
 * History: an earlier version of protocol-impl.ts had a mutation-
 * aliasing bug where `new Uint8Array(nonceBytes)` created a throw-
 * away copy; the increment was lost and `response.nonce` silently
 * equaled `request.nonce`. A prior test-author saw this, misread
 * it as a "protocol quirk", and wrote a regression pin asserting
 * the broken behavior. Fixed in commit 495b3a49 — this helper now
 * matches the protocol spec, and the dedicated nonce-increment
 * test below REPLACES the old pin with the correct assertion.
 */
function decryptResponse(
    client: ClientState,
    request: ProtocolRequest,
    response: ProtocolResponse
): Record<string, unknown> {
    if (!response.message || !response.nonce) {
        throw new Error(
            `Response missing message/nonce: ${JSON.stringify(response)}`
        );
    }
    const responseNonce = new Uint8Array(
        kdbxweb.ByteUtils.base64ToBytes(response.nonce as string)
    );
    const responseMessage = new Uint8Array(
        kdbxweb.ByteUtils.base64ToBytes(response.message as string)
    );

    // Decrypt with the nonce that the server reported. See note above.
    const plaintext = naclBox.open(
        responseMessage,
        responseNonce,
        client.appPublicKey,
        client.keys.secretKey
    );
    if (!plaintext) {
        throw new Error('Failed to decrypt response');
    }
    const json = new TextDecoder().decode(plaintext);
    const decoded = JSON.parse(json) as Record<string, unknown>;

    return decoded;
}

// Reference implementation of libsodium little-endian nonce increment,
// matching protocol-impl.ts's incrementNonce exactly.
function incrementNonceLE(nonce: Uint8Array): void {
    let c = 1;
    for (let i = 0; i < nonce.length; ++i) {
        c += nonce[i];
        nonce[i] = c;
        c >>= 8;
    }
}

// ---------- Tests ----------

describe('ProtocolImpl — KeePassXC-Browser NaCl box protocol', () => {
    beforeEach(() => {
        // Reset per-test so connectedClients state does not leak.
        ProtocolImpl.cleanup();
    });

    test('ping is a trivial passthrough (no encryption required)', async () => {
        initProtocol();
        const req: ProtocolRequest = {
            action: 'ping',
            data: { hello: 'world' }
        } as ProtocolRequest;
        const res = (await ProtocolImpl.handleRequest(req, {
            connectionId: 1,
            extensionName: 'KeePassXC-Browser'
        })) as ProtocolResponse;
        expect(res.error).toBeUndefined();
        expect(res.data).toEqual({ hello: 'world' });
    });

    test('change-public-keys handshake returns a 32-byte Curve25519 public key', async () => {
        initProtocol();

        const client = await handshake('client-a');

        // Curve25519 public keys are exactly 32 bytes.
        expect(client.appPublicKey.length).toBe(32);

        // The returned key must be distinct from an all-zero key and from
        // the extension's own public key (i.e., a real keypair was generated).
        expect(Array.from(client.appPublicKey).every((b) => b === 0)).toBe(false);
        expect(Array.from(client.appPublicKey)).not.toEqual(Array.from(client.keys.publicKey));

        // The client should now appear in the sessions list.
        const sessions = ProtocolImpl.sessions;
        expect(sessions.length).toBe(1);
        expect(sessions[0].clientId).toBe('client-a');
    });

    test('change-public-keys is rejected if called twice for the same clientID', async () => {
        initProtocol();
        await handshake('client-b');

        // A second change-public-keys with the same clientID must fail.
        const extKeys = naclBox.keyPair();
        const nonceBytes = new Uint8Array(24);
        const second = (await ProtocolImpl.handleRequest(
            {
                action: 'change-public-keys',
                clientID: 'client-b',
                publicKey: kdbxweb.ByteUtils.bytesToBase64(extKeys.publicKey),
                nonce: kdbxweb.ByteUtils.bytesToBase64(nonceBytes),
                version: 'test-1.0'
            },
            { connectionId: 2, extensionName: 'KeePassXC-Browser' }
        )) as ProtocolResponse;

        expect(second.error).toBeDefined();
        expect(String(second.error)).toMatch(/not allowed/i);
    });

    test('get-databasehash: full encrypt -> decrypt round-trip returns KeeWebHash', async () => {
        initProtocol({ hasOpenFiles: true });
        const client = await handshake('client-c');

        const request = buildEncryptedRequest(client, 'get-databasehash', {});
        const response = (await ProtocolImpl.handleRequest(request, {
            connectionId: 3,
            extensionName: 'KeePassXC-Browser'
        })) as ProtocolResponse;

        expect(response.error).toBeUndefined();

        const decrypted = decryptResponse(client, request, response);
        expect(decrypted.hash).toBe(KEEWEB_HASH);
        expect(decrypted.success).toBe('true');
        expect(typeof decrypted.version).toBe('string');
    });

    test('get-databasehash fails cleanly when no files are open', async () => {
        initProtocol({ hasOpenFiles: false });
        const client = await handshake('client-d');

        const request = buildEncryptedRequest(client, 'get-databasehash', {});
        const response = (await ProtocolImpl.handleRequest(request, {
            connectionId: 4,
            extensionName: 'KeePassXC-Browser'
        })) as ProtocolResponse;

        // Error response is unencrypted and carries an errorCode.
        expect(response.error).toBeDefined();
        // Error code '1' = noOpenFiles (see Errors table in protocol-impl).
        expect(String(response.errorCode)).toBe('1');
    });

    test('associate round-trip succeeds when at least one file is open', async () => {
        initProtocol({ hasOpenFiles: true });
        const client = await handshake('client-e');

        const request = buildEncryptedRequest(client, 'associate', {
            key: kdbxweb.ByteUtils.bytesToBase64(client.keys.publicKey),
            idKey: kdbxweb.ByteUtils.bytesToBase64(client.keys.publicKey)
        });
        const response = (await ProtocolImpl.handleRequest(request, {
            connectionId: 5,
            extensionName: 'KeePassXC-Browser'
        })) as ProtocolResponse;

        expect(response.error).toBeUndefined();

        const decrypted = decryptResponse(client, request, response);
        expect(decrypted.id).toBe('KeeWeb');
        expect(decrypted.hash).toBe(KEEWEB_HASH);
        expect(decrypted.success).toBe('true');
    });

    test('test-associate with wrong association id is rejected', async () => {
        initProtocol({ hasOpenFiles: true });
        const client = await handshake('client-f');

        const request = buildEncryptedRequest(client, 'test-associate', {
            id: 'NotKeeWeb',
            key: kdbxweb.ByteUtils.bytesToBase64(client.keys.publicKey)
        });
        const response = (await ProtocolImpl.handleRequest(request, {
            connectionId: 6,
            extensionName: 'KeePassXC-Browser'
        })) as ProtocolResponse;

        // Wrong id path throws makeError(Errors.noOpenFiles) in current code.
        expect(response.error).toBeDefined();
    });

    test('test-associate with correct id returns success', async () => {
        initProtocol({ hasOpenFiles: true });
        const client = await handshake('client-g');

        const request = buildEncryptedRequest(client, 'test-associate', {
            id: 'KeeWeb',
            key: kdbxweb.ByteUtils.bytesToBase64(client.keys.publicKey)
        });
        const response = (await ProtocolImpl.handleRequest(request, {
            connectionId: 7,
            extensionName: 'KeePassXC-Browser'
        })) as ProtocolResponse;

        expect(response.error).toBeUndefined();
        const decrypted = decryptResponse(client, request, response);
        expect(decrypted.success).toBe('true');
        expect(decrypted.id).toBe('KeeWeb');
        expect(decrypted.hash).toBe(KEEWEB_HASH);
    });

    test('tampered ciphertext is rejected by decryptRequest (Poly1305 MAC check)', async () => {
        initProtocol({ hasOpenFiles: true });
        const client = await handshake('client-h');

        const request = buildEncryptedRequest(client, 'get-databasehash', {});
        // Corrupt the ciphertext: flip a byte in the middle of the message.
        const corrupted = new Uint8Array(
            kdbxweb.ByteUtils.base64ToBytes(request.message as string)
        );
        const mid = Math.floor(corrupted.length / 2);
        corrupted[mid] ^= 0xff;
        const tampered: ProtocolRequest = {
            ...request,
            message: kdbxweb.ByteUtils.bytesToBase64(corrupted)
        };

        const response = (await ProtocolImpl.handleRequest(tampered, {
            connectionId: 8,
            extensionName: 'KeePassXC-Browser'
        })) as ProtocolResponse;

        // Poly1305 MAC verification failure -> error, not a crash.
        expect(response.error).toBeDefined();
        expect(String(response.error)).toMatch(/decrypt/i);
    });

    test('request without a prior handshake is rejected', async () => {
        initProtocol({ hasOpenFiles: true });

        // No handshake: connectedClients is empty for this clientID.
        const extKeys = naclBox.keyPair();
        const nonceBytes = new Uint8Array(24);
        const fakeCiphertext = new Uint8Array(16);
        const response = (await ProtocolImpl.handleRequest(
            {
                action: 'get-databasehash',
                clientID: 'never-handshaked',
                nonce: kdbxweb.ByteUtils.bytesToBase64(nonceBytes),
                message: kdbxweb.ByteUtils.bytesToBase64(fakeCiphertext)
            },
            { connectionId: 9, extensionName: 'KeePassXC-Browser' }
        )) as ProtocolResponse;

        expect(response.error).toBeDefined();
        expect(String(response.error)).toMatch(/client/i);

        // Silence unused var
        void extKeys;
    });

    test('change-public-keys increments response nonce with libsodium little-endian carry', async () => {
        initProtocol();

        // change-public-keys has its own increment path that DOES mutate
        // the nonce in place (unlike encryptResponse). Use a nonce whose
        // byte[0] is 0xff so little-endian increment must carry into byte[1].
        const extKeys = naclBox.keyPair();
        const nonceBytes = new Uint8Array(24);
        nonceBytes[0] = 0xff;
        nonceBytes[1] = 0x00;

        const response = (await ProtocolImpl.handleRequest(
            {
                action: 'change-public-keys',
                clientID: 'client-nonce',
                publicKey: kdbxweb.ByteUtils.bytesToBase64(extKeys.publicKey),
                nonce: kdbxweb.ByteUtils.bytesToBase64(nonceBytes),
                version: 'test-1.0'
            },
            { connectionId: 10, extensionName: 'KeePassXC-Browser' }
        )) as ProtocolResponse;

        expect(response.error).toBeUndefined();

        const responseNonce = new Uint8Array(
            kdbxweb.ByteUtils.base64ToBytes(response.nonce as string)
        );
        // After libsodium-style increment: 0xff + 1 = 0x00 with carry
        // propagating to byte[1] = 0x01.
        expect(responseNonce[0]).toBe(0x00);
        expect(responseNonce[1]).toBe(0x01);
        // Higher-order bytes stay zero.
        for (let i = 2; i < 24; i++) {
            expect(responseNonce[i]).toBe(0);
        }

        // Cross-check: the JS reference implementation produces the same.
        const reference = new Uint8Array(nonceBytes);
        incrementNonceLE(reference);
        expect(Array.from(responseNonce)).toEqual(Array.from(reference));
    });

    test('encryptResponse increments the request nonce (KeePassXC-Browser spec)', async () => {
        // Per the KeePassXC-Browser and KeeWeb Connect protocol, the
        // server's encrypted response MUST carry `increment(request.nonce)`,
        // and the ciphertext MUST be sealed with that incremented nonce.
        // The extension's validateNonce() rejects any response whose nonce
        // doesn't match `increment(request.nonce)` with "Bad nonce in
        // response" — which blocks get-logins / get-databasehash / every
        // other encrypted handler downstream of the handshake.
        //
        // History: this test previously asserted the BROKEN behavior with
        // the misleading name "returns the request nonce unmodified
        // (documented quirk)". The bug was a mutation-aliasing issue
        // in encryptResponse where `new Uint8Array(nonceBytes)` created
        // a throwaway copy, silently dropping the increment. The pin
        // test locked the bug in place and warned future fixers that
        // "KeePassXC-Browser compatibility" depended on the broken
        // behavior — the exact opposite of reality. Fixed in commit
        // 495b3a49; this test now asserts the correct protocol behavior.
        initProtocol({ hasOpenFiles: true });
        const client = await handshake('client-nonce-inc');

        const nonceBytes = new Uint8Array(24);
        for (let i = 0; i < 24; i++) nonceBytes[i] = 0x10 + i;

        const payload = { action: 'get-databasehash' };
        const data = new TextEncoder().encode(JSON.stringify(payload));
        const encrypted = naclBox(
            data,
            nonceBytes,
            client.appPublicKey,
            client.keys.secretKey
        );
        const request: ProtocolRequest = {
            action: 'get-databasehash',
            clientID: client.clientId,
            nonce: kdbxweb.ByteUtils.bytesToBase64(nonceBytes),
            message: kdbxweb.ByteUtils.bytesToBase64(encrypted)
        };

        const response = (await ProtocolImpl.handleRequest(request, {
            connectionId: 11,
            extensionName: 'KeePassXC-Browser'
        })) as ProtocolResponse;

        expect(response.error).toBeUndefined();

        // 1. response.nonce MUST equal increment(request.nonce)
        const responseNonce = new Uint8Array(
            kdbxweb.ByteUtils.base64ToBytes(response.nonce as string)
        );
        const expected = new Uint8Array(nonceBytes);
        incrementNonceLE(expected);
        expect(
            Array.from(responseNonce),
            'response.nonce must equal increment(request.nonce) ' +
                'per KeePassXC-Browser spec. If this fails, check ' +
                'encryptResponse in protocol-impl.ts for mutation-' +
                'aliasing bugs (new Uint8Array copy vs in-place).'
        ).toEqual(Array.from(expected));

        // 2. The response ciphertext MUST be decryptable with that
        //    same incremented nonce (decryptResponse uses response.nonce).
        const decrypted = decryptResponse(client, request, response);
        expect(decrypted.hash).toBe(KEEWEB_HASH);

        // 3. Sanity: an extension that naively decrypted with the
        //    un-incremented request nonce would fail. We explicitly
        //    confirm that reversal to lock the protocol semantics.
        const responseMessage = new Uint8Array(
            kdbxweb.ByteUtils.base64ToBytes(response.message as string)
        );
        const wrongNonce = nonceBytes; // NOT incremented
        const wrongDecrypt = naclBox.open(
            responseMessage,
            wrongNonce,
            client.appPublicKey,
            client.keys.secretKey
        );
        expect(
            wrongDecrypt,
            'decrypting with the un-incremented request nonce must fail ' +
                '— this guards against future regressions where both ' +
                'sides of the protocol drift back to the old buggy behavior.'
        ).toBeNull();
    });

    test('encryptResponse nonce handling: first byte wrap-around with carry', async () => {
        // Edge case of libsodium little-endian increment: byte[0] = 0xff
        // + 1 carries into byte[1]. The change-public-keys handler path
        // already tests the change-public-keys flow specifically for the
        // wrap-around (see earlier test); this one validates the
        // encryptResponse path (get-databasehash handler) handles it
        // the same way.
        initProtocol({ hasOpenFiles: true });
        const client = await handshake('client-carry');

        const nonceBytes = new Uint8Array(24);
        nonceBytes[0] = 0xff;
        // byte[1..23] stay 0

        const payload = { action: 'get-databasehash' };
        const data = new TextEncoder().encode(JSON.stringify(payload));
        const encrypted = naclBox(
            data,
            nonceBytes,
            client.appPublicKey,
            client.keys.secretKey
        );
        const request: ProtocolRequest = {
            action: 'get-databasehash',
            clientID: client.clientId,
            nonce: kdbxweb.ByteUtils.bytesToBase64(nonceBytes),
            message: kdbxweb.ByteUtils.bytesToBase64(encrypted)
        };

        const response = (await ProtocolImpl.handleRequest(request, {
            connectionId: 12,
            extensionName: 'KeePassXC-Browser'
        })) as ProtocolResponse;

        expect(response.error).toBeUndefined();
        const responseNonce = new Uint8Array(
            kdbxweb.ByteUtils.base64ToBytes(response.nonce as string)
        );
        // After libsodium-style increment: 0xff + 1 = 0x00 with carry
        // propagating to byte[1] = 0x01.
        expect(responseNonce[0]).toBe(0x00);
        expect(responseNonce[1]).toBe(0x01);
        for (let i = 2; i < 24; i++) {
            expect(responseNonce[i]).toBe(0);
        }

        // And decryption with the incremented nonce must work.
        const decrypted = decryptResponse(client, request, response);
        expect(decrypted.hash).toBe(KEEWEB_HASH);
    });
});

// ---------- KeeWebX pairing and entry lists ----------

const { sign: naclSign } = await import('tweetnacl');
const { RuntimeDataModel } = (await import('models/runtime-data-model')) as unknown as {
    RuntimeDataModel: Record<string, unknown>;
};

describe('ProtocolImpl — KeeWebX pairing and entry lists', () => {
    const conn = { connectionId: 9, extensionName: 'KeeWeb Connect' };
    const entry = {
        id: 'e1',
        title: 'GitHub',
        user: 'demouser',
        url: 'https://github.com/login',
        displayUrl: 'github.com',
        iconId: 1,
        icon: 'globe',
        customIcon: null,
        fields: {},
        otpGenerator: null,
        updated: new Date(),
        password: { getText: () => 's3cret' },
        file: { id: 'f1' },
        initOtpGenerator() {}
    };

    function initWithEntries(ui: ProtocolUi = testUi()) {
        const file = { id: 'f1', active: true, db: {}, getEntry: (id: string) => (id === 'e1' ? entry : undefined) };
        entry.file = file;
        const model = {
                files: {
                    hasOpenFiles: () => true,
                    map: (fn: (f: unknown) => unknown) => [file].map(fn),
                    filter: (fn: (f: unknown) => boolean) => [file].filter(fn),
                    get: (id: string) => (id === 'f1' ? file : undefined),
                    forEach: () => {},
                    length: 1
                },
                getEntriesByFilter: () => [entry]
            } as unknown as AppModel;
        ProtocolImpl.init({ appModel: model, access: createClassicProtocolAccess(model),
            ui,
            logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as Parameters<
                typeof ProtocolImpl.init
            >[0]['logger'],
            sendEvent: () => {}
        });
        return { model, file, ui };
    }

    async function call(client: ClientState, action: string, payload: Record<string, unknown> = {}) {
        const request = buildEncryptedRequest(client, action, payload);
        const response = (await ProtocolImpl.handleRequest(request, conn)) as ProtocolResponse;
        return response.error ? { error: response } : { ok: decryptResponse(client, request, response) };
    }

    function pairingSignature(client: ClientState, secretKey: Uint8Array, appKey = client.appPublicKey) {
        const signed = new Uint8Array([
            ...new TextEncoder().encode('kwx-pair-v1'),
            ...client.keys.publicKey,
            ...appKey
        ]);
        return kdbxweb.ByteUtils.bytesToBase64(naclSign.detached(signed, secretKey));
    }

    beforeEach(() => {
        ProtocolImpl.cleanup();
        delete RuntimeDataModel.extensionPairings;
        delete RuntimeDataModel.extensionConnectConfig;
    });

    test('pairing rejects a signature made for another session', async () => {
        initWithEntries();
        const client = await handshake('kwx-a');
        const identity = naclSign.keyPair();
        const otherSession = naclBox.keyPair().publicKey;
        const res = await call(client, 'kwx-pair', {
            identityKey: kdbxweb.ByteUtils.bytesToBase64(identity.publicKey),
            signature: pairingSignature(client, identity.secretKey, otherSession)
        });
        expect(res.error).toBeDefined();
        const features = await call(client, 'kwx-features');
        expect(features.ok?.paired).toBe(false);
    });

    test('an unpaired client cannot list entries, even with a shared approval', async () => {
        initWithEntries();
        RuntimeDataModel.extensionConnectConfig = { allFiles: true, canList: true };
        const client = await handshake('kwx-b');
        const res = await call(client, 'kwx-get-entries', { url: 'https://github.com/login' });
        expect(String(res.error?.errorCode)).toBe('kwx-not-paired');
    });

    test('a paired client lists entries without secrets and reads fields by handle', async () => {
        initWithEntries();
        const identity = naclSign.keyPair();
        const identityKey = kdbxweb.ByteUtils.bytesToBase64(identity.publicKey);
        RuntimeDataModel.extensionPairings = {
            [identityKey]: { created: '2026-11-11', permissions: { allFiles: true, canList: true } }
        };
        const client = await handshake('kwx-c');
        const paired = await call(client, 'kwx-pair', {
            identityKey,
            signature: pairingSignature(client, identity.secretKey)
        });
        expect(paired.ok?.known).toBe(true);
        expect((await call(client, 'kwx-features')).ok).toMatchObject({
            features: ['entries-v1'],
            paired: true,
            canList: true,
            locked: false
        });

        const list = await call(client, 'kwx-get-entries', { query: 'git' });
        const items = list.ok?.items as Array<Record<string, unknown>>;
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ title: 'GitHub', user: 'demouser', url: 'github.com', icon: 'globe' });
        expect(JSON.stringify(list.ok)).not.toContain('s3cret');
        expect(items[0].id).toBeUndefined();

        const fields = await call(client, 'kwx-get-entry-fields', {
            handle: items[0].handle,
            fields: ['user', 'password']
        });
        expect(fields.ok?.values).toEqual({ user: 'demouser', password: 's3cret' });
        expect(ProtocolImpl.sessions[0].passwordsRead).toBe(1);

        const forged = await call(client, 'kwx-get-entry-fields', { handle: 'e1', fields: ['password'] });
        expect(String(forged.error?.errorCode)).toBe('kwx-expired-handle');
    });

    test('pairing alone does not grant listing; the injected consent may deny it', async () => {
        const connect = mock(async () => null);
        initWithEntries(testUi({ connect }));
        const client = await handshake('kwx-denied');
        const identity = naclSign.keyPair();
        const identityKey = kdbxweb.ByteUtils.bytesToBase64(identity.publicKey);
        await call(client, 'kwx-pair', {
            identityKey, signature: pairingSignature(client, identity.secretKey)
        });
        expect(connect).not.toHaveBeenCalled();
        const result = await call(client, 'kwx-get-entries', {});
        expect(result.error?.errorCode).toBe('6');
        expect(connect).toHaveBeenCalledTimes(1);
        expect(ProtocolImpl.sessions[0].permissionsDenied).toBe(true);
        expect(RuntimeDataModel.extensionPairings).toBeUndefined();
    });

    test('paired consent keeps file scope and stores the approved list permission', async () => {
        const decision = { allFiles: false, files: ['f1'], askGet: 'always', canList: true };
        const connect = mock(async (input: Parameters<ProtocolUi['connect']>[0]) => {
            expect(input).toMatchObject({ offerList: true, canList: true, allFiles: true, askGet: 'multiple' });
            return decision;
        });
        initWithEntries(testUi({ connect }));
        const client = await handshake('kwx-approved');
        const identity = naclSign.keyPair();
        const identityKey = kdbxweb.ByteUtils.bytesToBase64(identity.publicKey);
        await call(client, 'kwx-pair', {
            identityKey, signature: pairingSignature(client, identity.secretKey)
        });
        expect((await call(client, 'kwx-get-entries', {})).ok?.locked).toBe(false);
        expect(RuntimeDataModel.extensionPairings).toMatchObject({ [identityKey]: { permissions: decision } });
        expect(RuntimeDataModel.extensionConnectConfig).toBeUndefined();
        await call(client, 'kwx-get-entries', {});
        expect(connect).toHaveBeenCalledTimes(1);
    });

    test('allowing paired fill without list consent still rejects the listing request', async () => {
        initWithEntries(testUi({ connect: async () => ({
            allFiles: true, files: ['f1'], askGet: 'multiple', canList: false
        }) }));
        const client = await handshake('kwx-no-list');
        const identity = naclSign.keyPair();
        await call(client, 'kwx-pair', {
            identityKey: kdbxweb.ByteUtils.bytesToBase64(identity.publicKey),
            signature: pairingSignature(client, identity.secretKey)
        });
        expect((await call(client, 'kwx-get-entries', {})).error?.errorCode).toBe('6');
        expect(ProtocolImpl.sessions[0].permissions?.canList).toBe(false);
    });

    test('live permission reduction and disconnect retain their legacy enforcement', async () => {
        initWithEntries();
        const identity = naclSign.keyPair();
        const identityKey = kdbxweb.ByteUtils.bytesToBase64(identity.publicKey);
        RuntimeDataModel.extensionPairings = {
            [identityKey]: { created: '2026-11-11', permissions: { allFiles: true, canList: true } }
        };
        const client = await handshake('kwx-revoke');
        await call(client, 'kwx-pair', { identityKey, signature: pairingSignature(client, identity.secretKey) });
        const handle = ((await call(client, 'kwx-get-entries', {})).ok?.items as Array<{ handle: string }>)[0].handle;
        ProtocolImpl.setClientPermissions(client.clientId, { canList: false });
        expect(ProtocolImpl.getClientPermissions(client.clientId)?.canList).toBe(false);
        expect((await call(client, 'kwx-get-entry-fields', { handle, fields: ['password'] })).error?.errorCode).toBe('6');
        ProtocolImpl.deleteConnection(1);
        expect(ProtocolImpl.sessions).toHaveLength(0);
        expect((await call(client, 'kwx-get-entry-fields', { handle, fields: ['password'] })).error).toBeDefined();
        // Disconnect is deliberately not a durable forget-pairing operation.
        expect(RuntimeDataModel.extensionPairings).toHaveProperty(identityKey);
    });

    test('handles are bound to the client that received them', async () => {
        initWithEntries();
        const identity = naclSign.keyPair();
        const identityKey = kdbxweb.ByteUtils.bytesToBase64(identity.publicKey);
        RuntimeDataModel.extensionPairings = {
            [identityKey]: { created: '2026-11-11', permissions: { allFiles: true, canList: true } }
        };
        const first = await handshake('kwx-d1');
        await call(first, 'kwx-pair', { identityKey, signature: pairingSignature(first, identity.secretKey) });
        const handle = ((await call(first, 'kwx-get-entries', {})).ok?.items as Array<{ handle: string }>)[0].handle;

        const second = await handshake('kwx-d2');
        await call(second, 'kwx-pair', { identityKey, signature: pairingSignature(second, identity.secretKey) });
        await call(second, 'kwx-get-entries', {});
        const res = await call(second, 'kwx-get-entry-fields', { handle, fields: ['password'] });
        expect(String(res.error?.errorCode)).toBe('kwx-expired-handle');
    });

    async function pairedClient(id: string) {
        const identity = naclSign.keyPair();
        const identityKey = kdbxweb.ByteUtils.bytesToBase64(identity.publicKey);
        RuntimeDataModel.extensionPairings = { [identityKey]: { created: '2026-11-11', permissions: { allFiles: true, canList: true } } };
        const client = await handshake(id);
        await call(client, 'kwx-pair', { identityKey, signature: pairingSignature(client, identity.secretKey) });
        const items = (await call(client, 'kwx-get-entries')).ok?.items as Array<{ handle: string }>;
        return { client, identity, identityKey, handle: items[0].handle };
    }

    for (const reason of ['epoch', 'file', 'database', 'entry', 'permissions'] as const) {
        test(`issued entry handles fail after ${reason} changes`, async () => {
            const f = initWithEntries();
            const { client, handle } = await pairedClient('handle-test');
            if (reason === 'epoch') Events.emit('lock-workspace');
            if (reason === 'file') f.file.active = false;
            if (reason === 'database') f.file.db = {};
            if (reason === 'entry') f.file.getEntry = () => ({ ...entry });
            if (reason === 'permissions') ProtocolImpl.setClientPermissions(client.clientId, { allFiles: false, files: [] });
            const result = await call(client, 'kwx-get-entry-fields', { handle, fields: ['password'] });
            expect(result.error?.errorCode).toBe('kwx-expired-handle');
        });
    }

    test('live list revocation cannot reload the remembered list grant', async () => {
        const connect = mock(async () => null);
        initWithEntries(testUi({ connect }));
        const { client } = await pairedClient('list-revocation');
        ProtocolImpl.setClientPermissions(client.clientId, { canList: false });
        expect((await call(client, 'kwx-get-entries')).error?.errorCode).toBe('6');
        expect((await call(client, 'kwx-features')).ok?.canList).toBe(false);
        expect(connect).not.toHaveBeenCalled();
    });

    test('disconnect retains approval, identity forget persists denial across reconnect without inheriting legacy approval', async () => {
        const connect = mock(async () => null);
        initWithEntries(testUi({ connect }));
        const { client, identity, identityKey } = await pairedClient('durable');
        const other = naclSign.keyPair();
        const otherKey = kdbxweb.ByteUtils.bytesToBase64(other.publicKey);
        Object.assign(RuntimeDataModel.extensionPairings as object, { [otherKey]: { created: '2026-11-11', permissions: { allFiles: true, canList: true } } });
        RuntimeDataModel.extensionConnectConfig = { allFiles: true, askGet: 'multiple' };
        ProtocolImpl.deleteConnection(9);
        expect(ProtocolImpl.approvals.identities.map((item) => item.identity)).toContain(identityKey);
        const storage = {};
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
        try {
            ProtocolImpl.forgetApproval(identityKey);
            const stored = await SettingsStore.load('runtime-data') as Record<string, unknown>;
            expect((stored.extensionPairings as Record<string, unknown>)[identityKey]).toMatchObject({ revoked: true });
            expect(ProtocolImpl.approvals.identities.map((item) => item.identity)).toEqual([otherKey]);
            expect(ProtocolImpl.approvals.legacy).toBeDefined();
            // Recreate the engine and reload the persisted runtime data, as on app restart.
            initWithEntries(testUi({ connect }));
            Object.assign(RuntimeDataModel, JSON.parse(JSON.stringify(stored)));
            const again = await handshake('forgotten');
            expect((await call(again, 'kwx-pair', { identityKey, signature: pairingSignature(again, identity.secretKey) })).ok?.known).toBe(false);
            expect((await call(again, 'get-logins', { url: 'https://github.com' })).error?.errorCode).toBe('6');
            expect(connect).toHaveBeenCalledTimes(1);
            ProtocolImpl.forgetLegacyApproval();
            expect(ProtocolImpl.approvals.legacy).toBeUndefined();
            expect(ProtocolImpl.approvals.identities.map((item) => item.identity)).toEqual([otherKey]);
            expect((await SettingsStore.load('runtime-data') as Record<string, unknown>).extensionConnectConfig).toBeUndefined();
        } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
    });

    test('forgetting another identity or shared legacy approval preserves a dedicated current identity session', async () => {
        initWithEntries();
        const { client, identityKey } = await pairedClient('scoped');
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        Object.defineProperty(globalThis, 'localStorage', { value: {}, configurable: true });
        try {
            ProtocolImpl.forgetApproval('unrelated');
            RuntimeDataModel.extensionConnectConfig = { allFiles: true };
            ProtocolImpl.forgetLegacyApproval();
            expect(ProtocolImpl.sessions[0].identity).toBe(identityKey);
            expect((await call(client, 'kwx-get-entries')).ok?.locked).toBe(false);
            ProtocolImpl.forgetApproval(identityKey);
            expect(ProtocolImpl.sessions).toHaveLength(0);
        } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
    });

    test('failed durable forget reports storage failure but still disconnects and denies in memory', async () => {
        initWithEntries();
        const { identityKey } = await pairedClient('failure');
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        Object.defineProperty(globalThis, 'localStorage', { value: new Proxy({}, { set() { throw new Error('quota'); } }), configurable: true });
        try {
            expect(() => ProtocolImpl.forgetApproval(identityKey)).toThrow('quota');
            expect(ProtocolImpl.sessions).toHaveLength(0);
            expect((RuntimeDataModel.extensionPairings as Record<string, unknown>)[identityKey]).toMatchObject({ revoked: true });
            expect(ProtocolImpl.approvals.identities[0]).toMatchObject({ identity: identityKey, pendingPersistence: true });
            Object.defineProperty(globalThis, 'localStorage', { value: {}, configurable: true });
            ProtocolImpl.forgetApproval(identityKey);
            expect(ProtocolImpl.approvals.identities).toHaveLength(0);
        } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
    });

});

// Exercise the new UI seam through real encrypted legacy requests, without views.
describe('ProtocolImpl — explicit UI decisions', () => {
    const conn = { connectionId: 1, extensionName: 'KeePassXC-Browser' };
    const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Parameters<typeof ProtocolImpl.init>[0]['logger'];
    const approved = { allFiles: true, files: ['f1'], askGet: 'always' };

    function fixture(overrides: Partial<ProtocolUi> = {}) {
        const root = {
            id: 'root', title: 'Vault', iconId: 0, parentGroup: null,
            group: { uuid: new kdbxweb.KdbxUuid(new Uint8Array(16).fill(1)) },
            items: [] as unknown[], matches: () => true
        };
        const file = {
            id: 'f1', name: 'Vault', active: true, groups: [root], db: kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('master')), 'Vault'),
            getGroup: (id: string): typeof root | undefined => groupMap.get(id),
            forEachGroup: (fn: (group: typeof root) => void) => fn(root),
            getEntry: (id: string) => id === 'e1' ? entry : undefined,
            subId: (id: string) => id
        };
        Object.assign(root, { file });
        const groupMap = new Map([[root.id, root]]);
        const entry = Object.assign(new FixtureEntry(), {
            id: 'e1', title: 'Login', user: 'user', url: 'https://example.com/login',
            searchText: 'login example.com', group: root, file,
            entry: { uuid: { bytes: new Uint8Array(16).fill(2) } },
            password: kdbxweb.ProtectedValue.fromString('secret'),
            getAllUrls: () => ['https://example.com/login'],
            getAllFields: () => ({ Password: entry.password }),
            initOtpGenerator() {},
            otpGenerator: { next: (cb: (err: null, otp: string) => void) => cb(null, '123456') },
            needsTouch: false,
            device: { shortName: 'Key' }
        });
        const createNewGroupWithName = mock((parent: unknown, _file: unknown, title: string) => {
            const group = { ...root, file, parentGroup: parent, id: `new${groupMap.size === 1 ? '' : groupMap.size}`, title, items: [], setIcon: mock(() => {}) };
            groupMap.set(group.id, group as typeof root);
            return group;
        });
        const createNewEntryWithFields = mock(() => entry);
        const model = {
            files: {
                hasOpenFiles: () => true,
                map: (fn: (f: typeof file) => unknown) => [file].map(fn),
                filter: (fn: (f: typeof file) => boolean) => [file].filter(fn),
                get: (id: string) => id === file.id ? file : undefined
            },
            getEntriesByFilter: () => [entry],
            createNewGroupWithName, createNewEntryWithFields
        } as unknown as AppModel;
        const ui = testUi({ connect: async () => approved, ...overrides });
        const access = createSessionProtocolAccess(model);
        ProtocolImpl.init({ appModel: model, logger, sendEvent() {}, ui, access });
        return { model, ui, entry, root, file, access, createNewEntryWithFields, createNewGroupWithName };
    }

    async function call(client: ClientState, action: string, payload: Record<string, unknown> = {}) {
        const request = buildEncryptedRequest(client, action, payload);
        const response = await ProtocolImpl.handleRequest(request, conn);
        return response.error ? { error: response } : { ok: decryptResponse(client, request, response) };
    }

    beforeEach(() => {
        ProtocolImpl.cleanup();
        delete RuntimeDataModel.extensionConnectConfig;
        delete RuntimeDataModel.extensionPairings;
        delete RuntimeDataModel.extensionSaveConfig;
    });

    test('Classic facade and shared import expose one engine, and init requires UI', async () => {
        const shared = await import('../../../../vault/src/comp/extension/protocol-impl');
        expect(shared.ProtocolImpl).toBe(ProtocolImpl);
        const { model } = fixture();
        expect(() => ProtocolImpl.init({ appModel: model, logger, sendEvent() {} } as Parameters<typeof ProtocolImpl.init>[0]))
            .toThrow('Protocol UI is required');
    });

    test('legacy consent and entry selection receive the shared filter without wire changes', async () => {
        let chosen: EntryModel;
        const connect = mock(async (input: Parameters<ProtocolUi['connect']>[0]) => {
            expect(input).toMatchObject({ offerList: false, askGet: 'multiple', allFiles: true });
            return approved;
        });
        const selectEntry = mock(async (input: Parameters<ProtocolUi['selectEntry']>[0]) => {
            expect(input.filter.getEntries()[0]).toBe(chosen);
            expect(input.topMessage).toBe('Select password for KeePassXC-Browser');
            return chosen;
        });
        const f = fixture({ connect, selectEntry });
        chosen = f.entry as unknown as EntryModel;
        const client = await handshake();
        const result = await call(client, 'get-logins', { url: f.entry.url });
        expect(result.ok).toMatchObject({ success: 'true', hash: KEEWEB_HASH, count: 1,
            entries: [{ group: 'Vault', login: 'user', password: 'secret', skipAutoSubmit: 'false' }] });
        expect(connect).toHaveBeenCalledTimes(1);
        expect(selectEntry).toHaveBeenCalledTimes(1);
        expect(RuntimeDataModel.extensionConnectConfig).toEqual(approved);
    });

    test('one exact match with askGet=multiple keeps the no-picker path', async () => {
        const selectEntry = mock(async () => null);
        const f = fixture({ selectEntry, connect: async () => ({ ...approved, askGet: 'multiple' }) });
        const client = await handshake();
        expect((await call(client, 'get-logins', { url: f.entry.url })).ok?.count).toBe(1);
        expect(selectEntry).not.toHaveBeenCalled();
    });

    test('entry cancellation and field cancellation keep user-rejected code 6', async () => {
        const f = fixture();
        const client = await handshake();
        expect((await call(client, 'get-logins', { url: f.entry.url })).error?.errorCode).toBe('6');
        f.ui.selectEntry = async () => f.entry as unknown as EntryModel;
        expect((await call(client, 'get-any-field', { url: f.entry.url })).error?.errorCode).toBe('6');
    });

    test('field selection unwraps only the chosen field in the engine', async () => {
        const f = fixture();
        f.ui.selectEntry = async () => f.entry as unknown as EntryModel;
        f.ui.selectField = async ({ entry }) => {
            expect(entry.getAllFields().Password).toBeInstanceOf(kdbxweb.ProtectedValue);
            return 'Password';
        };
        const client = await handshake();
        expect((await call(client, 'get-any-field', { url: f.entry.url })).ok)
            .toMatchObject({ success: 'true', field: 'Password', value: 'secret' });
    });

    test('save denial performs no mutation; approval preserves the new Browser group sentinel', async () => {
        const f = fixture();
        const client = await handshake();
        const payload = { url: f.entry.url, login: 'saved-user', password: 'saved-secret' };
        expect((await call(client, 'set-login', payload)).error?.errorCode).toBe('6');
        expect(f.createNewEntryWithFields).not.toHaveBeenCalled();
        expect(f.createNewGroupWithName).not.toHaveBeenCalled();
        f.ui.saveEntry = async (input) => {
            expect(input).toMatchObject({ url: payload.url, user: payload.login, update: false, askSave: 'always' });
            expect(input).not.toHaveProperty('password');
            expect(input.allGroups[1]).toMatchObject({ id: '', fileId: 'f1', selected: true });
            return { fileId: 'f1', groupId: '', askSave: 'auto' };
        };
        expect((await call(client, 'set-login', payload)).ok).toMatchObject({ success: 'true', count: null, entries: null });
        expect(f.createNewGroupWithName).toHaveBeenCalledWith(f.root, expect.anything(), 'Browser');
        expect(f.createNewEntryWithFields).toHaveBeenCalledTimes(1);
        const fields = (f.createNewEntryWithFields.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
        expect(fields.Title).toBe('example.com');
        expect((fields.Password as InstanceType<typeof kdbxweb.ProtectedValue>).getText()).toBe('saved-secret');
        expect(ProtocolImpl.sessions[0].permissions).toMatchObject({ askSave: 'auto', saveTo: { fileId: 'f1', groupId: 'new' } });
    });

    test('group creation returns selected file and creates normalized path only after approval', async () => {
        const f = fixture();
        const client = await handshake();
        expect((await call(client, 'create-new-group', { groupName: ' A / / B ' })).error?.errorCode).toBe('6');
        expect(f.createNewGroupWithName).not.toHaveBeenCalled();
        f.ui.createGroup = async (input) => {
            expect(input).toMatchObject({ groupPath: 'A / B', files: [{ id: 'f1', name: 'Vault', selected: true }] });
            return 'f1';
        };
        expect((await call(client, 'create-new-group', { groupName: ' A / / B ' })).ok)
            .toMatchObject({ success: 'true', name: 'B' });
        expect(f.createNewGroupWithName.mock.calls.map((args) => args[2])).toEqual(['A', 'B']);
    });

    test('touch notice is disposed on OTP completion and cancellation', async () => {
        const dispose = mock(() => {});
        const f = fixture({ showTouch: (input) => {
            expect(input.deviceShortName).toBe('Key');
            return { dispose };
        } });
        f.entry.needsTouch = true;
        f.ui.selectEntry = async () => f.entry as unknown as EntryModel;
        const client = await handshake();
        expect((await call(client, 'get-totp-by-url', { url: f.entry.url })).ok?.totp).toBe('123456');
        expect(dispose).toHaveBeenCalledTimes(1);
        f.ui.showTouch = (_input, cancel) => { cancel(); return { dispose }; };
        expect((await call(client, 'get-totp-by-url', { url: f.entry.url })).error?.errorCode).toBe('6');
        expect(dispose).toHaveBeenCalledTimes(2);
    });

    test('timed-out consent aborts the UI and cannot later approve', async () => {
        const previous = Timeouts.KeeWebConnectRequest;
        Timeouts.KeeWebConnectRequest = 5;
        let signal: AbortSignal | undefined;
        let approve: ((value: typeof approved) => void) | undefined;
        try {
            const f = fixture({ connect: (_input, abortSignal) => {
                signal = abortSignal;
                return new Promise((resolve) => { approve = resolve; });
            } });
            const client = await handshake();
            expect((await call(client, 'get-logins', { url: f.entry.url })).error?.errorCode).toBe('6');
            expect(signal?.aborted).toBe(true);
            approve?.(approved);
            await Promise.resolve();
            expect(RuntimeDataModel.extensionConnectConfig).toBeUndefined();
        } finally { Timeouts.KeeWebConnectRequest = previous; }
    });

    function deferred<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((yes) => { resolve = yes; });
        return { promise, resolve };
    }

    for (const kind of ['connect', 'selectEntry', 'selectField', 'saveEntry', 'createGroup'] as const) {
        test(`gate invalidation cancels held ${kind} and late approval cannot mutate or deliver`, async () => {
            const f = fixture();
            f.ui.selectEntry = async () => f.entry as unknown as EntryModel;
            const shown = deferred<AbortSignal>();
            const decision = deferred<unknown>();
            Object.assign(f.ui, { [kind]: (_input: unknown, signal: AbortSignal) => {
                shown.resolve(signal); return decision.promise;
            } });
            const action = kind === 'saveEntry' ? 'set-login' : kind === 'createGroup' ? 'create-new-group'
                : kind === 'selectField' ? 'get-any-field' : 'get-logins';
            const client = await handshake();
            const result = call(client, action, { url: f.entry.url, login: 'new', password: 'secret', groupName: 'New' });
            const signal = await shown.promise;
            const gate = getSessionAccess(f.model);
            gate.beginSecuring();
            expect(f.model.files.hasOpenFiles()).toBe(true);
            expect(signal.aborted).toBe(true);
            expect((await result).error?.errorCode).toBe('1');
            decision.resolve(kind === 'connect' ? approved : kind === 'selectEntry' ? f.entry : kind === 'selectField'
                ? 'Password' : kind === 'saveEntry' ? { fileId: 'f1', groupId: 'root', askSave: 'auto' } : 'f1');
            await Promise.resolve(); await Promise.resolve();
            expect(f.createNewEntryWithFields).not.toHaveBeenCalled();
            expect(f.createNewGroupWithName).not.toHaveBeenCalled();
            expect(RuntimeDataModel.extensionSaveConfig).toBeUndefined();
            if (kind === 'connect') expect(RuntimeDataModel.extensionConnectConfig).toBeUndefined();
        });
    }

    for (const invalidation of ['disconnect', 'permissions', 'rekey', 'forget'] as const) {
        test(`held save is denied on ${invalidation}`, async () => {
            const shown = deferred<AbortSignal>();
            const decision = deferred<{ fileId: string; groupId: string; askSave: string }>();
            const f = fixture({ saveEntry: (_input, signal) => { shown.resolve(signal); return decision.promise; } });
            const client = await handshake();
            const result = call(client, 'set-login', { url: f.entry.url, login: 'new', password: 'value' });
            const signal = await shown.promise;
            if (invalidation === 'disconnect') ProtocolImpl.deleteConnection(1);
            if (invalidation === 'permissions') ProtocolImpl.setClientPermissions(client.clientId, { allFiles: false, files: [] });
            if (invalidation === 'rekey') await handshake('replacement');
            if (invalidation === 'forget') {
                const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
                Object.defineProperty(globalThis, 'localStorage', { value: {}, configurable: true });
                try { ProtocolImpl.forgetLegacyApproval(); }
                finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
            }
            expect(signal.aborted).toBe(true);
            expect((await result).error?.errorCode).toBe('6');
            decision.resolve({ fileId: 'f1', groupId: 'root', askSave: 'auto' });
            await Promise.resolve(); await Promise.resolve();
            expect(f.createNewEntryWithFields).not.toHaveBeenCalled();
            expect(RuntimeDataModel.extensionSaveConfig).toBeUndefined();
        });
    }

    test('gate rejects automatic fill/save with retained models but permits locked status and handshake', async () => {
        const f = fixture();
        const gate = getSessionAccess(f.model);
        gate.beginSecuring();
        const client = await handshake();
        RuntimeDataModel.extensionConnectConfig = { ...approved, askGet: 'multiple', askSave: 'auto', saveTo: { fileId: 'f1', groupId: 'root' } };
        expect((await call(client, 'kwx-features')).ok?.locked).toBe(true);
        expect((await call(client, 'get-logins', { url: f.entry.url })).error?.errorCode).toBe('1');
        expect((await call(client, 'set-login', { url: f.entry.url, password: 'value' })).error?.errorCode).toBe('1');
        expect(f.createNewEntryWithFields).not.toHaveBeenCalled();
    });

    test('transport delivery rechecks epoch, current permissions and file/database identity', async () => {
        for (const reason of ['epoch', 'permission', 'file', 'db'] as const) {
            const f = fixture({ connect: async () => ({ ...approved, askGet: 'multiple' }) });
            delete RuntimeDataModel.extensionConnectConfig;
            const client = await handshake();
            const response = await ProtocolImpl.handleRequest(buildEncryptedRequest(client, 'get-logins', { url: f.entry.url }), conn);
            expect(response.message).toBeDefined();
            if (reason === 'epoch') getSessionAccess(f.model).beginSecuring();
            if (reason === 'permission') ProtocolImpl.setClientPermissions(client.clientId, { allFiles: false, files: [] });
            if (reason === 'file') f.file.active = false;
            if (reason === 'db') f.file.db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(null), 'Replacement');
            const delivered = ProtocolImpl.prepareResponse(response);
            expect(delivered.error).toBeDefined();
            expect(delivered.message).toBeUndefined();
        }
    });

    test('touch OTP cancellation disconnects promptly and consumes late provider completion', async () => {
        const shown = deferred<void>();
        const dispose = mock(() => {});
        const f = fixture({ showTouch: () => { shown.resolve(); return { dispose }; } });
        f.entry.needsTouch = true;
        f.ui.selectEntry = async () => f.entry as unknown as EntryModel;
        let complete!: (error: null, otp: string) => void;
        f.entry.otpGenerator.next = (callback) => { complete = callback; };
        const client = await handshake();
        const pending = call(client, 'get-totp-by-url', { url: f.entry.url });
        await shown.promise;
        ProtocolImpl.deleteConnection(1);
        expect((await pending).error?.errorCode).toBe('6');
        expect(dispose).toHaveBeenCalledTimes(1);
        complete(null, 'late-secret');
        await Promise.resolve();
    });

    test('save rejects read-only, syncing, removed and recycled destinations', async () => {
        for (const reason of ['readonly', 'syncing', 'removed', 'trash'] as const) {
            const f = fixture({ saveEntry: async () => ({ fileId: 'f1', groupId: 'root', askSave: 'always' }) });
            if (reason === 'readonly') Object.assign(f.file, { readOnly: true });
            if (reason === 'syncing') Object.assign(f.file, { syncing: true });
            if (reason === 'removed') f.file.getGroup = () => undefined;
            if (reason === 'trash') {
                Object.assign(f.file.db.meta, { recycleBinUuid: {} });
                Object.assign(f.root.group.uuid, { equals: () => true });
            }
            const client = await handshake();
            expect((await call(client, 'set-login', { url: f.entry.url, password: 'new' })).error).toBeDefined();
            expect(f.createNewEntryWithFields).not.toHaveBeenCalled();
        }
    });


    test('lock command acknowledges while synchronously canceling content and observer cleanup does not duplicate notifications', async () => {
        const before = Events.listenerCount('lock-workspace');
        const f = fixture();
        expect(Events.listenerCount('lock-workspace')).toBe(before + 1);
        const client = await handshake();
        const close = () => { getSessionAccess(f.model).beginSecuring(); };
        Events.on('lock-workspace', close);
        try {
            expect((await call(client, 'lock-database')).ok?.success).toBe('true');
            expect((await call(client, 'kwx-features')).ok?.locked).toBe(true);
        } finally { Events.off('lock-workspace', close); ProtocolImpl.cleanup(); }
        expect(Events.listenerCount('lock-workspace')).toBe(before);
        fixture(); ProtocolImpl.cleanup();
        expect(Events.listenerCount('lock-workspace')).toBe(before);
    });

    test('normal physical unlock can complete, but disconnect cancels only its pending unlock', async () => {
        const { AppSettingsModel } = await import('models/app-settings-model');
        const previous = AppSettingsModel.extensionFocusIfLocked;
        AppSettingsModel.extensionFocusIfLocked = true;
        try {
            for (const disconnect of [false, true]) {
                const f = fixture({ connect: async () => ({ ...approved, askGet: 'multiple' }) });
                let open = false;
                f.model.files.hasOpenFiles = () => open;
                const pending = deferred<typeof f.file>();
                const started = deferred<void>();
                const owner = { resolve: pending.resolve, reject() {}, unlockRes: '' };
                Object.assign(f.model, {
                    unlockAnyFile() { f.model.fileUnlockPromise = owner as unknown as AppModel['fileUnlockPromise']; started.resolve(); return pending.promise; },
                    rejectPendingFileUnlockPromise: mock(() => { f.model.fileUnlockPromise = null; })
                });
                const client = await handshake();
                const request = call(client, 'get-logins', { url: f.entry.url });
                await started.promise;
                if (disconnect) {
                    ProtocolImpl.deleteConnection(1);
                    expect((await request).error).toBeDefined();
                    expect(f.model.rejectPendingFileUnlockPromise).toHaveBeenCalledTimes(1);
                    pending.resolve(f.file);
                } else {
                    open = true;
                    Events.emit('file-opened');
                    pending.resolve(f.file);
                    expect((await request).ok?.count).toBe(1);
                    expect(f.model.rejectPendingFileUnlockPromise).not.toHaveBeenCalled();
                }
            }
        } finally { AppSettingsModel.extensionFocusIfLocked = previous; }
    });

});


describe('extension transport lifecycle', () => {
    let connector: typeof import('../../../../vault/src/comp/extension/browser-extension-connector').BrowserExtensionConnector;
    let originalGlobals: Map<string, PropertyDescriptor | undefined>;
    const listeners = new Set<unknown>();
    const fakeWindow = { location: { origin: 'https://vault.example' },
        addEventListener(_event: string, listener: unknown) { listeners.add(listener); },
        removeEventListener(_event: string, listener: unknown) { listeners.delete(listener); } };
    const posted = mock((_response: ProtocolResponse, _origin: string) => {});
    const invalidation = new Set<() => void>();
    const access = { snapshot: () => ({ open: true, epoch: 0 }), assertOpen() {},
        subscribeInvalidation(listener: () => void) { invalidation.add(listener); return () => { invalidation.delete(listener); }; } };
    let init: ReturnType<typeof spyOn<typeof ProtocolImpl, 'init'>>;
    let cleanup: ReturnType<typeof spyOn<typeof ProtocolImpl, 'cleanup'>>;
    let handle: ReturnType<typeof spyOn<typeof ProtocolImpl, 'handleRequest'>>;
    let prepare: ReturnType<typeof spyOn<typeof ProtocolImpl, 'prepareResponse'>>;
    const send = (action = 'get-logins') => connector.browserWindowMessage({ source: window, origin: location.origin,
        data: { kwConnect: 'request', action, clientID: 'client' } } as MessageEvent);
    const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
    beforeEach(async () => {
        ProtocolImpl.cleanup();
        originalGlobals = new Map(['window', 'location', 'localStorage', 'postMessage', 'navigator', 'screen'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        for (const [name, value] of Object.entries({ window: fakeWindow, location: fakeWindow.location, localStorage: {}, postMessage: posted,
            navigator: { platform: '', userAgent: '' }, screen: { width: 1280 } })) {
            Object.defineProperty(globalThis, name, { value, configurable: true });
        }
        connector = (await import('../../../../vault/src/comp/extension/browser-extension-connector')).BrowserExtensionConnector;
        init = spyOn(ProtocolImpl, 'init').mockImplementation(() => {});
        cleanup = spyOn(ProtocolImpl, 'cleanup').mockImplementation(() => {});
        handle = spyOn(ProtocolImpl, 'handleRequest').mockImplementation(async () => ({ action: 'get-logins', message: 'ciphertext' }));
        prepare = spyOn(ProtocolImpl, 'prepareResponse').mockImplementation((response) => response);
        posted.mockClear();
        connector.init({} as AppModel, testUi(), access);
    });
    afterEach(() => {
        connector.stop(); init.mockRestore(); cleanup.mockRestore(); handle.mockRestore(); prepare.mockRestore();
        for (const [name, descriptor] of originalGlobals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });
    test('stop/start renews policy binding and keeps exactly one window listener', () => {
        expect(listeners.size).toBe(1); expect(invalidation.size).toBe(1);
        connector.start(); expect(init).toHaveBeenCalledTimes(1);
        connector.stop(); expect(listeners.size).toBe(0); expect(invalidation.size).toBe(0);
        connector.start(); expect(init).toHaveBeenCalledTimes(2);
        expect(listeners.size).toBe(1); expect(invalidation.size).toBe(1);
    });
    test('posting uses the final policy guard result, never previously encrypted content', async () => {
        prepare.mockImplementation(() => ({ action: 'get-logins', error: 'Access suspended', errorCode: '1' }));
        send(); await settle();
        expect(posted.mock.calls[0]).toEqual([{ action: 'get-logins', error: 'Access suspended', errorCode: '1', kwConnect: 'response' }, 'https://vault.example']);
    });
    test('queued operations are denied synchronously on invalidation', async () => {
        let finish!: (value: ProtocolResponse) => void;
        handle.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
        send('get-logins'); send('set-login');
        expect(handle).toHaveBeenCalledTimes(1);
        invalidation.forEach((listener) => listener());
        expect(posted.mock.calls[0][0]).toMatchObject({ action: 'set-login', errorCode: '1' });
        finish({ action: 'get-logins', errorCode: '1', error: 'Access suspended' }); await settle();
        expect(handle).toHaveBeenCalledTimes(1);
    });
    test('an in-flight response from an old transport lifetime is discarded after restart', async () => {
        let finish!: (value: ProtocolResponse) => void;
        handle.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
        send(); connector.stop(); connector.start();
        finish({ action: 'get-logins', message: 'old ciphertext' }); await settle();
        expect(posted).not.toHaveBeenCalled();
    });
    test('other windows and origins cannot enter the queue', async () => {
        connector.browserWindowMessage({ source: null, origin: location.origin, data: { kwConnect: 'request' } } as MessageEvent);
        connector.browserWindowMessage({ source: window, origin: 'https://evil.example', data: { kwConnect: 'request' } } as MessageEvent);
        await settle(); expect(handle).not.toHaveBeenCalled();
    });
});
