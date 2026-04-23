import { describe, test, expect, beforeEach, mock } from 'bun:test';

/**
 * Unit tests for `comp/settings/settings-store`.
 *
 * This module is the sole persistence layer for recent files, app
 * settings, runtime (extension client permissions, etc), and the
 * update check cache. A prior stub that hard-coded `Promise.resolve()`
 * silently destroyed all metadata persistence across reloads; this
 * test is the permanent regression guard for that class of bug.
 *
 * These tests install an in-memory `globalThis.localStorage` shim
 * before importing the module. Bun's test environment doesn't provide
 * a DOM Storage by default, so we construct a minimal compatible shim
 * that satisfies the `Storage` interface the module uses (only index
 * access and setter, matching upstream's `localStorage[key] = value`
 * idiom).
 */

// Mock 'hbs' (util/fn pulls in Handlebars via webpack alias, not
// available in Bun test context). This matches the pattern from
// tests/models/file-info-model.test.ts.
mock.module('hbs', () => ({
    default: { escapeExpression: (s: string) => s }
}));

// Install a minimal in-memory localStorage shim BEFORE importing the
// module under test. The real browser Storage supports `store[key] =
// value` and `store[key]` in addition to getItem/setItem, and the
// module uses the index form. We back it with a plain object so both
// work naturally.
interface StorageShim {
    [key: string]: string | ((key: string) => string | null) | ((key: string, value: string) => void) | (() => void);
}

function installLocalStorageShim(): Record<string, string> {
    const backing: Record<string, string> = {};
    const shim = new Proxy(backing, {
        get(target, prop): unknown {
            if (prop === 'getItem') {
                return (key: string): string | null => (key in target ? target[key] : null);
            }
            if (prop === 'setItem') {
                return (key: string, value: string): void => {
                    target[key] = String(value);
                };
            }
            if (prop === 'removeItem') {
                return (key: string): void => {
                    delete target[key];
                };
            }
            if (prop === 'clear') {
                return (): void => {
                    for (const k of Object.keys(target)) {
                        delete target[k];
                    }
                };
            }
            if (prop === 'length') {
                return Object.keys(target).length;
            }
            if (prop === 'key') {
                return (i: number): string | null => Object.keys(target)[i] ?? null;
            }
            if (typeof prop === 'string') {
                return target[prop];
            }
            return undefined;
        },
        set(target, prop, value): boolean {
            if (typeof prop === 'string') {
                target[prop] = String(value);
            }
            return true;
        },
        deleteProperty(target, prop): boolean {
            if (typeof prop === 'string') {
                delete target[prop];
            }
            return true;
        },
        has(target, prop): boolean {
            return typeof prop === 'string' && prop in target;
        },
        ownKeys(target): ArrayLike<string | symbol> {
            return Object.keys(target);
        },
        getOwnPropertyDescriptor(target, prop): PropertyDescriptor | undefined {
            if (typeof prop === 'string' && prop in target) {
                return {
                    enumerable: true,
                    configurable: true,
                    writable: true,
                    value: target[prop]
                };
            }
            return undefined;
        }
    });
    (globalThis as unknown as { localStorage: StorageShim }).localStorage = shim as unknown as StorageShim;
    return backing;
}

const backing = installLocalStorageShim();

// Import AFTER the shim is installed.
const { SettingsStore } = await import('../../../app/scripts/comp/settings/settings-store');

