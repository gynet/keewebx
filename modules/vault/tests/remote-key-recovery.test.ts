import { beforeEach, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import { ByteUtils, Credentials, CryptoEngine, Int64, Kdbx, ProtectedValue, VarDictionary } from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';
import '../src/util/kdbxweb/protected-value-ex';
import { credentialChangeVersion, waitForCredentialChanges } from '../src/util/kdbxweb/credential-changes';

// Real credentials, encrypted bytes, FileModel setters and merge. Only UI/metadata
// dependencies are stubbed. Run this file in its own Bun process (module mocks).
mock.module('demo.kdbx', () => ({ default: '' }));
mock.module('framework/events', () => ({ Events: new EventEmitter() }));
mock.module('collections/group-collection', () => ({ GroupCollection: class extends Array {} }));
mock.module('models/group-model', () => ({ GroupModel: class {} }));
mock.module('models/entry-model', () => ({ EntryModel: class {} }));
mock.module('models/app-settings-model', () => ({ AppSettingsModel: {} }));
mock.module('collections/file-info-collection', () => ({ FileInfoCollection: { get() {}, save() {} } }));
mock.module('util/formatting/icon-url-format', () => ({ IconUrlFormat: {} }));
mock.module('util/locale', () => ({ Locale: {} }));
mock.module('util/logger', () => ({ Logger: class { info() {} error() {} warn() {} debug() {} } }));
const { FileModel } = await import('../src/models/file-model');
const original = 'original password', remote = 'verified remote password', local = 'intentional local password';
const protectedPassword = (value: string) => ProtectedValue.fromString(value);
const baselineTime = Date.UTC(2026, 10, 13, 1);
beforeEach(() => {
    CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) =>
        ByteUtils.arrayToBuffer(await (type === CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id)({
            password: new Uint8Array(password), salt: new Uint8Array(salt), memorySize: memory,
            iterations, parallelism, hashLength: length, outputType: 'binary'
        })));
});

for (const clock of ['older', 'equal', 'newer'] as const) {
    for (const localChange of ['none', 'password', 'key file'] as const) {
        test(`${clock} remote clock with ${localChange} local credential change preserves the intended factors and both edits`, async () => {
            const db = Kdbx.create(new Credentials(protectedPassword(original)), 'Credential arbitration');
            await db.credentials.ready;
            db.header.kdfParameters!.set('M', VarDictionary.ValueType.UInt64, Int64.from(32 * 1024));
            db.header.kdfParameters!.set('I', VarDictionary.ValueType.UInt64, Int64.from(2));
            db.meta.keyChanged = new Date(baselineTime);
            const entry = db.createEntry(db.getDefaultGroup()); entry.fields.set('Title', 'Original');
            const remoteDb = await Kdbx.load(await db.save(), new Credentials(protectedPassword(original)));
            await remoteDb.credentials.setPassword(protectedPassword(remote));
            remoteDb.meta.keyChanged = new Date(baselineTime + (clock === 'older' ? -60_000 : clock === 'newer' ? 60_000 : 0));
            remoteDb.createEntry(remoteDb.getDefaultGroup()).fields.set('Title', 'Remote entry');
            const remoteBytes = await remoteDb.save();
            const file = new FileModel({ id: 'merge', active: true, name: 'Credential arbitration' });
            file.db = db; Object.defineProperty(file, 'reload', { value: mock(() => {}) });
            file.oldPasswordHash = db.credentials.passwordHash;
            file.oldKeyFileHash = db.credentials.keyFileHash;
            const localKey = new Uint8Array(32).fill(29);
            if (localChange === 'password') file.setPassword(protectedPassword(local));
            else if (localChange === 'key file') file.setKeyFile(localKey, 'local.key');
            await waitForCredentialChanges(db.credentials);
            db.meta.keyChanged = new Date(baselineTime);
            entry.fields.set('Notes', 'Local entry edit'); entry.times.lastModTime = new Date(); file.setModified();
            await new Promise<void>((resolve, reject) => file.mergeOrUpdate(remoteBytes,
                { password: protectedPassword(remote) }, error => error ? reject(error) : resolve()));
            const adoptRemote = localChange === 'none' || clock === 'newer';
            const password = adoptRemote ? remote : localChange === 'password' ? local : original;
            const key = !adoptRemote && localChange === 'key file' ? localKey : undefined;
            const bytes = await file.db.save();
            const reopened = await Kdbx.load(bytes, new Credentials(protectedPassword(password), key));
            expect(reopened.getDefaultGroup().entries.find(item => item.uuid.equals(entry.uuid))!.fields.get('Notes')).toBe('Local entry edit');
            expect(reopened.getDefaultGroup().entries.filter(item => item.fields.get('Title') === 'Remote entry')).toHaveLength(1);
            expect(file.reload).toHaveBeenCalledTimes(1);
            // The losing password must not decrypt the merged output, not just differ in memory.
            await expect(Kdbx.load(bytes, new Credentials(protectedPassword(adoptRemote ? original : remote)))).rejects.toThrow();
        });
    }
}

