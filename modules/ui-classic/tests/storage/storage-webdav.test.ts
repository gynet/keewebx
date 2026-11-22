import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import {
    installMockedModule,
    restoreAllMockedModules,
} from '../helpers/mock-isolation';

// IMPORTANT: Bun's `mock.module(name, factory)` is a process-wide
// override regardless of whether `name` is a relative path or a bare
// specifier. Both forms normalise to the same absolute module record,
// so a mock installed here persists for every subsequent test file in
// the same `bun test` run. A previous version of this file assumed
// relative-path mocks were file-scoped and used raw `mock.module` for
// them — that was wrong. When `storage-webdav.test.ts` happens to run
// before `tests/models/app-settings-model.test.ts` (which is what
// Linux CI does even though macOS does not), the latter's
// `await import('.../app-settings-model')` saw this file's stub and
// `AppSettingsModel.upgrade` / `.set` were undefined, failing 9 tests.
//
// Fix: route all mocks that have a real-module consumer elsewhere in
// the test suite through `installMockedModule`, and restore them in
// `afterAll`. The one exception is `runtime-data-model`, which has a
// top-level `window` access that blows up during snapshot capture in
// Bun's non-DOM test env — and which no other test file uses the real
// version of — so we keep it on raw `mock.module` (the leak is inert).

await installMockedModule('../../../vault/src/models/app-settings-model', () => ({
    AppSettingsModel: {
        webdav: true,
        webdavSaveMethod: 'default',
        webdavStatReload: false
    }
}));

// runtime-data-model's module body touches `window` — cannot snapshot
// safely. No other test file imports the real module, so a leak here
// is inert.
mock.module('../../../vault/src/models/runtime-data-model', () => ({
    RuntimeDataModel: {}
}));

await installMockedModule('../../../vault/src/util/logger', () => ({
    Logger: class {
        debug(..._args: unknown[]) {}
        info(..._args: unknown[]) {}
        error(..._args: unknown[]) {}
        ts(_start?: unknown) { return '0ms'; }
    }
}));

// locale.ts imports `locales/base.json` via a webpack alias that Bun
// cannot resolve in-test, so snapshot capture would fail. Use raw
// mock.module; no other test imports the real Locale, so the leak is
// inert — but if that ever changes, revisit this.
mock.module('../../../vault/src/util/locale', () => ({
    Locale: {
        webdavNoLastModified: 'No Last-Modified header'
    }
}));

// `kdbxweb` is a published bare-specifier shared across multiple test
// files (notably `tests/comp/extension/protocol-impl.test.ts`).
const kdbx = await import('kdbxweb');
const { encryptWebDavPassword } = await import('comp/crypto/webdav-cred-crypto');

await installMockedModule('kdbxweb', () => ({
    ...kdbx,
    CryptoEngine: {
        ...kdbx.CryptoEngine,
        sha256: (_data: ArrayBuffer) => Promise.resolve(new ArrayBuffer(32))
    },
    ByteUtils: {
        ...kdbx.ByteUtils,
        bytesToHex: () => 'abcdef0123456789ab'
    }
}));

afterAll(restoreAllMockedModules);

const { StorageWebDav } = await import('../../../vault/src/storage/impl/storage-webdav');

