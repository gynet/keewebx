import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
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

await installMockedModule('../../app/scripts/models/app-settings-model', () => ({
    AppSettingsModel: {
        webdav: true,
        webdavSaveMethod: 'default',
        webdavStatReload: false
    }
}));

// runtime-data-model's module body touches `window` — cannot snapshot
// safely. No other test file imports the real module, so a leak here
// is inert.
mock.module('../../app/scripts/models/runtime-data-model', () => ({
    RuntimeDataModel: {}
}));

await installMockedModule('../../app/scripts/util/logger', () => ({
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
mock.module('../../app/scripts/util/locale', () => ({
    Locale: {
        webdavNoLastModified: 'No Last-Modified header'
    }
}));

// `kdbxweb` is a published bare-specifier shared across multiple test
// files (notably `tests/comp/extension/protocol-impl.test.ts`).
await installMockedModule('kdbxweb', () => ({
    CryptoEngine: {
        sha256: (_data: ArrayBuffer) => Promise.resolve(new ArrayBuffer(32))
    },
    ByteUtils: {
        bytesToHex: () => 'abcdef0123456789ab'
    }
}));

afterAll(restoreAllMockedModules);

const { StorageWebDav } = await import('../../app/scripts/storage/impl/storage-webdav');

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

    describe('credential handling (XOR fallback, no passwordHash)', () => {
        test('fileOptsToStoreOpts encodes password with XOR when no passwordHash', async () => {
            const opts = { user: 'admin', password: 'secret' };
            const file = { uuid: 'test-uuid' };
            const result = await storage.fileOptsToStoreOpts(opts, file);
            expect(result.user).toBe('admin');
            expect(result.encpass).toBeTruthy();
            expect(result.password).toBeUndefined();
        });

        test('storeOptsToFileOpts decodes XOR password', async () => {
            const opts = { user: 'admin', password: 'secret' };
            const file = { uuid: 'test-uuid' };
            const storeOpts = await storage.fileOptsToStoreOpts(opts, file);
            const fileOpts = await storage.storeOptsToFileOpts(storeOpts, file);
            expect(fileOpts.user).toBe('admin');
            expect(fileOpts.password).toBe('secret');
        });

        test('round-trip with different file UUIDs gives different encpass', async () => {
            const opts = { user: 'u', password: 'a-longer-password-value' };
            const file1 = { uuid: 'aaaaaaaa-1111-2222-3333-444444444444' };
            const file2 = { uuid: 'bbbbbbbb-5555-6666-7777-888888888888' };
            const enc1 = await storage.fileOptsToStoreOpts(opts, file1);
            const enc2 = await storage.fileOptsToStoreOpts(opts, file2);
            expect(enc1.encpass).not.toBe(enc2.encpass);
        });

        test('preserves user without password', async () => {
            const opts = { user: 'admin' } as { user: string; password?: string };
            const file = { uuid: 'test' };
            const result = await storage.fileOptsToStoreOpts(opts, file);
            expect(result.user).toBe('admin');
            expect(result.encpass).toBeUndefined();
        });
    });

    describe('credential handling (AES-GCM with passwordHash)', () => {
        // 32-byte fake password hash for testing
        const passwordHash = new Uint8Array(32);
        for (let i = 0; i < 32; i++) passwordHash[i] = i + 1;

        const differentHash = new Uint8Array(32);
        for (let i = 0; i < 32; i++) differentHash[i] = 255 - i;

        test('fileOptsToStoreOpts produces aesgcm: prefixed encpass', async () => {
            const opts = { user: 'admin', password: 'secret' };
            const file = { uuid: 'test-uuid' };
            const result = await storage.fileOptsToStoreOpts(opts, file, passwordHash);
            expect(result.user).toBe('admin');
            expect(result.encpass).toBeTruthy();
            expect(result.encpass!.startsWith('aesgcm:')).toBe(true);
            expect(result.password).toBeUndefined();
        });

        test('storeOptsToFileOpts decrypts aesgcm: format correctly', async () => {
            const opts = { user: 'admin', password: 'MyW3bD@v!' };
            const file = { uuid: 'test-uuid-abc' };
            const storeOpts = await storage.fileOptsToStoreOpts(opts, file, passwordHash);
            const fileOpts = await storage.storeOptsToFileOpts(storeOpts, file, passwordHash);
            expect(fileOpts.user).toBe('admin');
            expect(fileOpts.password).toBe('MyW3bD@v!');
        });

        test('storeOptsToFileOpts migrates old XOR format and re-encrypts', async () => {
            // First encode with XOR (no passwordHash)
            const opts = { user: 'admin', password: 'migrated-pass' };
            const file = { uuid: 'migration-uuid' };
            const xorStoreOpts = await storage.fileOptsToStoreOpts(opts, file);
            // Verify it's XOR format (no aesgcm: prefix)
            expect(xorStoreOpts.encpass!.startsWith('aesgcm:')).toBe(false);

            // Now decrypt with passwordHash (triggers migration)
            const fileOpts = await storage.storeOptsToFileOpts(xorStoreOpts, file, passwordHash);
            expect(fileOpts.password).toBe('migrated-pass');
            // The encpass in xorStoreOpts should have been re-encrypted
            expect(xorStoreOpts.encpass!.startsWith('aesgcm:')).toBe(true);
        });

        test('round-trip: store -> load -> same credentials', async () => {
            const opts = { user: 'deploy-bot', password: 'super$ecret!@#' };
            const file = { uuid: 'roundtrip-file-id' };
            const storeOpts = await storage.fileOptsToStoreOpts(opts, file, passwordHash);
            const recovered = await storage.storeOptsToFileOpts(storeOpts, file, passwordHash);
            expect(recovered.user).toBe('deploy-bot');
            expect(recovered.password).toBe('super$ecret!@#');
        });

        test('wrong master password returns undefined password', async () => {
            const opts = { user: 'admin', password: 'secret' };
            const file = { uuid: 'wrong-pw-test' };
            const storeOpts = await storage.fileOptsToStoreOpts(opts, file, passwordHash);
            // Try to decrypt with different password hash
            const fileOpts = await storage.storeOptsToFileOpts(storeOpts, file, differentHash);
            expect(fileOpts.password).toBeUndefined();
            // Should not crash
            expect(fileOpts.user).toBe('admin');
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
