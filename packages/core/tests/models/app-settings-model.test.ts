import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
    installMockedModule,
    restoreAllMockedModules
} from '../helpers/mock-isolation';

// Mock SettingsStore before importing the model, via the isolation
// helper so the mock is torn down at afterAll and does not leak into
// other test files. See tests/helpers/mock-isolation.ts for rationale.
// Without this, `tests/comp/settings/settings-store.test.ts` loads the
// mocked version below instead of the real module it's trying to test.
const mockStore: Record<string, unknown> = {};
await installMockedModule('../../app/scripts/comp/settings/settings-store', () => ({
    SettingsStore: {
        load: (key: string) => Promise.resolve(mockStore[key] ?? null),
        save: (key: string, data: unknown) => {
            mockStore[key] = data;
            return Promise.resolve();
        }
    }
}));
afterAll(restoreAllMockedModules);

const { AppSettingsModel } = await import('../../app/scripts/models/app-settings-model');

describe('AppSettingsModel', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockStore)) {
            delete mockStore[key];
        }
    });

    test('has correct default values', () => {
        expect(AppSettingsModel.theme).toBeNull();
        expect(AppSettingsModel.autoSave).toBe(true);
        expect(AppSettingsModel.idleMinutes).toBe(15);
        expect(AppSettingsModel.expandGroups).toBe(true);
        expect(AppSettingsModel.useMarkdown).toBe(true);
        expect(AppSettingsModel.canOpen).toBe(true);
        expect(AppSettingsModel.canCreate).toBe(true);
        expect(AppSettingsModel.tableView).toBe(false);
        expect(AppSettingsModel.demoOpened).toBe(false);
    });

    test('load() resolves with no stored data', async () => {
        await expect(AppSettingsModel.load()).resolves.toBeUndefined();
    });

    test('load() restores saved settings', async () => {
        mockStore['app-settings'] = {
            theme: 'dark',
            idleMinutes: 30,
            demoOpened: true
        };
        await AppSettingsModel.load();
        expect(AppSettingsModel.theme).toBe('dark');
        expect(AppSettingsModel.idleMinutes).toBe(30);
        expect(AppSettingsModel.demoOpened).toBe(true);
    });

    test('upgrade() converts legacy locale', () => {
        const data: Record<string, unknown> = { locale: 'en' };
        AppSettingsModel.upgrade(data);
        expect(data.locale).toBe('en-US');
    });

    test('upgrade() converts legacy theme "macdark" to "dark"', () => {
        const data: Record<string, unknown> = { theme: 'macdark' };
        AppSettingsModel.upgrade(data);
        expect(data.theme).toBe('dark');
    });

    test('upgrade() converts legacy theme "wh" to "light"', () => {
        const data: Record<string, unknown> = { theme: 'wh' };
        AppSettingsModel.upgrade(data);
        expect(data.theme).toBe('light');
    });

    test('upgrade() converts boolean rememberKeyFiles to "data"', () => {
        const data: Record<string, unknown> = { rememberKeyFiles: true };
        AppSettingsModel.upgrade(data);
        expect(data.rememberKeyFiles).toBe('data');
    });

    test('save() only persists non-default values', () => {
        // Reset to defaults first
        AppSettingsModel.set(
            { theme: null, idleMinutes: 15, demoOpened: false },
            { silent: true }
        );
        AppSettingsModel.save();
        const saved = mockStore['app-settings'] as Record<string, unknown>;
        // Default values should NOT be in saved data
        expect(saved.theme).toBeUndefined();
        expect(saved.idleMinutes).toBeUndefined();
        expect(saved.autoSave).toBeUndefined();
    });

    test('save() includes changed values', () => {
        AppSettingsModel.set({ theme: 'dark', idleMinutes: 60 }, { silent: true });
        AppSettingsModel.save();
        const saved = mockStore['app-settings'] as Record<string, unknown>;
        expect(saved.theme).toBe('dark');
        expect(saved.idleMinutes).toBe(60);
    });
});
