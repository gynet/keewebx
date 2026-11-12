import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { argon2d, argon2id } from 'hash-wasm';
import { ByteUtils, Credentials, CryptoEngine, Int64, Kdbx, ProtectedValue, VarDictionary } from 'kdbxweb';
import { applyDatabaseCredentials, captureDatabaseCredentials, type DatabaseCredentialDraft } from '../src/comp/app/database-credentials';
import { exportVault } from '../src/comp/app/vault-files';
import { waitForCredentialChanges } from '../src/util/kdbxweb/credential-changes';
import { getSessionAccess } from '../src/comp/app/session-access';
import { runCredentialOperation } from '../../ui/src/credential-operations';
import { waitForPendingOperations } from '../../ui/src/pending-operations';
import type { AppModel } from '../src/models/app-model';

// Keep the real shared FileModel setters, model state, credentials and serializer.
// Only unrelated browser/collection imports are stubbed for this headless unit test.
mock.module('demo.kdbx', () => ({ default: '' }));
mock.module('../src/collections/group-collection', () => ({ GroupCollection: class extends Array {} }));
mock.module('../src/models/group-model', () => ({ GroupModel: class {} }));
mock.module('../src/models/app-settings-model', () => ({ AppSettingsModel: {} }));
mock.module('../src/models/entry-model', () => ({ EntryModel: class {} }));
mock.module('../src/util/formatting/icon-url-format', () => ({ IconUrlFormat: {} }));
mock.module('../src/util/locale', () => ({ Locale: {} }));
mock.module('../src/collections/file-info-collection', () => ({ FileInfoCollection: { get: () => undefined } }));
const { FileModel } = await import('../src/models/file-model');

// Direct model tests explicitly opt into an open policy; session cases supply their captured guard.
function applyInTest(
    file: InstanceType<typeof FileModel>, baseline: ReturnType<typeof captureDatabaseCredentials>,
    draft: DatabaseCredentialDraft, canApply: () => boolean = () => true
) {
    return applyDatabaseCredentials(file, baseline, draft, canApply);
}


type Argon2 = Parameters<typeof CryptoEngine.setArgon2Impl>[0];
const hash: Argon2 = async (password, salt, memory, iterations, length, parallelism, type) => {
    const bytes = await (type === CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id)({
        password: new Uint8Array(password), salt: new Uint8Array(salt), memorySize: memory,
        iterations, parallelism, hashLength: length, outputType: 'binary'
    });
    return ByteUtils.arrayToBuffer(bytes);
};
const realSha256 = CryptoEngine.sha256;
const pw = (text: string) => ProtectedValue.fromString(text);
const key = (text: string) => new TextEncoder().encode(text); // Non-XML key files use async SHA-256.

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

/** Hold the actual setter's digest result after computation, before it can publish. */
function holdHashes(...texts: string[]) {
    const gates = texts.map((text) => ({ text, started: deferred(), release: deferred() }));
    const spy = mock((data: ArrayBuffer) => {
        const text = new TextDecoder().decode(data);
        const gate = gates.find((candidate) => candidate.text === text);
        if (!gate) return realSha256(data);
        return realSha256(data).then((digest) => {
            gate.started.resolve();
            return gate.release.promise.then(() => digest);
        });
    });
    CryptoEngine.sha256 = spy;
    return gates;
}

async function model(withKey = false) {
    const credentials = new Credentials(pw('original'), withKey ? key('original-key') : undefined);
    await credentials.ready;
    const db = Kdbx.create(credentials, 'Credentials');
    db.header.kdfParameters!.set('M', VarDictionary.ValueType.UInt64, Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', VarDictionary.ValueType.UInt64, Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', 'Preserved');
    const file = new FileModel({ id: 'credential-test' });
    file.db = db;
    file.name = 'Credentials';
    file.active = true;
    file.groups = [] as unknown as typeof file.groups;
    file.oldPasswordHash = credentials.passwordHash;
    file.oldKeyFileHash = credentials.keyFileHash;
    file.oldPasswordLength = 'original'.length;
    file.oldKeyFileName = withKey ? 'original.key' : '';
    file.oldKeyChangeDate = db.meta.keyChanged;
    return file;
}