for (const modified of [false, true]) {
    for (const action of ['keep', 'replace', 'remove'] as const) {
        test(`${modified ? 'dirty merge' : 'clean update'} adopts remote password and ${action} key metadata`, async () => {
            const oldKey = new Uint8Array(32).fill(7), newKey = new Uint8Array(32).fill(9);
            const db = Kdbx.create(new Credentials(protectedPassword(original), oldKey.slice()), 'Key transition');
            await db.credentials.ready;
            db.header.kdfParameters!.set('M', VarDictionary.ValueType.UInt64, Int64.from(32 * 1024));
            db.header.kdfParameters!.set('I', VarDictionary.ValueType.UInt64, Int64.from(2));
            const remoteDb = await Kdbx.load(await db.save(), new Credentials(protectedPassword(original), oldKey.slice()));
            await remoteDb.credentials.setPassword(protectedPassword(remote));
            const key = action === 'keep' ? oldKey : action === 'replace' ? newKey : undefined;
            await remoteDb.credentials.setKeyFile(key?.slice());
            const file = new FileModel({ id: 'transition', active: true, keyFileName: 'old.key', passwordLength: original.length });
            file.db = db;
            Object.defineProperty(file, 'reload', { value: mock(() => {}) });
            if (modified) file.setModified();
            const keyFileName = action === 'keep' ? 'old.key' : action === 'replace' ? 'new.key' : undefined;
            const remoteBytes = await remoteDb.save();
            const keyFileData = action === 'replace' ? newKey.slice().buffer : undefined;
            await new Promise<void>((resolve, reject) => file.mergeOrUpdate(remoteBytes,
                { password: protectedPassword(remote), keyFileName, keyFileData },
                error => error ? reject(error) : resolve()));
            if (keyFileData) ByteUtils.zeroBuffer(keyFileData);
            expect(file.keyFileName).toBe(keyFileName || '');
            expect(file.passwordLength).toBe(remote.length);
            await expect(Kdbx.load(await file.db.save(), new Credentials(protectedPassword(remote), key?.slice()))).resolves.toBeDefined();
        });
    }
}

for (const change of ['database', 'credentials', 'version'] as const) {
    test(`caller snapshot rejects ${change} replacement while the remote GET was pending`, async () => {
        const db = Kdbx.create(new Credentials(protectedPassword(original)), 'Original');
        await db.credentials.ready;
        const file = new FileModel({ id: 'stale', active: true }); file.db = db;
        Object.defineProperty(file, 'reload', { value: mock(() => {}) });
        const credentials = db.credentials;
        const version = credentialChangeVersion(credentials);
        const canMerge = () => file.db === db && file.db.credentials === credentials && credentialChangeVersion(credentials) === version;
        if (change === 'database') file.db = Kdbx.create(new Credentials(protectedPassword(local)), 'Replacement');
        else if (change === 'credentials') file.db.credentials = new Credentials(protectedPassword(local));
        else file.setPassword(protectedPassword(local));
        const currentDb = file.db, currentCredentials = file.db.credentials;
        await expect(new Promise<void>((resolve, reject) => file.mergeOrUpdate(new ArrayBuffer(0),
            { password: protectedPassword(remote), canMerge }, error => error ? reject(error) : resolve()))).rejects.toThrow('database changed');
        expect(file.db).toBe(currentDb); expect(file.db.credentials).toBe(currentCredentials);
        expect(file.reload).not.toHaveBeenCalled();
    });
}
