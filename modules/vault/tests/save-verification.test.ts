import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { EventEmitter } from 'events';
import { ByteUtils, Credentials, CryptoEngine, Int64, Kdbx, ProtectedValue, VarDictionary } from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';
import { saveAndLock } from '../src/comp/app/vault-lifecycle';
import { getSessionAccess } from '../src/comp/app/session-access';
import { captureSaveCredentials, releaseSaveCredentials } from '../src/util/kdbxweb/save-verification';

// Real AppModel, FileModel, serialization and verification. Only platform I/O and
// unrelated collection/view dependencies are replaced. Run in a separate Bun process.
const events = new EventEmitter();
class QuietLogger { info() {} debug() {} error() {} warn() {} }
const cache = { save: mock((_id: unknown, _opts: unknown, _data: ArrayBuffer, done: (error?: unknown) => void) => done()) };
const remote = { name: 'webdav', enabled: true, load: mock(() => {}),
    save: mock((_path: unknown, _opts: unknown, _data: ArrayBuffer, done: (error?: unknown, stat?: object) => void) => done(undefined, { rev: 'saved' })),
    stat: undefined as undefined | ((path: unknown, opts: unknown, done: (error?: unknown, stat?: object) => void) => void) };
mock.module('framework/events', () => ({ Events: events }));
mock.module('storage', () => ({ Storage: { cache, webdav: remote } }));
mock.module('demo.kdbx', () => ({ default: '' }));
mock.module('collections/group-collection', () => ({ GroupCollection: class extends Array {} }));
mock.module('collections/file-collection', () => ({ FileCollection: class extends Array {} }));
mock.module('collections/file-info-collection', () => ({ FileInfoCollection: { get() {}, save() {} } }));
mock.module('models/file-info-model', () => ({ FileInfoModel: class {} }));
mock.module('util/formatting/icon-url-format', () => ({ IconUrlFormat: {} }));
mock.module('hooks/storage-guards', () => ({ runBeforeOpen() {}, runBeforeSync() {} }));
mock.module('collections/search-result-collection', () => ({ SearchResultCollection: class {} }));
mock.module('const/runtime-info', () => ({ RuntimeInfo: { beta: false } }));
mock.module('const/timeouts', () => ({ Timeouts: {} }));
mock.module('models/app-settings-model', () => ({ AppSettingsModel: {} }));
mock.module('models/entry-model', () => ({ EntryModel: class {} }));
mock.module('models/group-model', () => ({ GroupModel: class {} }));
mock.module('models/menu/menu-model', () => ({ MenuModel: class {} }));
mock.module('util/features', () => ({ Features: {} }));
mock.module('comp/i18n/date-format', () => ({ DateFormat: {} }));
mock.module('util/formatting/url-format', () => ({ UrlFormat: {} }));
mock.module('util/locale', () => ({ Locale: { openFileNoCacheError: 'No cache' } }));
mock.module('util/logger', () => ({ Logger: QuietLogger }));
mock.module('util/fn', () => ({ noop: () => {}, debounce: (fn: unknown) => fn }));


