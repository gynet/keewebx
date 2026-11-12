import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { argon2d, argon2id } from 'hash-wasm';
import { ByteUtils, Consts, Credentials, CryptoEngine, Int64, Kdbx, KdbxUuid, ProtectedValue, VarDictionary } from 'kdbxweb';
import type { FileModel } from '../src/models/file-model';
import { exportVault } from '../src/comp/app/vault-files';
import { applyDatabaseSettings, readDatabaseSettings } from '../src/comp/app/database-settings';
import { changeCredential } from '../src/util/kdbxweb/credential-changes';

type Argon2 = Parameters<typeof CryptoEngine.setArgon2Impl>[0];
const hash: Argon2 = async (password, salt, memory, iterations, length, parallelism, type) => {
    const result = await (type === CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id)({
        password: new Uint8Array(password), salt: new Uint8Array(salt), memorySize: memory,
        iterations, parallelism, hashLength: length, outputType: 'binary'
    });
    return ByteUtils.arrayToBuffer(result);
};

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function password(text = 'master') { return ProtectedValue.fromString(text); }

async function database(credentials = new Credentials(password())) {
    await credentials.ready;
    const db = Kdbx.create(credentials, 'Export');
    db.header.kdfParameters!.set('M', VarDictionary.ValueType.UInt64, Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', VarDictionary.ValueType.UInt64, Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', 'Unsynced entry');
    entry.fields.set('Password', password('secret'));
    return db;
}

function fileModel(db: Kdbx) {
    // Deliberately no storage API: export must work even when offline caching is disabled.
    return {
        db, active: true, syncing: false, name: 'Export', dirty: true, modified: true, editSeq: 12,
        getData() { throw new Error('Export must not serialize the live database'); },
        setKdfParameter(field: string, value: number) {
            const key = { iterations: 'I', memory: 'M', parallelism: 'P' }[field]!;
            db.header.kdfParameters!.set(key, field === 'parallelism' ? VarDictionary.ValueType.UInt32 : VarDictionary.ValueType.UInt64,
                field === 'parallelism' ? value : Int64.from(value));
        }
    } as unknown as FileModel;
}

function state(db: Kdbx) {
    return {
        seed: db.header.masterSeed && ByteUtils.bytesToHex(db.header.masterSeed),
        iv: db.header.encryptionIV && ByteUtils.bytesToHex(db.header.encryptionIV),
        salt: ByteUtils.bytesToHex(db.header.kdfParameters!.get('S') as ArrayBuffer),
        stream: db.header.protectedStreamKey && ByteUtils.bytesToHex(db.header.protectedStreamKey),
        xml: db.xml
    };
}

beforeEach(() => CryptoEngine.setArgon2Impl(hash));
afterEach(() => CryptoEngine.setArgon2Impl(hash));

