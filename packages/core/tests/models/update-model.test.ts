import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
    installMockedModule,
    restoreAllMockedModules
} from '../helpers/mock-isolation';

// Mock SettingsStore before importing the model, via the isolation
// helper so the mock is torn down at afterAll and does not leak into
// other test files (e.g. tests/comp/settings/settings-store.test.ts
// needs the real module). See tests/helpers/mock-isolation.ts.
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

// Import after mocking
const { UpdateModel } = await import('../../app/scripts/models/update-model');

describe('UpdateModel', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockStore)) {
            delete mockStore[key];
        }
    });

    test('has correct default property values', () => {
        expect(UpdateModel.lastSuccessCheckDate).toBeNull();
        expect(UpdateModel.lastCheckDate).toBeNull();
        expect(UpdateModel.lastVersion).toBeNull();
        expect(UpdateModel.lastCheckError).toBeNull();
        expect(UpdateModel.updateManual).toBe(false);
        expect(UpdateModel.status).toBeNull();
        expect(UpdateModel.updateStatus).toBeNull();
    });

    test('load() resolves with no stored data', async () => {
        await expect(UpdateModel.load()).resolves.toBeUndefined();
    });

    test('load() restores date fields as Date objects', async () => {
        const dateStr = '2025-01-15T12:00:00.000Z';
        mockStore['update-info'] = {
            lastCheckDate: dateStr,
            lastVersion: '2.0.0'
        };
        await UpdateModel.load();
        expect(UpdateModel.lastCheckDate).toBeInstanceOf(Date);
        expect(UpdateModel.lastVersion).toBe('2.0.0');
    });

    test('save() excludes properties starting with "update"', () => {
        UpdateModel.set(
            {
                lastVersion: '1.5.0',
                updateStatus: 'ready',
                updateError: 'some error'
            },
            { silent: true }
        );
        UpdateModel.save();
        const saved = mockStore['update-info'] as Record<string, unknown>;
        expect(saved).toBeDefined();
        expect(saved.lastVersion).toBe('1.5.0');
        expect(saved.updateStatus).toBeUndefined();
        expect(saved.updateError).toBeUndefined();
    });
});