describe('StorageWebDav', () => {
    let storage: InstanceType<typeof StorageWebDav>;

    beforeEach(() => {
        storage = new StorageWebDav();
        storage.init();
    });

    test('has correct name and icon', () => {
        expect(storage.name).toBe('webdav');
        expect(storage.icon).toBe('server');
        expect(storage.enabled).toBe(true);
        expect(storage.uipos).toBe(10);
    });

    test('needShowOpenConfig returns true', () => {
        expect(storage.needShowOpenConfig()).toBe(true);
    });

    test('getOpenConfig returns required URL field', () => {
        const config = storage.getOpenConfig();
        expect(config.fields).toHaveLength(3);

        const pathField = config.fields[0];
        expect(pathField.id).toBe('path');
        expect(pathField.required).toBe(true);
        expect(pathField.pattern).toBe('^https://.+');

        const userField = config.fields[1];
        expect(userField.id).toBe('user');
        expect(userField.type).toBe('text');

        const passField = config.fields[2];
        expect(passField.id).toBe('password');
        expect(passField.type).toBe('password');
    });

    test('getSettingsConfig returns save method and stat reload options', () => {
        const config = storage.getSettingsConfig();
        expect(config.fields).toHaveLength(2);

        const saveMethod = config.fields[0];
        expect(saveMethod.id).toBe('webdavSaveMethod');
        expect(saveMethod.type).toBe('select');

        const statReload = config.fields[1];
        expect(statReload.id).toBe('webdavStatReload');
        expect(statReload.type).toBe('checkbox');
    });

    describe('_xorString', () => {
        test('XORs two equal-length strings', () => {
            const result = storage._xorString('abc', 'xyz');
            // 'a' ^ 'x' = 97 ^ 120 = 25, 'b' ^ 'y' = 98 ^ 121 = 27, 'c' ^ 'z' = 99 ^ 122 = 25
            expect(result.charCodeAt(0)).toBe(97 ^ 120);
            expect(result.charCodeAt(1)).toBe(98 ^ 121);
            expect(result.charCodeAt(2)).toBe(99 ^ 122);
        });

        test('wraps key string when shorter', () => {
            const result = storage._xorString('abcd', 'xy');
            // 'c' ^ 'x', 'd' ^ 'y' (key wraps)
            expect(result.charCodeAt(2)).toBe(99 ^ 120);
            expect(result.charCodeAt(3)).toBe(100 ^ 121);
        });

        test('XOR is reversible', () => {
            const original = 'MyP@ssw0rd!';
            const key = 'uuid-1234-5678';
            const encrypted = storage._xorString(original, key);
            const decrypted = storage._xorString(encrypted, key);
            expect(decrypted).toBe(original);
        });
    });

    describe('WebDAV credentials', () => {
        const passwordHash = new Uint8Array(32).fill(1);
        const password = kdbx.ProtectedValue.fromString('vault password');
        const otherPassword = kdbx.ProtectedValue.fromString('other vault password');
        const keyFile = new Uint8Array(32).fill(2);
        const opts = { user: 'admin', password: 'remote password' };

        async function makeFile(secret: typeof password | null, key?: Uint8Array) {
            const credentials = new kdbx.Credentials(secret, key?.slice());
            await credentials.ready;
            const db = kdbx.Kdbx.create(credentials, 'WebDAV test');
            // Use a small real AES KDF so the fixture needs no Argon2 worker.
            const params = db.header.kdfParameters!;
            params.set('$UUID', kdbx.VarDictionary.ValueType.Bytes, kdbx.ByteUtils.base64ToBytes(kdbx.Consts.KdfId.Aes));
            params.set('R', kdbx.VarDictionary.ValueType.UInt64, new kdbx.Int64(16));
            return { uuid: 'test-vault', db };
        }

        test('unwraps transformed-key credentials before making a network request', async () => {
            const file = await makeFile(password, keyFile);
            const stored = await storage.fileOptsToStoreOpts(opts, file);
            expect(stored.encpass).toStartWith('aesgcm-v2:');
            expect(stored.encpassKdf).toBeTruthy();
            expect(stored.password).toBeUndefined();
            expect(await storage.prepareOpenOpts(stored, password, keyFile.slice())).toEqual(opts);
            await expect(storage.prepareOpenOpts(stored, password)).rejects.toMatchObject({ code: 'InvalidKey' });
            await expect(storage.prepareOpenOpts(stored, otherPassword, keyFile.slice())).rejects.toMatchObject({ code: 'InvalidKey' });
            await expect(storage.prepareOpenOpts({ ...stored, encpassSalt: 'another-vault' }, password, keyFile.slice()))
                .rejects.toMatchObject({ code: 'InvalidKey' });
        });

        test('a key-file-only vault also uses the KDBX KDF', async () => {
            const file = await makeFile(null, keyFile);
            const stored = await storage.fileOptsToStoreOpts(opts, file);
            expect(stored.encpass).toStartWith('aesgcm-v2:');
            expect(await storage.prepareOpenOpts(stored, null, keyFile.slice())).toEqual(opts);
        });

        test('does not persist a remote password when KDBX factors cannot protect it', async () => {
            const file = await makeFile(password);
            expect(await storage.fileOptsToStoreOpts(opts, { ...file, chalResp: true })).toEqual({ user: opts.user });
            expect(await storage.fileOptsToStoreOpts(opts, { uuid: file.uuid })).toEqual({ user: opts.user });
        });

        test('legacy records remain readable and are rewritten in the current format', async () => {
            const file = await makeFile(password);
            const legacyAes = { user: opts.user, encpass: (await encryptWebDavPassword(opts.password, passwordHash, file.uuid))!,
                encpassSalt: file.uuid };
            const legacyXor = { user: opts.user, encpass: btoa(storage._xorString(opts.password, file.uuid)) };
            const temporary = passwordHash.slice();
            const legacyPassword = { getHash: async () => temporary.buffer } as typeof password;
            expect(await storage.prepareOpenOpts(legacyAes, legacyPassword)).toEqual(opts);
            expect(temporary.every(byte => byte === 0)).toBe(true);
            expect(await storage.prepareOpenOpts(legacyXor, null)).toEqual(legacyXor);
            const decoded = await storage.storeOptsToFileOpts(legacyXor, file);
            expect(decoded).toEqual(opts);
            const rewritten = await storage.fileOptsToStoreOpts(decoded, file);
            expect(rewritten.encpass).toStartWith('aesgcm-v2:');
            expect(await storage.prepareOpenOpts(rewritten, password)).toEqual(opts);
        });
    });

    test('applySetting updates appSettings', () => {
        storage.applySetting('webdavSaveMethod', 'put');
        expect((storage.appSettings as unknown as Record<string, unknown>).webdavSaveMethod).toBe('put');
    });

    describe('_isCrossOrigin', () => {
        // In Bun's test runner there is no browser `window`, so
        // `_isCrossOrigin` catches the error and returns false.
        // We can still verify the error-path and the URL parsing
        // by temporarily providing a global `window`.
        const origWindow = globalThis.window;

        afterAll(() => {
            if (origWindow === undefined) {
                delete (globalThis as Record<string, unknown>).window;
            } else {
                (globalThis as Record<string, unknown>).window = origWindow;
            }
        });

        test('returns true for different origin', () => {
            (globalThis as Record<string, unknown>).window = {
                location: { href: 'http://localhost:8085/', origin: 'http://localhost:8085' }
            };
            expect(storage._isCrossOrigin('https://example.com/webdav/file.kdbx')).toBe(true);
        });

        test('returns true for different port on same host', () => {
            (globalThis as Record<string, unknown>).window = {
                location: { href: 'http://localhost:8085/', origin: 'http://localhost:8085' }
            };
            expect(storage._isCrossOrigin('http://localhost:5006/webdav/file.kdbx')).toBe(true);
        });

        test('returns false for same origin', () => {
            (globalThis as Record<string, unknown>).window = {
                location: { href: 'http://localhost:8085/', origin: 'http://localhost:8085' }
            };
            expect(storage._isCrossOrigin('http://localhost:8085/webdav/file.kdbx')).toBe(false);
        });

        test('returns false for invalid URL when window is missing', () => {
            delete (globalThis as Record<string, unknown>).window;
            expect(storage._isCrossOrigin('')).toBe(false);
        });
    });
});