describe('encrypted vault export', () => {
    test('round-trips current data, history, attachments and metadata without touching live state or saved flags', async () => {
        const db = await database();
        const entry = db.getDefaultGroup().entries[0];
        entry.pushHistory();
        entry.fields.set('Notes', 'new unsynced note');
        entry.tags = ['private'];
        entry.binaries.set('attachment.bin', await db.createBinary(new Uint8Array([0, 1, 127, 255])));
        const icon = KdbxUuid.random().id;
        db.meta.customIcons.set(icon, { data: new Uint8Array([1, 2, 3]).buffer });
        entry.customIcon = new KdbxUuid(icon);
        db.meta.customData.set('custom', { value: 'metadata' });
        db.meta.historyMaxItems = 0; // Export must not prune live history as getData does.
        const file = fileModel(db);
        const before = state(db);
        const bytes = await exportVault(file);
        const loaded = await Kdbx.load(bytes, new Credentials(password()));
        const exported = loaded.getDefaultGroup().entries[0];
        expect(exported.fields.get('Notes')).toBe('new unsynced note');
        expect((exported.fields.get('Password') as ProtectedValue).getText()).toBe('secret');
        expect(exported.history).toHaveLength(1);
        expect(exported.tags).toEqual(['private']);
        expect(loaded.meta.customData.get('custom')?.value).toBe('metadata');
        expect(loaded.meta.customIcons.get(icon)?.data).toEqual(new Uint8Array([1, 2, 3]).buffer);
        expect((exported.binaries.get('attachment.bin') as { value: ArrayBuffer }).value).toEqual(new Uint8Array([0, 1, 127, 255]).buffer);
        expect(entry.history).toHaveLength(1);
        expect(state(db)).toEqual(before);
        expect([file.dirty, file.modified, file.editSeq, file.syncing]).toEqual([true, true, 12, false]);
    });

    test('two exports and a later live save own independent serializer state across KDF and content edits', async () => {
        const db = await database();
        const file = fileModel(db);
        const captured = deferred();
        const release = deferred();
        let calls = 0;
        CryptoEngine.setArgon2Impl(async (...args) => {
            if (++calls === 2) captured.resolve();
            if (calls <= 2) await release.promise;
            return hash(...args);
        });
        const first = exportVault(file);
        const second = exportVault(file);
        await captured.promise;
        const before = state(db);
        applyDatabaseSettings(file, { ...readDatabaseSettings(file), iterations: 3 });
        db.getDefaultGroup().entries[0].fields.set('Password', password('later'));
        const live = await db.save();
        const afterLive = state(db);
        release.resolve();
        const exports = await Promise.all([first, second]);
        expect(state(db)).toEqual(afterLive);
        expect(before.salt).not.toBe(afterLive.salt);
        CryptoEngine.setArgon2Impl(hash);
        for (const bytes of exports) {
            const loaded = await Kdbx.load(bytes, new Credentials(password()));
            expect(Number(loaded.header.kdfParameters!.get('I'))).toBe(2);
            expect((loaded.getDefaultGroup().entries[0].fields.get('Password') as ProtectedValue).getText()).toBe('secret');
        }
        const loadedLive = await Kdbx.load(live, new Credentials(password()));
        expect(Number(loadedLive.header.kdfParameters!.get('I'))).toBe(3);
        expect((loadedLive.getDefaultGroup().entries[0].fields.get('Password') as ProtectedValue).getText()).toBe('later');
    });

    test('exports safely while an existing live serializer is paused, without waiting for remote sync', async () => {
        const db = await database();
        const file = fileModel(db);
        const started = deferred();
        const release = deferred();
        let first = true;
        CryptoEngine.setArgon2Impl(async (...args) => {
            if (first) { first = false; started.resolve(); await release.promise; }
            return hash(...args);
        });
        file.syncing = true;
        const live = db.save();
        await started.promise;
        const exported = await exportVault(file);
        release.resolve();
        const saved = await live;
        expect(file.syncing).toBe(true);
        await Kdbx.load(exported, new Credentials(password()));
        await Kdbx.load(saved, new Credentials(password()));
    });

    test('waits for tracked password and key-file hashing and exports with the new credentials', async () => {
        const db = await database();
        const file = fileModel(db);
        const ready = deferred();
        const key = new Uint8Array(32).fill(42);
        changeCredential(db.credentials, 'password', (staged) => ready.promise.then(() => staged.setPassword(password('new-master'))));
        changeCredential(db.credentials, 'keyFile', (staged) => ready.promise.then(() => staged.setKeyFile(key.slice())));
        let finished = false;
        const exporting = exportVault(file).then((data) => { finished = true; return data; });
        await Promise.resolve();
        expect(finished).toBe(false);
        ready.resolve();
        const data = await exporting;
        await Kdbx.load(data, new Credentials(password('new-master'), key.slice()));
        await expect(Kdbx.load(data, new Credentials(password()))).rejects.toThrow();
    });

    test('does not capture a password change scheduled between the readiness continuation and snapshot', async () => {
        const db = await database();
        const file = fileModel(db);
        const ready = deferred();
        const exporting = exportVault(file);
        queueMicrotask(() => {
            changeCredential(db.credentials, 'password', (staged) => ready.promise.then(() => staged.setPassword(password('new-master'))));
            ready.resolve();
        });
        const data = await exporting;
        await Kdbx.load(data, new Credentials(password('new-master')));
    });

    test('preserves key-file and challenge-response credentials', async () => {
        const key = new Uint8Array(32).fill(7);
        const challenge = async (salt: ArrayBuffer) => CryptoEngine.sha256(salt);
        const db = await database(new Credentials(password(), key.slice(), challenge));
        const data = await exportVault(fileModel(db));
        await Kdbx.load(data, new Credentials(password(), key.slice(), challenge));
        await expect(Kdbx.load(data, new Credentials(password(), key.slice()))).rejects.toThrow();
    });

    test('rejects closed vaults and closing during encryption; the next export can still succeed', async () => {
        const db = await database();
        const file = fileModel(db);
        file.active = false;
        await expect(exportVault(file)).rejects.toThrow('closed vault');
        file.active = true;
        const started = deferred();
        const release = deferred();
        CryptoEngine.setArgon2Impl(async (...args) => { started.resolve(); await release.promise; return hash(...args); });
        const exporting = exportVault(file);
        await started.promise;
        file.active = false;
        release.resolve();
        await expect(exporting).rejects.toThrow('changed or closed');
        file.active = true;
        CryptoEngine.setArgon2Impl(hash);
        await Kdbx.load(await exportVault(file), new Credentials(password()));
    });

    test('rejects serializer failure without modifying live salts or poisoning retries', async () => {
        const db = await database();
        const file = fileModel(db);
        const before = state(db);
        CryptoEngine.setArgon2Impl(async () => { throw new Error('KDF failed'); });
        await expect(exportVault(file)).rejects.toThrow('KDF failed');
        expect(state(db)).toEqual(before);
        CryptoEngine.setArgon2Impl(hash);
        await Kdbx.load(await exportVault(file), new Credentials(password()));
    });

    test('a failed credential change rejects export until that credential part is retried', async () => {
        const db = await database();
        changeCredential(db.credentials, 'password', async () => { throw new Error('password hashing failed'); });
        await expect(exportVault(fileModel(db))).rejects.toThrow('password hashing failed');
        changeCredential(db.credentials, 'password', (staged) => staged.setPassword(password('retry')));
        await Kdbx.load(await exportVault(fileModel(db)), new Credentials(password('retry')));
    });

    test('rejects a database replaced during encryption rather than returning the previous vault', async () => {
        const db = await database();
        const next = await database();
        const file = fileModel(db);
        const started = deferred();
        const release = deferred();
        CryptoEngine.setArgon2Impl(async (...args) => { started.resolve(); await release.promise; return hash(...args); });
        const exporting = exportVault(file);
        await started.promise;
        file.db = next;
        release.resolve();
        await expect(exporting).rejects.toThrow('changed or closed');
    });

    test('preserves an existing AES KDF', async () => {
        const db = await database();
        db.header.kdfParameters = new VarDictionary();
        db.header.kdfParameters.set('$UUID', VarDictionary.ValueType.Bytes, ByteUtils.arrayToBuffer(ByteUtils.base64ToBytes(Consts.KdfId.Aes)));
        db.header.kdfParameters.set('S', VarDictionary.ValueType.Bytes, ByteUtils.arrayToBuffer(CryptoEngine.random(32)));
        db.header.kdfParameters!.set('R', VarDictionary.ValueType.UInt64, Int64.from(10));
        const loaded = await Kdbx.load(await exportVault(fileModel(db)), new Credentials(password()));
        expect(ByteUtils.bytesToBase64(loaded.header.kdfParameters!.get('$UUID') as ArrayBuffer)).toBe(Consts.KdfId.Aes);
    });
});