const { AppModel } = await import('../src/models/app-model');
const { FileModel } = await import('../src/models/file-model');
const load = Kdbx.load;
const password = 'Disposable verification password';
const pw = () => ProtectedValue.fromString(password);
function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
    events.removeAllListeners(); cache.save.mockClear(); remote.save.mockClear(); remote.load.mockClear(); remote.stat = undefined;
    CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) =>
        ByteUtils.arrayToBuffer(await (type === CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id)({
            password: new Uint8Array(password), salt: new Uint8Array(salt), memorySize: memory,
            iterations, parallelism, hashLength: length, outputType: 'binary'
        })));
});
afterEach(() => { mock.restore(); Kdbx.load = load; });
async function setup(storage: string | null = null, offlineDisabled = false) {
    const db = Kdbx.create(new Credentials(pw()), 'Verification'); await db.credentials.ready;
    db.header.kdfParameters!.set('M', VarDictionary.ValueType.UInt64, Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', VarDictionary.ValueType.UInt64, Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup()); entry.fields.set('Title', 'Recoverable change');
    const file = new FileModel({ id: 'verification', active: true, name: 'Verification', storage, path: '/verification.kdbx' });
    file.db = db; file.groups = [] as any; file.setModified(); Object.defineProperty(file, 'reload', { value: mock(() => {}) });
    const files = Object.assign([file], { get(id: string) { return this.find((f) => f.id === id); } });
    const info = { id: file.id, name: file.name, storage, modified: false, set(props: object) { Object.assign(this, props); } };
    const infos = Object.assign([info], { get(id: string) { return this.find((i) => i.id === id); }, save: mock(() => {}) });
    const app = Object.create(AppModel.prototype) as InstanceType<typeof AppModel>;
    Object.assign(app, { files, fileInfos: infos, settings: { saveVerify: true, disableOfflineStorage: offlineDisabled, rememberKeyFiles: 'none' },
        getFileInfo: () => info, getStoreOpts: async () => ({}), scheduleBackupFile: mock(() => {}), refresh: mock(() => {}),
        closeAllFiles: mock(() => { file.active = false; files.length = 0; }) });
    const done = mock((_error?: unknown) => {});
    return { app, file, db, entry, info, infos, done };
}
function holdVerification(fail = false) {
    const started = deferred(), release = deferred();
    const spy = spyOn(Kdbx, 'load').mockImplementation(async (data, credentials, options) => {
        const reopened = await load(data, credentials, options);
        started.resolve(); await release.promise;
        if (fail) throw new Error('Controlled verification failure');
        return reopened;
    });
    return { started, release, spy };
}

for (const mode of ['local', 'remote-cache', 'remote-no-cache', 'stat-error'] as const) {
    for (const timing of ['immediate', 'delayed'] as const) test(`${mode}: ${timing} verification failure cannot publish bytes or report success`, async () => {
        const h = await setup(mode === 'local' ? null : 'webdav', mode === 'remote-no-cache');
        if (mode === 'stat-error') remote.stat = (_path, _opts, done) => done(new Error('offline'));
        const warning = mock(); events.on('save-verify-failed', warning);
        const gate = holdVerification(true);
        h.app.syncFile(h.file, undefined, h.done);
        await gate.started.promise;
        if (timing === 'delayed') { await settle(); await settle(); }
        // Cache/remote callbacks are synchronous: the old implementation had already
        // completed them and cleared dirty by this point, before verification settled.
        expect(cache.save).not.toHaveBeenCalled(); expect(remote.save).not.toHaveBeenCalled();
        expect(h.done).not.toHaveBeenCalled(); expect(h.file.syncing).toBe(true);
        gate.release.resolve(); await settle();
        expect(h.done).toHaveBeenCalledTimes(1);
        expect(h.done.mock.calls[0][0]).toMatchObject({ code: 'SaveVerificationFailed' });
        expect(h.file.dirty).toBe(true); expect(h.file.modified).toBe(true); expect(h.file.active).toBe(true);
        expect(warning).toHaveBeenCalledTimes(1);
        expect(cache.save).not.toHaveBeenCalled(); expect(remote.save).not.toHaveBeenCalled();
        expect(h.app.scheduleBackupFile).not.toHaveBeenCalled();
        // Recovery does not depend on the failed serialized bytes.
        gate.spy.mockRestore();
        const recovered = await load(await h.db.save(), new Credentials(pw()));
        expect(recovered.getDefaultGroup().entries[0].fields.get('Title')).toBe('Recoverable change');
    });
}

test('successful verification runs once before cache and remote callbacks; downloaded bytes reopen', async () => {
    const h = await setup('webdav'), gate = holdVerification();
    h.app.syncFile(h.file, undefined, h.done); await gate.started.promise;
    expect(cache.save).not.toHaveBeenCalled(); expect(remote.save).not.toHaveBeenCalled();
    gate.release.resolve(); await settle();
    expect(gate.spy).toHaveBeenCalledTimes(1); expect(h.done).toHaveBeenCalledTimes(1);
    expect(h.done.mock.calls[0][0]).toBeUndefined(); expect(h.file.dirty).toBe(false);
    expect(cache.save).toHaveBeenCalledTimes(1); expect(remote.save).toHaveBeenCalledTimes(1);
    const data = remote.save.mock.calls[0][2];
    const reopened = await load(data, new Credentials(pw()));
    expect(reopened.getDefaultGroup().entries[0].fields.get('Title')).toBe('Recoverable change');
});

test('lock waits for verification failure and keeps recoverable live data open; retry can close', async () => {
    const h = await setup(), gate = holdVerification(true);
    getSessionAccess(h.app).beginSecuring();
    const locking = saveAndLock(h.app); const failed = locking.catch((error: Error) => error);
    await settle(); expect(h.file.syncing).toBe(true); expect(h.file.syncError).toBeNull();
    await gate.started.promise; await settle();
    expect(h.app.closeAllFiles).not.toHaveBeenCalled(); expect(cache.save).not.toHaveBeenCalled();
    gate.release.resolve(); expect((await failed as Error).message).toContain('Changes could not be saved');
    expect(h.app.closeAllFiles).not.toHaveBeenCalled(); expect(h.file.dirty).toBe(true);
    gate.spy.mockRestore(); await saveAndLock(h.app);
    expect(h.app.closeAllFiles).toHaveBeenCalledTimes(1);
});

test('timeout/recovery during verification rejects late publication and closure', async () => {
    const h = await setup(), gate = holdVerification(); const access = getSessionAccess(h.app);
    const epoch = access.beginSecuring(), controller = new AbortController();
    const locking = saveAndLock(h.app, controller.signal); const canceled = locking.catch((error: Error) => error);
    await gate.started.promise; controller.abort(); access.requireRecovery(epoch); expect((await canceled as Error).message).toContain('canceled');
    gate.release.resolve(); await settle();
    expect(cache.save).not.toHaveBeenCalled(); expect(h.app.closeAllFiles).not.toHaveBeenCalled();
    expect(h.file.dirty).toBe(true); expect(h.file.syncError).toContain('expired');
});

test('Classic opt-out retains its callback behavior without verification', async () => {
    const h = await setup(); h.app.settings.saveVerify = false;
    const spy = spyOn(Kdbx, 'load'); h.app.syncFile(h.file, undefined, h.done);
    for (let i = 0; i < 100 && !h.done.mock.calls.length; i++) await settle();
    expect(spy).not.toHaveBeenCalled(); expect(h.done).toHaveBeenCalledTimes(1);
    expect(h.done.mock.calls[0][0]).toBeUndefined(); expect(h.file.dirty).toBe(false);
});

test('detached credential factors survive live mutation; temporary buffers do not alias originals', async () => {
    const h = await setup(); const original = h.db.credentials.passwordHash!;
    const snapshot = captureSaveCredentials(h.db.credentials);
    expect(snapshot.passwordHash).not.toBe(original);
    expect(snapshot.passwordHash!.getText()).toBe(original.getText());
    releaseSaveCredentials(snapshot);
    expect(snapshot.passwordHash!.value.every((byte) => byte === 0)).toBe(true);
    expect(original.value.some((byte) => byte !== 0)).toBe(true);
});

test('database replacement during verification cannot publish or become the replacement reset baseline', async () => {
    const h = await setup(), gate = holdVerification();
    h.app.syncFile(h.file, undefined, h.done); await gate.started.promise;
    const replacement = Kdbx.create(new Credentials(ProtectedValue.fromString('Replacement')), 'Replacement');
    await replacement.credentials.ready; h.file.db = replacement;
    const baseline = h.file.oldPasswordHash;
    gate.release.resolve(); await settle();
    expect(h.done.mock.calls[0][0]).toContain('database changed');
    expect(h.file.db).toBe(replacement); expect(h.file.oldPasswordHash).toBe(baseline);
    expect(cache.save).not.toHaveBeenCalled(); expect(h.file.dirty).toBe(true);
});

test('optional continuation guard denies late verification publication without changing Classic defaults', async () => {
    const h = await setup('webdav'), gate = holdVerification(); let allowed = true;
    h.app.syncFile(h.file, { canContinue: () => allowed }, h.done); await gate.started.promise;
    allowed = false; gate.release.resolve(); await settle();
    expect(h.done.mock.calls[0][0]).toContain('expired');
    expect(cache.save).not.toHaveBeenCalled(); expect(remote.save).not.toHaveBeenCalled();
    expect(h.file.dirty).toBe(true);
});

for (const boundary of ['cancel', 'database', 'credentials', 'wrong-key-after-cancel'] as const) {
    test(`remote merge ${boundary} during decrypt cannot adopt credentials or mutate the live database`, async () => {
        const h = await setup('webdav');
        const bytes = await h.db.save(), before = h.entry.fields.get('Title');
        const entered = deferred(), release = deferred(); let allowed = true;
        spyOn(Kdbx, 'load').mockImplementation(async (data, credentials, options) => {
            const db = await load(data, credentials, options);
            db.getDefaultGroup().entries[0].fields.set('Title', 'Must not publish');
            entered.resolve(); await release.promise;
            if (boundary === 'wrong-key-after-cancel') throw Object.assign(new Error('Invalid key'), { code: 'InvalidKey' });
            return db;
        });
        h.file.mergeOrUpdate(bytes, null, h.done, () => allowed);
        await entered.promise;
        if (boundary === 'database') h.file.db = Kdbx.create(new Credentials(pw()), 'Replacement');
        else if (boundary === 'credentials') h.file.db.credentials = new Credentials(pw());
        else allowed = false;
        const currentDb = h.file.db, currentCredentials = h.file.db.credentials;
        release.resolve(); await settle();
        expect(h.done).toHaveBeenCalledTimes(1);
        expect(h.done.mock.calls[0][0]).toBeInstanceOf(Error);
        expect((h.done.mock.calls[0][0] as { code?: string }).code).not.toBe('InvalidKey');
        expect(h.file.db).toBe(currentDb); expect(h.file.db.credentials).toBe(currentCredentials);
        expect(h.entry.fields.get('Title')).toBe(before); expect(h.file.reload).not.toHaveBeenCalled();
    });
}

test('Classic remote merge without a guard retains successful adoption', async () => {
    const h = await setup('webdav'); const bytes = await h.db.save(); h.file.modified = false;
    h.file.mergeOrUpdate(bytes, null, h.done);
    for (let i = 0; i < 100 && !h.done.mock.calls.length; i++) await settle();
    expect(h.done).toHaveBeenCalledTimes(1); expect(h.done.mock.calls[0][0]).toBeUndefined();
    expect(h.file.db).not.toBe(h.db); expect(h.file.reload).toHaveBeenCalledTimes(1);
});
