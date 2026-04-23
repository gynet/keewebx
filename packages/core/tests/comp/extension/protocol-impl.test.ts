import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { box as naclBox } from 'tweetnacl';

/**
 * Protocol-impl integration tests.
 *
 * These exercise the KeePassXC-Browser NaCl box protocol implemented in
 * packages/core/app/scripts/comp/extension/protocol-impl.ts:
 *
 *   - Curve25519 key exchange (change-public-keys handshake)
 *   - XSalsa20 + Poly1305 encrypted request/response via tweetnacl.box
 *   - 24-byte nonces + libsodium little-endian incrementNonce()
 *   - decryptRequest / encryptResponse byte boundaries
 *
 * We mock the heavy UI/view/model dependencies so the module loads in a
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

// --- Mock heavy UI/view/model dependencies so protocol-impl loads cleanly ---
mock.module('views/extension/extension-connect-view', () => ({
    ExtensionConnectView: class {
        config = { allFiles: true };
        render() {}
    }
}));
mock.module('views/extension/extension-save-entry-view', () => ({
    ExtensionSaveEntryView: class {
        config = {};
        render() {}
    }
}));
mock.module('views/extension/extension-create-group-view', () => ({
    ExtensionCreateGroupView: class {
        render() {}
    }
}));
mock.module('views/select/select-entry-view', () => ({
    SelectEntryView: class {
        render() {}
    }
}));
mock.module('views/select/select-entry-field-view', () => ({
    SelectEntryFieldView: class {
        render() {}
    }
}));
mock.module('comp/ui/alerts', () => ({
    Alerts: {
        alertDisplayed: false,
        alert: () => null,
        buttons: {
            allow: { result: 'yes', title: 'Allow' },
            deny: { result: '', title: 'Deny' }
        }
    }
}));
mock.module('comp/app/generator-presets', () => ({
    GeneratorPresets: { browserExtensionPreset: {} }
}));
mock.module('comp/app/select-entry-filter', () => ({
    SelectEntryFilter: class {
        getEntries() {
            return [];
        }
    }
}));
mock.module('util/generators/password-generator', () => ({
    PasswordGenerator: { generate: () => 'generated-password' }
}));
mock.module('util/locale', () => ({
    Locale: {
        extensionErrorNoOpenFiles: 'No files are open',
        extensionErrorUserRejected: 'Rejected by user',
        extensionErrorNoMatches: 'No matches found',
        extensionErrorAlertDisplayed: 'Alert already displayed'
    }
}));
mock.module('models/runtime-data-model', () => ({
    RuntimeDataModel: {}
}));
mock.module('models/app-settings-model', () => ({
    AppSettingsModel: {}
}));

// --- Import the real module under test AFTER mocks are installed ---
const protocolModule = await import(
    '../../../app/scripts/comp/extension/protocol-impl'
);
const { ProtocolImpl } = protocolModule;

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
        appModel: fakeAppModel,
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