describe('WebDAV browser connectivity', () => {
    let storage: InstanceType<typeof StorageWebDav>;
    let connectivity: EventTarget;
    let network: { onLine: boolean };
    let globals: Map<string, PropertyDescriptor | undefined>;

    class Request extends EventTarget {
        static instances: Request[] = [];
        status = 200;
        responseType = '';
        sends = 0;
        aborts = 0;
        constructor() { super(); Request.instances.push(this); }
        open() {}
        setRequestHeader() {}
        getResponseHeader() { return 'Mon, 01 Jan 2024 00:00:00 GMT'; }
        send() { this.sends++; }
        abort() {
            this.aborts++;
            this.dispatchEvent(new Event('abort'));
            this.dispatchEvent(new Event('loadend'));
        }
        complete(type = 'load') {
            this.dispatchEvent(new Event(type));
            this.dispatchEvent(new Event('loadend'));
        }
    }

    beforeEach(() => {
        globals = new Map(['window', 'navigator', 'XMLHttpRequest'].map(key =>
            [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
        connectivity = Object.assign(new EventTarget(), { location: { href: 'https://app.example/' } });
        network = { onLine: true };
        for (const [key, value] of Object.entries({ window: connectivity, navigator: network, XMLHttpRequest: Request })) {
            Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        }
        Request.instances = [];
        storage = new StorageWebDav(); storage.init();
    });
    afterEach(() => {
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete (globalThis as Record<string, unknown>)[key];
        }
    });

    test('already offline completes asynchronously without opening a request; reconnect can retry', async () => {
        network.onLine = false;
        const offline = mock();
        storage._request({ op: 'stat', method: 'HEAD', path: 'https://dav.example/vault.kdbx' }, offline);
        expect(offline).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(offline).toHaveBeenCalledTimes(1);
        expect(offline).toHaveBeenCalledWith('offline');
        expect(Request.instances).toHaveLength(0);

        network.onLine = true;
        const retry = mock();
        storage._request({ op: 'stat', method: 'HEAD', path: 'https://dav.example/vault.kdbx' }, retry);
        expect(Request.instances[0].sends).toBe(1);
        Request.instances[0].complete();
        expect(retry).toHaveBeenCalledTimes(1);
        expect(retry.mock.calls[0][0]).toBeNull();
    });

    for (const method of ['HEAD', 'GET', 'PUT', 'MOVE']) {
        test(`${method} in flight is aborted once on offline, ignoring late completion`, () => {
            const callback = mock();
            storage._request({ op: 'request', method, path: 'https://dav.example/vault.kdbx' }, callback);
            const request = Request.instances[0];
            network.onLine = false;
            connectivity.dispatchEvent(new Event('offline'));
            expect(request.aborts).toBe(1);
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback.mock.calls[0][0]).toBe('aborted');
            request.complete();
            connectivity.dispatchEvent(new Event('offline'));
            expect(request.aborts).toBe(1);
            expect(callback).toHaveBeenCalledTimes(1);
        });
    }

    for (const event of ['load', 'error']) {
        test(`${event} releases the connectivity listener without changing its result`, () => {
            const callback = mock();
            storage._request({ op: 'load', method: 'GET', path: 'https://dav.example/vault.kdbx' }, callback);
            const request = Request.instances[0];
            if (event === 'error') request.status = 0;
            request.complete(event);
            connectivity.dispatchEvent(new Event('offline'));
            expect(request.aborts).toBe(0);
            expect(callback).toHaveBeenCalledTimes(1);
            if (event === 'load') expect(callback.mock.calls[0][0]).toBeNull();
            else expect(callback.mock.calls[0][0].cors).toBe(true);
        });
    }
});
