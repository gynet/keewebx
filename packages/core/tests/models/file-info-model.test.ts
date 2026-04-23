import { describe, test, expect, mock } from 'bun:test';

// Mock 'hbs' (handlebars) which is a webpack alias not available in test
mock.module('hbs', () => ({
    default: { escapeExpression: (s: string) => s }
}));

const { FileInfoModel } = await import('../../app/scripts/models/file-info-model');

describe('FileInfoModel', () => {
    test('creates with default properties', () => {
        const model = new FileInfoModel();
        expect(model.id).toBe('');
        expect(model.name).toBe('');
        expect(model.storage).toBeNull();
        expect(model.path).toBeNull();
        expect(model.modified).toBe(false);
        expect(model.rev).toBeNull();
        expect(model.keyFileName).toBeNull();
    });

    test('creates with provided properties', () => {
        const model = new FileInfoModel({
            id: 'test-123',
            name: 'MyDatabase.kdbx',
            storage: 'webdav',
            path: '/vault/db.kdbx'
        });
        expect(model.id).toBe('test-123');
        expect(model.name).toBe('MyDatabase.kdbx');
        expect(model.storage).toBe('webdav');
        expect(model.path).toBe('/vault/db.kdbx');
    });

    test('filters out unknown properties', () => {
        const model = new FileInfoModel({
            id: 'test-456',
            unknownField: 'should be dropped'
        } as never);
        expect(model.id).toBe('test-456');
        expect((model as Record<string, unknown>).unknownField).toBeUndefined();
    });

    test('converts date strings to Date objects', () => {
        const dateStr = '2025-06-15T10:30:00.000Z';
        const model = new FileInfoModel({
            id: 'test-789',
            syncDate: new Date(dateStr),
            openDate: new Date(dateStr)
        });
        expect(model.syncDate).toBeInstanceOf(Date);
        expect(model.openDate).toBeInstanceOf(Date);
    });

    test('handles null date values', () => {
        const model = new FileInfoModel({
            id: 'test-null',
            syncDate: null,
            openDate: null
        });
        expect(model.syncDate).toBeNull();
        expect(model.openDate).toBeNull();
    });

    describe('passkey quick unlock fields (#9)', () => {
        test('defaults all four passkey fields to null', () => {
            const model = new FileInfoModel();
            expect(model.passkeyCredentialId).toBeNull();
            expect(model.passkeyPrfSalt).toBeNull();
            expect(model.passkeyWrappedKey).toBeNull();
            expect(model.passkeyCreatedDate).toBeNull();
        });

        test('accepts passkey fields in constructor', () => {
            const createdDate = new Date('2026-04-11T12:00:00.000Z');
            const model = new FileInfoModel({
                id: 'file-with-passkey',
                name: 'Vault.kdbx',
                passkeyCredentialId: 'credAAAAAA',
                passkeyPrfSalt: 'saltAAAAAA',
                passkeyWrappedKey: 'wrappedAAAA',
                passkeyCreatedDate: createdDate
            });
            expect(model.passkeyCredentialId).toBe('credAAAAAA');
            expect(model.passkeyPrfSalt).toBe('saltAAAAAA');
            expect(model.passkeyWrappedKey).toBe('wrappedAAAA');
            expect(model.passkeyCreatedDate).toBeInstanceOf(Date);
            expect(model.passkeyCreatedDate?.toISOString()).toBe(
                '2026-04-11T12:00:00.000Z'
            );
        });

        test('round-trips passkey fields through JSON.stringify', () => {
            // This is the contract FileInfoCollection.save() relies on:
            // SettingsStore JSON-encodes the collection, and on load each
            // raw entry is re-hydrated via `new FileInfoModel(parsed)`.
            // If a new field is not JSON-serializable or the constructor's
            // `pick(raw, Object.keys(DefaultProperties))` whitelist drops
            // it, the field silently disappears across reloads.
            const original = new FileInfoModel({
                id: 'round-trip',
                name: 'RoundTrip.kdbx',
                passkeyCredentialId: 'Y3JlZC1pZA==',
                passkeyPrfSalt: 'c2FsdC1ieXRlcw==',
                passkeyWrappedKey: 'd3JhcHBlZC1ieXRlcw==',
                passkeyCreatedDate: new Date('2026-04-11T09:30:00.000Z')
            });

            // Simulate SettingsStore.save() → JSON → SettingsStore.load()
            const json = JSON.stringify(original);
            const parsed = JSON.parse(json) as Record<string, unknown>;
            const rehydrated = new FileInfoModel(parsed);

            expect(rehydrated.id).toBe('round-trip');
            expect(rehydrated.name).toBe('RoundTrip.kdbx');
            expect(rehydrated.passkeyCredentialId).toBe('Y3JlZC1pZA==');
            expect(rehydrated.passkeyPrfSalt).toBe('c2FsdC1ieXRlcw==');
            expect(rehydrated.passkeyWrappedKey).toBe('d3JhcHBlZC1ieXRlcw==');
            expect(rehydrated.passkeyCreatedDate).toBeInstanceOf(Date);
            expect(rehydrated.passkeyCreatedDate?.toISOString()).toBe(
                '2026-04-11T09:30:00.000Z'
            );
        });

        test('passkeyCreatedDate is hydrated from ISO string via /Date$/ rule', () => {
            // Mimics what JSON.parse on a serialized FileInfoCollection
            // produces: Date objects become ISO strings. The /Date$/ test
            // in the constructor MUST fire on passkeyCreatedDate or the
            // field round-trips as a plain string instead of a Date.
            const model = new FileInfoModel({
                id: 'from-json',
                passkeyCreatedDate: '2026-04-11T08:15:00.000Z' as unknown as Date
            });
            expect(model.passkeyCreatedDate).toBeInstanceOf(Date);
            expect(model.passkeyCreatedDate?.toISOString()).toBe(
                '2026-04-11T08:15:00.000Z'
            );
        });

        test('clearing passkey fields to null is respected (disable flow)', () => {
            // The "disable passkey" flow sets all four fields back to null
            // and saves. Make sure an explicit null in the constructor is
            // preserved (i.e. not replaced with a non-null default).
            const model = new FileInfoModel({
                id: 'disable',
                passkeyCredentialId: null,
                passkeyPrfSalt: null,
                passkeyWrappedKey: null,
                passkeyCreatedDate: null
            });
            expect(model.passkeyCredentialId).toBeNull();
            expect(model.passkeyPrfSalt).toBeNull();
            expect(model.passkeyWrappedKey).toBeNull();
            expect(model.passkeyCreatedDate).toBeNull();
        });
    });
});
