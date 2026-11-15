import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { backend } from '../src/background/backend';
import { model } from '../src/options/settings-model';
import { HOSTED_APP_URL } from '../src/common/app-location';

const Backend = backend.constructor as new () => typeof backend;
const Settings = model.constructor as new () => typeof model;
let stored: { keeWebUrl?: string };
let writes: unknown[];
let changed: (changes: Record<string, chrome.storage.StorageChange>) => void;
let originalChrome: PropertyDescriptor | undefined;
let originalEmbedded: PropertyDescriptor | undefined;

beforeEach(() => {
    originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    originalEmbedded = Object.getOwnPropertyDescriptor(globalThis, '__KW_EMBEDDED_VAULT__');
    stored = {}; writes = []; changed = () => {};
    Object.defineProperty(globalThis, '__KW_EMBEDDED_VAULT__', { configurable: true, writable: true, value: false });
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
        runtime: {
            getURL: (path: string) => `chrome-extension://test/${path}`,
            connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} } })
        },
        commands: { getAll: (callback: (commands: unknown[]) => void) => callback([]) },
        permissions: { contains: (_request: unknown, callback: (allowed: boolean) => void) => callback(true) },
        storage: {
            onChanged: { addListener: (listener: typeof changed) => { changed = listener; } },
            local: {
                get: (_keys: unknown, callback: (data: typeof stored) => void) => callback({ ...stored }),
                set: (data: typeof stored) => { writes.push(data); stored = { ...data }; }
            }
        }
    } });
});
afterEach(() => {
    for (const [key, previous] of [['chrome', originalChrome], ['__KW_EMBEDDED_VAULT__', originalEmbedded]] as const) {
        if (previous) Object.defineProperty(globalThis, key, previous);
        else Reflect.deleteProperty(globalThis, key);
    }
});
async function clients() {
    const client = new Backend(), settings = new Settings();
    await settings.init(); await client.init();
    return { client, settings };
}

describe('actual backend and settings app location', () => {
    test('fresh Connect uses the hosted app route without creating a custom setting', async () => {
        const { client, settings } = await clients();
        expect(client.keeWebUrl).toBe('https://keewebx.app/app');
        expect(settings.defaultKeeWebUrl).toBe(HOSTED_APP_URL);
        expect(settings.keeWebUrl).toBe(client.keeWebUrl);
        expect(settings.keeWebUrlIsSet).toBe(false);
        expect(writes).toEqual([]);
    });
    test('fresh Full keeps its embedded runtime URL and unset storage', async () => {
        Object.assign(globalThis, { __KW_EMBEDDED_VAULT__: true });
        const { client, settings } = await clients();
        expect(client.keeWebUrl).toBe('chrome-extension://test/app/index.html');
        expect(settings.keeWebUrl).toBe(client.keeWebUrl);
        expect(settings.keeWebUrlIsSet).toBe(false);
        expect(writes).toEqual([]);
    });
    test('the exact former stored default migrates durably and incoming old values are also repaired', async () => {
        stored.keeWebUrl = 'https://keewebx.app/';
        const { client, settings } = await clients();
        expect(client.keeWebUrl).toBe(HOSTED_APP_URL);
        expect(settings.keeWebUrl).toBe(HOSTED_APP_URL);
        expect(stored.keeWebUrl).toBe(HOSTED_APP_URL);
        expect(writes).toEqual([{ keeWebUrl: HOSTED_APP_URL }]);
        changed({ keeWebUrl: { newValue: 'https://keewebx.app/classic.html?ui=classic' } });
        expect(client.keeWebUrl).toBe('https://keewebx.app/classic.html?ui=classic');
        changed({ keeWebUrl: { newValue: 'https://keewebx.app/' } });
        expect(client.keeWebUrl).toBe(HOSTED_APP_URL);
        expect(stored.keeWebUrl).toBe(HOSTED_APP_URL);
    });
    for (const url of [
        'https://keewebx.app', 'https://keewebx.app/?ui=classic', 'https://keewebx.app/?tenant=private',
        'https://keewebx.app/#custom', 'https://keewebx.app/classic.html',
        'https://keewebx.app/next.html?ui=classic', 'https://keewebx.app/app?tenant=private',
        'https://keewebx.app/team/index.html', 'https://vault.example/', 'http://localhost:8123/vault/'
    ]) test(`preserves explicit target ${url}`, async () => {
        stored.keeWebUrl = url;
        const { client, settings } = await clients();
        expect(client.keeWebUrl).toBe(url);
        expect(settings.keeWebUrl).toBe(url);
        expect(writes).toEqual([]);
    });
});