describe('SettingsStore', () => {
    beforeEach(() => {
        for (const k of Object.keys(backing)) {
            delete backing[k];
        }
    });

    test('save + load round-trips a plain object', async () => {
        await SettingsStore.save('app-settings', { theme: 'dark', idleMinutes: 30 });
        const loaded = await SettingsStore.load('app-settings');
        expect(loaded).toEqual({ theme: 'dark', idleMinutes: 30 });
    });

    test('save + load round-trips an array of objects', async () => {
        const items = [
            { id: '1', name: 'DB one' },
            { id: '2', name: 'DB two' }
        ];
        await SettingsStore.save('file-info', items);
        const loaded = await SettingsStore.load('file-info');
        expect(loaded).toEqual(items);
    });

    test('load() returns null for a missing key', async () => {
        const loaded = await SettingsStore.load('never-stored');
        expect(loaded).toBeNull();
    });

    test('load() returns null for an empty string', async () => {
        // Upstream treats `undefined`/`null`/`''` as "no data".
        backing['appSettings'] = '';
        const loaded = await SettingsStore.load('app-settings');
        expect(loaded).toBeNull();
    });

    test('save() handles Date objects via JSON serialization', async () => {
        const now = new Date('2026-04-08T12:34:56.789Z');
        await SettingsStore.save('update-info', {
            lastCheckDate: now,
            lastVersion: '2.0.0'
        });
        const loaded = await SettingsStore.load('update-info') as {
            lastCheckDate: string;
            lastVersion: string;
        };
        // JSON.stringify produces an ISO string; caller is responsible
        // for reviving to Date (UpdateModel/FileInfoModel do this).
        expect(typeof loaded.lastCheckDate).toBe('string');
        expect(loaded.lastCheckDate).toBe('2026-04-08T12:34:56.789Z');
        expect(loaded.lastVersion).toBe('2.0.0');
        // Confirm the revive path works:
        expect(new Date(loaded.lastCheckDate).getTime()).toBe(now.getTime());
    });

    test('load() returns null for corrupt JSON without throwing', async () => {
        backing['appSettings'] = '{not json';
        const loaded = await SettingsStore.load('app-settings');
        expect(loaded).toBeNull();
    });

    test('camel-cases the key: save("file-info", ...) writes to fileInfo', async () => {
        await SettingsStore.save('file-info', [{ id: 'x' }]);
        expect(backing['fileInfo']).toBeDefined();
        expect(JSON.parse(backing['fileInfo'])).toEqual([{ id: 'x' }]);
    });

    test('camel-cases the key: runtime-data -> runtimeData', async () => {
        await SettingsStore.save('runtime-data', { foo: 'bar' });
        expect(backing['runtimeData']).toBeDefined();
    });

    test('camel-cases the key: update-info -> updateInfo', async () => {
        await SettingsStore.save('update-info', { v: 1 });
        expect(backing['updateInfo']).toBeDefined();
    });

    test('single-word key unchanged: app-settings -> appSettings', async () => {
        await SettingsStore.save('app-settings', { k: 'v' });
        expect(backing['appSettings']).toBeDefined();
    });

    test('overwriting a key replaces prior value', async () => {
        await SettingsStore.save('app-settings', { theme: 'dark' });
        await SettingsStore.save('app-settings', { theme: 'light' });
        const loaded = await SettingsStore.load('app-settings');
        expect(loaded).toEqual({ theme: 'light' });
    });

    test('save returns a Promise that resolves (not undefined)', () => {
        const result = SettingsStore.save('app-settings', { k: 'v' });
        expect(result).toBeInstanceOf(Promise);
    });

    test('load returns a Promise that resolves (not undefined)', () => {
        const result = SettingsStore.load('app-settings');
        expect(result).toBeInstanceOf(Promise);
    });
});

describe('SettingsStore + FileInfoCollection round-trip (critical path)', () => {
    // The regression that motivated this test file: a user uploads a
    // .kdbx, the in-memory FileInfoCollection gets a model pushed into
    // it, `.save()` is a no-op, reload -> recent files list is empty.
    //
    // This test exercises the exact call path: push model -> save ->
    // instantiate fresh collection -> load -> verify models come back
    // with Date fields reconstituted.
    test('FileInfoCollection.save() then .load() restores models with Date fields', async () => {
        // Clear state.
        for (const k of Object.keys(backing)) {
            delete backing[k];
        }
        const { FileInfoCollection } = await import('../../../app/scripts/collections/file-info-collection');
        const { FileInfoModel } = await import('../../../app/scripts/models/file-info-model');

        // The singleton may already have items from other tests. Reset.
        FileInfoCollection.length = 0;

        const originalSyncDate = new Date('2026-04-01T10:00:00.000Z');
        const originalOpenDate = new Date('2026-04-08T09:30:00.000Z');

        const model = new FileInfoModel({
            id: 'abc-123',
            name: 'MyVault.kdbx',
            storage: 'file',
            path: '/Users/test/vault.kdbx',
            syncDate: originalSyncDate,
            openDate: originalOpenDate
        });
        FileInfoCollection.push(model);

        // Persist.
        FileInfoCollection.save();

        // Wait a microtask for the promise to settle (save is async).
        await Promise.resolve();
        await Promise.resolve();

        // Simulate a fresh app boot: clear the collection, then load.
        FileInfoCollection.length = 0;
        await FileInfoCollection.load();

        expect(FileInfoCollection.length).toBe(1);
        const restored = FileInfoCollection[0] as InstanceType<typeof FileInfoModel>;
        expect(restored.id).toBe('abc-123');
        expect(restored.name).toBe('MyVault.kdbx');
        expect(restored.storage).toBe('file');
        expect(restored.path).toBe('/Users/test/vault.kdbx');
        // Dates must round-trip as Date instances (FileInfoModel's
        // constructor revives `/Date$/` fields).
        expect(restored.syncDate).toBeInstanceOf(Date);
        expect(restored.openDate).toBeInstanceOf(Date);
        expect(restored.syncDate?.getTime()).toBe(originalSyncDate.getTime());
        expect(restored.openDate?.getTime()).toBe(originalOpenDate.getTime());
    });
});