async function reopen(data: ArrayBuffer, password: string, keyText?: string) {
    return Kdbx.load(data, new Credentials(pw(password), keyText ? key(keyText) : undefined));
}

function classicSave(file: InstanceType<typeof FileModel>): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => file.getData((data, error) => data ? resolve(data) : reject(error)));
}

function syncSave(file: InstanceType<typeof FileModel>): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => file.getDataForSync((data, error) => data ? resolve(data) : reject(error)));
}

beforeEach(() => CryptoEngine.setArgon2Impl(hash));
afterEach(() => { CryptoEngine.sha256 = realSha256; CryptoEngine.setArgon2Impl(hash); });

function appWith(file: InstanceType<typeof FileModel>): AppModel {
    const files = Object.assign([file], { get: (id: string) => files.find((candidate) => candidate.id === id) });
    return { files } as unknown as AppModel;
}

describe('New credential session admission', () => {
    test('registers before the first callback and denies fresh work once securing begins', async () => {
        const file = await model();
        const app = appWith(file);
        const access = getSessionAccess(app);
        const release = deferred();
        let drained = false;
        let draining!: Promise<void>;
        let guard!: () => boolean;
        const operation = runCredentialOperation(app, file, () => true, async (canPublish) => {
            guard = canPublish;
            expect(guard()).toBe(true);
            draining = waitForPendingOperations(app, new AbortController().signal).then(() => { drained = true; });
            await release.promise;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(drained).toBe(false);
        access.beginSecuring();
        expect(guard()).toBe(false);
        const callback = mock(async () => {});
        await expect(runCredentialOperation(app, file, () => true, callback)).rejects.toThrow();
        expect(callback).not.toHaveBeenCalled();
        release.resolve(); await operation;
        await draining;
        expect(drained).toBe(true);
    });
    test('late preparation cannot publish after securing, recovery and successful reauthentication', async () => {
        const file = await model();
        const app = appWith(file);
        const access = getSessionAccess(app);
        const baseline = captureDatabaseCredentials(file);
        const [gate] = holdHashes('late-password');
        const applying = runCredentialOperation(app, file, () => true, (canPublish) =>
            applyInTest(file, baseline, passwordDraft('late-password'), canPublish));
        void applying.catch(() => {});
        await gate.started.promise;
        const epoch = access.requireRecovery(access.beginSecuring());
        await access.prepareRecovery(epoch);
        await access.verifyVault(epoch, file.id, { password: 'original' });
        access.resumeRecovery(epoch);
        gate.release.resolve();
        await expect(applying).rejects.toThrow('no longer available');
        expect(captureDatabaseCredentials(file)).toEqual(baseline);
        await waitForPendingOperations(app, new AbortController().signal);
        await reopen(await exportVault(file), 'original');
    });
    test('unmount and removal cancel an admitted operation without publishing', async () => {
        const file = await model();
        const app = appWith(file);
        const baseline = captureDatabaseCredentials(file);
        const [gate] = holdHashes('unmounted-password');
        let mounted = true;
        const applying = runCredentialOperation(app, file, () => mounted, (canPublish) =>
            applyInTest(file, baseline, passwordDraft('unmounted-password'), canPublish));
        void applying.catch(() => {});
        await gate.started.promise;
        mounted = false;
        app.files.splice(0, 1);
        gate.release.resolve();
        await expect(applying).rejects.toThrow();
        expect(captureDatabaseCredentials(file)).toEqual(baseline);
        await waitForPendingOperations(app, new AbortController().signal);
    });
});

const keep = { action: 'keep' } as const;
const passwordDraft = (value = 'new-password', confirmation = value): DatabaseCredentialDraft => ({
    password: { action: 'set', value, confirmation }, keyFile: keep
});

describe('explicit database credential apply', () => {
    test('each factor hashes once, detached published hashes survive staging cleanup, export/reset/retry', async () => {
        const file = await model(true);
        const hashes: ProtectedValue[] = [];
        const originalFromBinary = ProtectedValue.fromBinary;
        const fromBinary = spyOn(ProtectedValue, 'fromBinary').mockImplementation((buffer) => {
            const value = originalFromBinary(buffer); hashes.push(value); return value;
        });
        const counts = new Map<string, number>();
        CryptoEngine.sha256 = (data) => {
            const text = new TextDecoder().decode(data);
            if (text === 'new-password' || text === 'new-key') {
                const count = (counts.get(text) ?? 0) + 1;
                counts.set(text, count);
                if (count > 1) return Promise.reject(new Error('Second hashing invocation must not occur'));
            }
            return realSha256(data);
        };
        const draft: DatabaseCredentialDraft = {
            ...passwordDraft(), keyFile: { action: 'set', name: 'new.key', data: key('new-key').buffer as ArrayBuffer }
        };
        try {
            await applyInTest(file, captureDatabaseCredentials(file), draft);
            expect(counts.get('new-password')).toBe(1);
            expect(counts.get('new-key')).toBe(1);
            expect(hashes).toHaveLength(2);
            for (const hash of hashes) {
                expect([...hash.value, ...hash.salt].every((byte) => byte === 0)).toBe(true);
                expect(file.db.credentials.passwordHash).not.toBe(hash);
                expect(file.db.credentials.keyFileHash).not.toBe(hash);
            }
        } finally { fromBinary.mockRestore(); CryptoEngine.sha256 = realSha256; }
        await reopen(await exportVault(file), 'new-password', 'new-key');
        await applyInTest(file, captureDatabaseCredentials(file), { password: { action: 'reset' }, keyFile: { action: 'reset' } });
        await reopen(await exportVault(file), 'original', 'original-key');
        await applyInTest(file, captureDatabaseCredentials(file), draft);
        await reopen(await classicSave(file), 'new-password', 'new-key');
    });
    for (const failure of ['password', 'key file']) {
        test(`${failure} preparation failure drains the sibling, scrubs owned buffers and publishes nothing`, async () => {
            const file = await model(true);
            const baseline = captureDatabaseCredentials(file);
            const state = { modified: file.modified, dirty: file.dirty, editSeq: file.editSeq, date: file.db.meta.keyChanged };
            const gates = holdHashes('new-password', 'new-key');
            const digest = CryptoEngine.sha256;
            const buffers: Uint8Array[] = [];
            const stagedHashes: ProtectedValue[] = [];
            const originalFromBinary = ProtectedValue.fromBinary;
            const fromBinary = spyOn(ProtectedValue, 'fromBinary').mockImplementation((buffer) => {
                const value = originalFromBinary(buffer); stagedHashes.push(value); return value;
            });
            CryptoEngine.sha256 = (data) => { buffers.push(new Uint8Array(data)); return digest(data); };
            const draft: DatabaseCredentialDraft = {
                ...passwordDraft(), keyFile: { action: 'set', name: 'new.key', data: key('new-key').buffer as ArrayBuffer }
            };
            let settled = false;
            const applying = applyInTest(file, baseline, draft);
            void applying.then(() => { settled = true; }, () => { settled = true; });
            try {
                await Promise.all(gates.map((gate) => gate.started.promise));
                const failed = failure === 'password' ? 0 : 1;
                gates[failed].release.reject(new Error('Digest failed'));
                await new Promise((resolve) => setTimeout(resolve, 0));
                expect(settled).toBe(false);
                expect(captureDatabaseCredentials(file)).toEqual(baseline);
                gates[1 - failed].release.resolve();
                await expect(applying).rejects.toThrow('No credential changes were applied');
                expect(captureDatabaseCredentials(file)).toEqual(baseline);
                expect({ modified: file.modified, dirty: file.dirty, editSeq: file.editSeq, date: file.db.meta.keyChanged }).toEqual(state);
                expect(buffers).toHaveLength(2);
                expect(buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
                expect(stagedHashes).toHaveLength(1);
                expect(stagedHashes.every((hash) => [...hash.value, ...hash.salt].every((byte) => byte === 0))).toBe(true);
                expect(new TextDecoder().decode((draft.keyFile as { data: ArrayBuffer }).data)).toBe('new-key');
            } finally {
                gates.forEach((gate) => gate.release.resolve());
                fromBinary.mockRestore(); CryptoEngine.sha256 = realSha256;
            }
            await reopen(await exportVault(file), 'original', 'original-key');
            await applyInTest(file, captureDatabaseCredentials(file), draft);
            await reopen(await exportVault(file), 'new-password', 'new-key');
        });
    }
    test('cancellation at the final synchronous commit boundary changes neither factor nor metadata', async () => {
        const file = await model();
        const baseline = captureDatabaseCredentials(file);
        const dirty = file.dirty;
        let allowed = true;
        const original = FileModel.prototype.commitPreparedCredentials;
        const commit = spyOn(FileModel.prototype, 'commitPreparedCredentials').mockImplementation(function (prepared, guard) {
            allowed = false;
            return original.call(this, prepared, guard);
        });
        try {
            await expect(applyInTest(file, baseline, passwordDraft(), () => allowed)).rejects.toThrow();
            expect(captureDatabaseCredentials(file)).toEqual(baseline);
            expect(file.dirty).toBe(dirty);
            expect(file.passwordChanged).toBe(false);
        } finally { commit.mockRestore(); }
    });
    test('suspension from the first model observer sees a complete commit and does not roll it back', async () => {
        const file = await model(true);
        const baseline = captureDatabaseCredentials(file);
        let allowed = true;
        let notifications = 0;
        file.on('change:passwordLength', () => {
            notifications++;
            allowed = false;
            expect(file.db.credentials.passwordHash).not.toBe(baseline.passwordHash);
            expect(file.db.credentials.keyFileHash).not.toBe(baseline.keyFileHash);
            expect(file.passwordChanged && file.keyFileChanged && file.dirty && file.modified).toBe(true);
            expect(file.keyFileName).toBe('new.key');
        });
        await applyInTest(file, baseline, {
            ...passwordDraft(), keyFile: { action: 'set', name: 'new.key', data: key('new-key').buffer as ArrayBuffer }
        }, () => allowed);
        expect(notifications).toBe(1);
        await reopen(await exportVault(file), 'new-password', 'new-key');
    });
    test('unconfirmed and empty passwords leave live credentials and dirty state untouched', async () => {
        const file = await model();
        const baseline = captureDatabaseCredentials(file);
        const modified = file.modified;
        for (const draft of [passwordDraft('new', 'different'), passwordDraft('')]) {
            await expect(applyInTest(file, baseline, draft)).rejects.toThrow('matching confirmation');
            expect(captureDatabaseCredentials(file)).toEqual(baseline);
            expect(file.modified).toBe(modified);
        }
    });
    test('malformed key file cannot partially apply a valid password', async () => {
        const file = await model();
        const baseline = captureDatabaseCredentials(file);
        const draft = passwordDraft();
        draft.keyFile = { action: 'set', name: 'broken.keyx', data: new TextEncoder().encode('<KeyFile><Meta><Version>2.0</Version></Meta><Key><Data Hash="00000000">ABCD</Data></Key></KeyFile>').buffer };
        await expect(applyInTest(file, baseline, draft)).rejects.toThrow();
        expect(captureDatabaseCredentials(file)).toEqual(baseline);
        expect(file.passwordChanged).toBe(false);
    });
    for (const reason of ['cancel', 'database replaced', 'credentials replaced', 'credentials edited', 'sync started', 'closed']) {
        test(`delayed preparation rejects ${reason} before any publication`, async () => {
            const file = await model();
            const original = file.db;
            const baseline = captureDatabaseCredentials(file);
            const [gate] = holdHashes('prepared-password');
            let allowed = true;
            const applying = applyInTest(file, baseline, passwordDraft('prepared-password'), () => allowed);
            void applying.catch(() => {});
            await Promise.race([gate.started.promise, applying.then(() => { throw new Error('Applied before hash gate'); }, (error) => { throw error; })]);
            if (reason === 'cancel') allowed = false;
            if (reason === 'database replaced') file.db = Kdbx.create(new Credentials(pw('replacement')), 'Replacement');
            if (reason === 'credentials replaced') file.db.credentials = new Credentials(pw('replacement'));
            if (reason === 'credentials edited') file.setPassword(pw('other-change'));
            if (reason === 'sync started') file.syncing = true;
            if (reason === 'closed') file.active = false;
            gate.release.resolve();
            await expect(applying).rejects.toThrow();
            expect(file.passwordLength).not.toBe('prepared-password'.length);
            if (reason !== 'credentials edited' && reason !== 'credentials replaced') {
                expect(original.credentials.passwordHash).toBe(baseline.passwordHash);
            }
        });
    }
    test('password + key replacement retains original reset references and exports only with new factors', async () => {
        const file = await model(true);
        const baseline = captureDatabaseCredentials(file);
        const draft = passwordDraft();
        draft.keyFile = { action: 'set', name: 'new.key', data: new TextEncoder().encode('new-key').buffer };
        await applyInTest(file, baseline, draft);
        expect(file.oldPasswordHash).toBe(baseline.oldPasswordHash);
        expect(file.oldKeyFileHash).toBe(baseline.oldKeyFileHash);
        expect(new TextDecoder().decode(draft.keyFile.data)).toBe('new-key');
        await reopen(await exportVault(file), 'new-password', 'new-key');
        await expect(reopen(await exportVault(file), 'original', 'original-key')).rejects.toThrow();
        await applyInTest(file, captureDatabaseCredentials(file), {
            password: { action: 'reset' }, keyFile: { action: 'reset' }
        });
        await reopen(await classicSave(file), 'original', 'original-key');
        expect(file.passwordChanged).toBe(false);
        expect(file.keyFileChanged).toBe(false);
    });
    test('key-only vault cannot remove its last factor; password addition permits removal', async () => {
        const file = await model(true);
        file.db.credentials = new Credentials(null, key('original-key'));
        await file.db.credentials.ready;
        file.oldPasswordHash = undefined;
        const baseline = captureDatabaseCredentials(file);
        await expect(applyInTest(file, baseline, { password: keep, keyFile: { action: 'remove' } })).rejects.toThrow('Keep a password');
        expect(captureDatabaseCredentials(file)).toEqual(baseline);
        await applyInTest(file, baseline, { ...passwordDraft(), keyFile: { action: 'remove' } });
        await reopen(await exportVault(file), 'new-password');
    });
    test('unsupported additional authentication factor fails closed', async () => {
        const file = await model();
        file.chalResp = (() => Promise.resolve(new ArrayBuffer(32))) as typeof file.chalResp;
        await expect(applyInTest(file, captureDatabaseCredentials(file), passwordDraft())).rejects.toThrow('Classic');
    });
    for (const factor of ['credential callback', 'custom shape']) {
        test(`${factor} fails closed even when file.chalResp is empty`, async () => {
            const file = await model();
            if (factor === 'credential callback') {
                file.db.credentials = new Credentials(pw('original'), undefined, async () => new ArrayBuffer(32));
                await file.db.credentials.ready;
            } else Object.defineProperty(file.db.credentials, 'extraFactor', { value: true });
            await expect(applyInTest(file, captureDatabaseCredentials(file), passwordDraft())).rejects.toThrow('Classic');
            expect(file.passwordChanged).toBe(false);
        });
    }
});

describe('credential changes across remote synchronization', () => {
    test('late A upload completion cannot install its baseline or clean a replacement database B', async () => {
        const file = await model(true);
        await applyInTest(file, captureDatabaseCredentials(file), {
            ...passwordDraft('password-A'), keyFile: { action: 'set', name: 'A.key', data: key('key-A').buffer as ArrayBuffer }
        });
        file.setSyncProgress();
        const remoteA = await syncSave(file);
        await reopen(remoteA, 'password-A', 'key-A');

        const replacement = await model(true);
        await applyInTest(replacement, captureDatabaseCredentials(replacement), {
            ...passwordDraft('password-B'), keyFile: { action: 'set', name: 'B.key', data: key('key-B').buffer as ArrayBuffer }
        });
        const encryptedB = await classicSave(replacement);
        // Exercise the real existing loader on the same FileModel. Only rebuilding browser
        // group/entry collections is stubbed; KDBX decrypt, db replacement and baseline setup run.
        const readModel = spyOn(FileModel.prototype, 'readModel').mockImplementation(() => {});
        try {
            file.keyFileName = 'B.key';
            await new Promise<void>((resolve, reject) => file.open(pw('password-B'), encryptedB,
                key('key-B').buffer as ArrayBuffer, (error) => error ? reject(error) : resolve()));
        } finally { readModel.mockRestore(); }
        const baselineB = captureDatabaseCredentials(file);
        const before = { path: file.path, storage: file.storage, modified: file.modified, dirty: file.dirty,
            passwordChanged: file.passwordChanged, keyFileChanged: file.keyFileChanged,
            oldPasswordLength: file.oldPasswordLength, oldKeyFileName: file.oldKeyFileName, date: file.oldKeyChangeDate };
        const cleanup = spyOn(file.db, 'removeLocalEditState');
        const markSaved = spyOn(FileModel.prototype, 'forEachEntry');
        try {
            const accepted = file.setSyncComplete('/old-A.kdbx', 'webdav', null);
            expect(captureDatabaseCredentials(file)).toEqual(baselineB);
            expect({ path: file.path, storage: file.storage, modified: file.modified, dirty: file.dirty,
                passwordChanged: file.passwordChanged, keyFileChanged: file.keyFileChanged,
                oldPasswordLength: file.oldPasswordLength, oldKeyFileName: file.oldKeyFileName, date: file.oldKeyChangeDate }).toEqual(before);
            expect(cleanup).not.toHaveBeenCalled();
            expect(markSaved).not.toHaveBeenCalled();
            expect(accepted).toBe(false);
            expect(file.syncing).toBe(false);
            expect(file.syncError).toContain('database changed');
        } finally { cleanup.mockRestore(); markSaved.mockRestore(); }
        await applyInTest(file, captureDatabaseCredentials(file), { password: { action: 'reset' }, keyFile: { action: 'reset' } });
        const resetB = await exportVault(file);
        await reopen(resetB, 'password-B', 'key-B');
        await expect(reopen(resetB, 'password-A', 'key-A')).rejects.toThrow();
        file.setSyncProgress();
        const retriedB = await syncSave(file);
        expect(file.setSyncComplete('/B.kdbx', 'webdav', null)).toBe(true);
        await reopen(retriedB, 'password-B', 'key-B');
        expect(file.syncError).toBeNull();
    });
    test('successful password A upload advances reset credentials despite an unrelated pending notes edit', async () => {
        const file = await model();
        const reload = spyOn(FileModel.prototype, 'reload').mockImplementation(() => {});
        try {
            await applyInTest(file, captureDatabaseCredentials(file), passwordDraft('password-A'));
            file.setSyncProgress();
            const remoteA = await syncSave(file);
            await reopen(remoteA, 'password-A');
            await expect(reopen(remoteA, 'original')).rejects.toThrow();
            const entry = file.db.getDefaultGroup().entries[0];
            entry.fields.set('Notes', 'Local notes edited during upload');
            entry.times.lastModTime = new Date(Date.now() + 1000);
            file.setModified();
            file.setSyncComplete(null, 'webdav', null);
            expect(file.modified && file.dirty).toBe(true);
            expect(file.passwordChanged).toBe(false);
            await applyInTest(file, captureDatabaseCredentials(file), { password: { action: 'reset' }, keyFile: keep });
            await reopen(await exportVault(file), 'password-A');
            file.setSyncProgress();
            await new Promise<void>((resolve, reject) => file.mergeOrUpdate(remoteA, null, (error) => error ? reject(error) : resolve()));
            const nextRemote = await syncSave(file);
            const saved = await reopen(nextRemote, 'password-A');
            expect(saved.getDefaultGroup().entries[0].fields.get('Notes')).toBe('Local notes edited during upload');
            await expect(reopen(nextRemote, 'original')).rejects.toThrow();
            file.setSyncComplete(null, 'webdav', null);
            expect(file.modified).toBe(false);
        } finally { reload.mockRestore(); }
    });
    test('successful upload A retains A as reset/remote key when Classic changes to B and downloads B during upload', async () => {
        const file = await model(true);
        const reload = spyOn(FileModel.prototype, 'reload').mockImplementation(() => {});
        try {
            await applyInTest(file, captureDatabaseCredentials(file), {
                ...passwordDraft('password-A'), keyFile: { action: 'set', name: 'A.key', data: key('key-A').buffer as ArrayBuffer }
            });
            file.setSyncProgress();
            const remoteA = await syncSave(file);
            file.setPassword(pw('password-B')); file.setKeyFile(key('key-B'), 'B.key');
            await waitForCredentialChanges(file.db.credentials);
            await reopen(await classicSave(file), 'password-B', 'key-B');
            file.setSyncComplete(null, 'webdav', null);
            expect(file.passwordChanged && file.keyFileChanged && file.modified).toBe(true);
            expect(file.oldKeyFileName).toBe('A.key');
            // Retry while B is current must decrypt the actual A remote through the retained baseline.
            file.setSyncProgress();
            await new Promise<void>((resolve, reject) => file.mergeOrUpdate(remoteA, null, (error) => error ? reject(error) : resolve()));
            file.setSyncComplete(null, 'webdav', 'Simulated write failure');
            file.resetPassword(); file.resetKeyFile();
            await reopen(await exportVault(file), 'password-A', 'key-A');
            await expect(reopen(remoteA, 'original', 'original-key')).rejects.toThrow();
            await expect(reopen(remoteA, 'password-B', 'key-B')).rejects.toThrow();
        } finally { reload.mockRestore(); }
    });
    test('credential changes during serialization reject the bytes instead of recording an ambiguous sync key', async () => {
        const file = await model();
        const baseline = file.oldPasswordHash;
        file.setSyncProgress();
        const original = Kdbx.prototype.save;
        const saving = spyOn(Kdbx.prototype, 'save').mockImplementation(async function () {
            const bytes = await original.call(this);
            file.setPassword(pw('changed-during-serialization'));
            await waitForCredentialChanges(file.db.credentials);
            return bytes;
        });
        try {
            await expect(syncSave(file)).rejects.toThrow('Credentials changed during serialization');
            file.setSyncComplete(null, 'webdav', 'Serialization conflict');
            expect(file.oldPasswordHash).toBe(baseline);
            expect(file.passwordChanged && file.modified).toBe(true);
        } finally { saving.mockRestore(); }
    });
    test('resetting one failed factor cannot silently accept another failed factor', async () => {
        const file = await model(true);
        const gates = holdHashes('failed-password', 'failed-key');
        file.setPassword(pw('failed-password')); file.setKeyFile(key('failed-key'), 'failed.key');
        await Promise.all(gates.map((gate) => gate.started.promise));
        gates.forEach((gate) => gate.release.reject(new Error('Digest failed')));
        await expect(waitForCredentialChanges(file.db.credentials)).rejects.toThrow();
        const baseline = captureDatabaseCredentials(file);
        await expect(applyInTest(file, baseline, { password: { action: 'reset' }, keyFile: keep })).rejects.toThrow();
        expect(captureDatabaseCredentials(file)).toEqual(baseline);
        await applyInTest(file, baseline, { password: { action: 'reset' }, keyFile: { action: 'reset' } });
        CryptoEngine.sha256 = realSha256;
        await reopen(await exportVault(file), 'original', 'original-key');
    });
    test('explicit reset recovers a failed current credential setter', async () => {
        const file = await model();
        const [gate] = holdHashes('failed-password');
        file.setPassword(pw('failed-password'));
        await gate.started.promise;
        gate.release.reject(new Error('Hash unavailable'));
        await expect(waitForCredentialChanges(file.db.credentials)).rejects.toThrow('Hash unavailable');
        await applyInTest(file, captureDatabaseCredentials(file), {
            password: { action: 'reset' }, keyFile: keep
        });
        await reopen(await classicSave(file), 'original');
        expect(file.passwordChanged).toBe(false);
    });
    test('failed password hashing cannot finish a tracked operation while the key file can still publish', async () => {
        const file = await model();
        const [password, keyFile] = holdHashes('failed-password', 'delayed-key');
        file.setPassword(pw('failed-password'));
        file.setKeyFile(key('delayed-key'), 'delayed.key');
        let settled = false;
        const waiting = waitForCredentialChanges(file.db.credentials);
        void waiting.then(() => { settled = true; }, () => { settled = true; });
        await Promise.all([password.started.promise, keyFile.started.promise]);
        password.release.reject(new Error('Hash unavailable'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        keyFile.release.resolve();
        await expect(waiting).rejects.toThrow('Hash unavailable');
        expect(file.db.credentials.keyFileHash).toBeDefined();
    });
    test('old-key remote merge, failed save, retry and reset retain the original baseline', async () => {
        const file = await model(true);
        const oldPassword = file.oldPasswordHash;
        const oldKey = file.oldKeyFileHash;
        const remoteBytes = await classicSave(file);
        const reload = spyOn(FileModel.prototype, 'reload').mockImplementation(() => {});
        await applyInTest(file, captureDatabaseCredentials(file), {
            ...passwordDraft(), keyFile: { action: 'set', name: 'new.key', data: new TextEncoder().encode('new-key').buffer }
        });
        const merge = () => new Promise<void>((resolve, reject) => file.mergeOrUpdate(remoteBytes, null, (error) => error ? reject(error) : resolve()));
        file.setSyncProgress();
        await merge();
        file.setSyncComplete(null, 'webdav', 'Network unavailable');
        expect(file.oldPasswordHash).toBe(oldPassword);
        expect(file.oldKeyFileHash).toBe(oldKey);
        expect(file.passwordChanged).toBe(true);
        expect(file.keyFileChanged).toBe(true);
        expect(file.modified).toBe(true);
        file.setSyncProgress();
        await merge();
        const saved = await syncSave(file);
        await reopen(saved, 'new-password', 'new-key');
        await expect(reopen(saved, 'original', 'original-key')).rejects.toThrow();
        file.setSyncComplete(null, 'webdav', null);
        expect(file.oldPasswordHash).toBe(file.db.credentials.passwordHash);
        expect(file.oldKeyFileHash).toBe(file.db.credentials.keyFileHash);
        expect(file.passwordChanged).toBe(false);
        expect(file.keyFileChanged).toBe(false);
        file.resetPassword(); file.resetKeyFile();
        await reopen(await classicSave(file), 'new-password', 'new-key');
        reload.mockRestore();
    });
    test('remote content with an unrelated key is rejected instead of overwritten', async () => {
        const file = await model();
        const foreign = Kdbx.create(new Credentials(pw('foreign')), 'Other remote');
        const remote = await foreign.save();
        await applyInTest(file, captureDatabaseCredentials(file), passwordDraft());
        await expect(new Promise<void>((resolve, reject) => file.mergeOrUpdate(remote, null, (error) => error ? reject(error) : resolve()))).rejects.toThrow();
        expect(file.passwordChanged).toBe(true);
    });
    test('edits during a Classic save do not advance the credential reset baseline', async () => {
        const file = await model();
        const baseline = file.oldPasswordHash;
        file.setSyncProgress();
        file.setPassword(pw('changed-during-save'));
        await waitForCredentialChanges(file.db.credentials);
        file.setSyncComplete(null, null, null);
        expect(file.oldPasswordHash).toBe(baseline);
        expect(file.passwordChanged).toBe(true);
        expect(file.modified).toBe(true);
    });
});
