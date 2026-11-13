import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import { Credentials, ProtectedValue } from 'kdbxweb';

// Run this file in its own Bun process. These module mocks isolate browser/I/O
// dependencies; AppModel, SessionAccess, SyncScheduler and createVault stay real.
// Bun's mock.module registry is process-wide: mock.restore does not unmock it.
type Callback = (error?: unknown) => void;
const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
const password = 'admission-test-password';
const cacheSave = mock((_id: string, _opts: unknown, _data: ArrayBuffer, done?: Callback) => done?.());
const cacheRemove = mock((_id: string, _opts: unknown, done?: Callback, canRemove?: () => boolean) => { if (canRemove?.() !== false) done?.(); });
const cacheLoad = mock((_id: string, _opts: unknown, _done: (error: unknown, data?: ArrayBuffer) => void) => {});
const remoteLoad = mock((_path: unknown, _opts: unknown, _done: (error: unknown, data?: ArrayBuffer) => void) => {});
const remoteSave = mock(() => {});
const beforeSync = mock(() => undefined);
let nextId = 0;

class PendingFile extends EventEmitter {
    static created: PendingFile[] = [];
    id = '';
    name = 'vault';
    active = false;
    demo = false;
    syncing = false;
    editSeq = 0;
    syncStartEditSeq = 0;
    set = (props: object) => Object.assign(this, props);
    dirty = true;
    modified = true;
    storage: string | null = null;
    path: string | null = null;
    opts = {};
    db = { credentials: new Credentials(ProtectedValue.fromString(password)) };
    openDone?: Callback;
    importDone?: Callback;
    createDone?: () => void;
    close = mock(() => { this.active = false; });
    setPassword = mock(() => {});
    getDataForSync = mock((done: (data: ArrayBuffer) => void) => done(bytes));
    getLocalEditState = () => null;
    setSyncProgress = mock(() => { this.syncing = true; this.syncStartEditSeq = this.editSeq; });
    setSyncComplete = mock(() => { this.syncing = false; this.dirty = false; this.modified = false; return true; });
    constructor(props: Record<string, unknown>) {
        super(); Object.assign(this, props); PendingFile.created.push(this);
    }
    open(_password: unknown, _data: unknown, _key: unknown, done: Callback) { this.openDone = done; }
    importWithXml(_xml: string, done: Callback) { this.importDone = done; }
    create(name: string, done: () => void) { this.name = name; this.createDone = done; }
    finishOpen() { this.active = true; this.openDone!(); }
    finishImport() { this.active = true; this.importDone!(); }
    finishCreate() { this.active = true; this.createDone!(); }
}
class FileList extends Array<PendingFile> {
    get(id: string) { return this.find((file) => file.id === id); }
    getByName(name: string) { return this.find((file) => file.name === name); }
}
class Info {
    static created: Info[] = [];
    id = '';
    name = '';
    set = mock((props: object) => Object.assign(this, props));
    constructor(props: object) { Object.assign(this, props); Info.created.push(this); }
}
class InfoList extends Array<Info> {
    get(id: string) { return this.find((info) => info.id === id); }
    getMatch() { return undefined; }
    getByName(name: string) { return this.find((info) => info.name === name); }
    save = mock(() => {});
}
const events = new EventEmitter();
class QuietLogger { info() {} debug() {} error() {} warn() {} }
mock.module('framework/events', () => ({ Events: events }));
mock.module('storage', () => ({ Storage: {
    cache: { save: cacheSave, load: cacheLoad, remove: cacheRemove },
    webdav: { name: 'webdav', enabled: true, load: remoteLoad, save: remoteSave }
} }));
mock.module('collections/search-result-collection', () => ({ SearchResultCollection: class {} }));
mock.module('collections/file-collection', () => ({ FileCollection: FileList }));
mock.module('collections/file-info-collection', () => ({ FileInfoCollection: new InfoList() }));
mock.module('const/runtime-info', () => ({ RuntimeInfo: { beta: false } }));
mock.module('const/timeouts', () => ({ Timeouts: {} }));
mock.module('models/app-settings-model', () => ({ AppSettingsModel: {} }));
mock.module('models/entry-model', () => ({ EntryModel: class {} }));
mock.module('models/file-info-model', () => ({ FileInfoModel: Info }));
mock.module('models/file-model', () => ({ FileModel: PendingFile }));
mock.module('models/group-model', () => ({ GroupModel: class {} }));
mock.module('models/menu/menu-model', () => ({ MenuModel: class {} }));
mock.module('util/features', () => ({ Features: {} }));
mock.module('comp/i18n/date-format', () => ({ DateFormat: {} }));
mock.module('util/formatting/url-format', () => ({ UrlFormat: {} }));
mock.module('util/generators/id-generator', () => ({ IdGenerator: { uuid: () => `new-${++nextId}` } }));
mock.module('util/locale', () => ({ Locale: { openFileNoCacheError: 'No cache' } }));
mock.module('util/logger', () => ({ Logger: QuietLogger }));
mock.module('util/fn', () => ({ noop: () => {}, debounce: (fn: unknown) => fn }));
mock.module('hooks/storage-guards', () => ({ runBeforeOpen: () => undefined, runBeforeSync: beforeSync }));
mock.module('util/kdbxweb/protected-value-ex', () => ({}));

const { AppModel } = await import('../../../vault/src/models/app-model');
const { getSessionAccess } = await import('../../../vault/src/comp/app/session-access');
const { createVault } = await import('../../../vault/src/comp/app/vault-files');
const { saveAndLock } = await import('../../../vault/src/comp/app/vault-lifecycle');
type Model = InstanceType<typeof AppModel>;
type RealFile = Parameters<Model['syncFile']>[0];

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function model() {
    const app = new AppModel();
    const files = app.files as unknown as FileList;
    const infos = new InfoList();
    app.fileInfos = infos as unknown as Model['fileInfos'];
    app.settings = { canCreate: true, autoSaveInterval: -1, disableOfflineStorage: false,
        rememberKeyFiles: 'none', saveVerify: false } as Model['settings'];
    const add = mock((file: RealFile) => { files.push(file as unknown as PendingFile); });
    const opened = mock(() => {});
    const recent = mock(() => {});
    const opts = mock(async () => {});
    app.addFile = add;
    app.fileOpened = opened;
    app.addToLastOpenFiles = recent;
    app.setFileOpts = opts;
    app.getStoreOpts = mock(async () => ({}));
    app.scheduleBackupFile = mock(() => {});
    app.closeAllFiles = mock(() => { for (const file of files) file.close(); files.length = 0; });
    return { app, files, infos, add, opened, recent, opts };
}
type Harness = ReturnType<typeof model>;
beforeEach(() => {
    PendingFile.created = []; Info.created = []; nextId = 0; events.removeAllListeners();
    for (const call of [cacheSave, cacheLoad, cacheRemove, remoteLoad, remoteSave, beforeSync]) call.mockClear();
});
type Phase = 'securing' | 'recovery-required' | 'reopened';
function advanceEmpty(app: Model, phase: Phase) {
    const access = getSessionAccess(app);
    const epoch = access.beginSecuring();
    if (phase === 'recovery-required') access.requireRecovery(epoch);
    if (phase === 'reopened') { access.completeClose(epoch); access.resetClosedSession(); }
    expect(access.state).toBe(phase === 'reopened' ? 'open' : phase);
}
function expectDenied(done: ReturnType<typeof mock>, phase: Phase) {
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][0]).toMatchObject({ code: phase === 'reopened' ? 'stale-session' : 'access-denied' });
}
function expectNoPublication(h: Harness) {
    expect(h.files).toHaveLength(0);
    expect(h.add).not.toHaveBeenCalled(); expect(h.opened).not.toHaveBeenCalled();
    expect(h.recent).not.toHaveBeenCalled(); expect(cacheSave).not.toHaveBeenCalled();
}

describe('AppModel open/create/import admission', () => {
    for (const boundary of ['request', 'loaded', 'decrypted', 'options'] as const) {
        test(`optional UI admission guard rejects at ${boundary} without cache/recent publication`, async () => {
            const h = model(); const done = mock(); let allowed = boundary !== 'request';
            const options = deferred<void>();
            if (boundary === 'options') h.app.setFileOpts = mock(() => options.promise);
            h.app.openFile({ name: 'guarded', ...(boundary === 'loaded'
                ? { storage: 'webdav', path: '/guarded.kdbx' } : { fileData: bytes }), canOpen: () => allowed }, done);
            if (boundary === 'loaded') {
                allowed = false; remoteLoad.mock.calls[0][2](null, bytes);
            } else if (boundary === 'decrypted') {
                allowed = false; PendingFile.created[0].finishOpen();
            } else if (boundary === 'options') {
                PendingFile.created[0].finishOpen(); allowed = false; options.resolve();
            }
            await settle();
            expect(done).toHaveBeenCalledTimes(1);
            expect(done.mock.calls[0][0]).toBeInstanceOf(Error);
            expectNoPublication(h);
            if (boundary === 'request' || boundary === 'loaded') expect(PendingFile.created).toHaveLength(0);
            else expect(PendingFile.created[0].close).toHaveBeenCalledTimes(1);
        });
    }

    test('Classic defaults to open: successful local open caches and publishes exactly once', async () => {
        const h = model(); const done = mock();
        expect(getSessionAccess(h.app).state).toBe('open');
        h.app.openFile({ name: 'classic', fileData: bytes }, done);
        const file = PendingFile.created[0];
        file.finishOpen(); await settle();
        expect(done).toHaveBeenCalledTimes(1); expect(done.mock.calls[0]).toEqual([null, file]);
        expect(h.files).toEqual([file]); expect(h.recent).toHaveBeenCalledTimes(1);
        expect(h.opened).toHaveBeenCalledTimes(1); expect(cacheSave).toHaveBeenCalledTimes(1);
        expect(file.close).not.toHaveBeenCalled();
    });

    for (const phase of ['securing', 'recovery-required', 'closed'] as const) {
        test(`new requests in ${phase} cannot start open/import/create work`, () => {
            const h = model(); const access = getSessionAccess(h.app); const epoch = access.beginSecuring();
            if (phase === 'recovery-required') access.requireRecovery(epoch);
            if (phase === 'closed') access.completeClose(epoch);
            const open = mock(); const imported = mock(); const created = mock();
            h.app.openFile({ name: 'late', fileData: bytes }, open);
            h.app.importFileWithXml({ name: 'late', fileXml: '<KeePassFile/>' }, imported);
            expect(() => h.app.createNewFile('late', created)).toThrow('access-denied');
            expect(open.mock.calls[0][0]).toMatchObject({ code: 'access-denied' });
            expect(imported.mock.calls[0][0]).toMatchObject({ code: 'access-denied' });
            expect(open).toHaveBeenCalledTimes(1); expect(imported).toHaveBeenCalledTimes(1);
            expect(created).not.toHaveBeenCalled(); expect(PendingFile.created).toHaveLength(0);
            expect(remoteLoad).not.toHaveBeenCalled(); expectNoPublication(h);
        });
    }

    for (const phase of ['securing', 'recovery-required', 'reopened'] as const) {
        test(`pending provider load cannot enter decryption after ${phase}`, () => {
            const h = model(); const done = mock();
            h.app.openFile({ name: 'remote', storage: 'webdav', path: '/vault.kdbx' }, done);
            expect(remoteLoad).toHaveBeenCalledTimes(1);
            advanceEmpty(h.app, phase);
            remoteLoad.mock.calls[0][2](null, bytes);
            expectDenied(done, phase); expect(PendingFile.created).toHaveLength(0); expectNoPublication(h);
        });

        test(`pending decrypt completion cannot publish after ${phase}`, async () => {
            const h = model(); const done = mock();
            h.app.openFile({ name: 'pending', fileData: bytes }, done);
            const file = PendingFile.created[0];
            advanceEmpty(h.app, phase); file.finishOpen(); await settle();
            expectDenied(done, phase); expect(file.close).toHaveBeenCalledTimes(1);
            expect(h.opts).not.toHaveBeenCalled(); expectNoPublication(h);
        });

        test(`cancel while setFileOpts awaits leaves no orphan cache or publication after ${phase}`, async () => {
            const h = model(); const done = mock(); const pending = deferred<void>();
            h.app.setFileOpts = mock(() => pending.promise);
            h.app.openFile({ name: 'pending-options', fileData: bytes }, done);
            const file = PendingFile.created[0]; file.finishOpen();
            expect(h.app.setFileOpts).toHaveBeenCalledTimes(1);
            expect(cacheSave).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
            advanceEmpty(h.app, phase); pending.resolve(); await settle();
            expectDenied(done, phase); expect(file.close).toHaveBeenCalledTimes(1); expectNoPublication(h);
        });

        test(`pending XML import cannot publish after ${phase}`, () => {
            const h = model(); const done = mock();
            h.app.importFileWithXml({ name: 'xml', fileXml: '<KeePassFile/>' }, done);
            const file = PendingFile.created[0];
            advanceEmpty(h.app, phase); file.finishImport();
            expectDenied(done, phase); expect(file.close).toHaveBeenCalledTimes(1); expectNoPublication(h);
        });

        test(`canceled createVault rejects instead of hanging after ${phase}`, async () => {
            const h = model();
            const creating = createVault(h.app, 'new vault', 'new password');
            const outcome = creating.then(() => ({ error: null }), (error: unknown) => ({ error }));
            const file = PendingFile.created[0];
            advanceEmpty(h.app, phase); file.finishCreate();
            const result = await outcome;
            expect(result.error).toMatchObject({ code: phase === 'reopened' ? 'stale-session' : 'access-denied' });
            expect(file.close).toHaveBeenCalledTimes(1); expect(file.setPassword).not.toHaveBeenCalled();
            expectNoPublication(h); expect(beforeSync).not.toHaveBeenCalled();
        });
    }

    test('setFileOpts rejection settles open once without caching or publishing', async () => {
        const h = model(); const done = mock(); const error = new Error('cannot decrypt saved options');
        h.app.setFileOpts = mock(async () => { throw error; });
        h.app.openFile({ name: 'broken-options', fileData: bytes }, done);
        const file = PendingFile.created[0]; file.finishOpen(); await settle();
        expect(done.mock.calls).toEqual([[error]]); expect(file.close).toHaveBeenCalledTimes(1); expectNoPublication(h);
    });

    test('open-generation create and import retain Classic publication behavior', () => {
        const h = model(); const created = mock(); const failed = mock();
        h.app.createNewFile('created', created, failed);
        const first = PendingFile.created[0]; first.finishCreate();
        expect(created.mock.calls).toEqual([[first]]); expect(failed).not.toHaveBeenCalled();
        h.app.importFileWithXml({ name: 'xml', fileXml: '<KeePassFile/>' }, mock());
        const second = PendingFile.created[1]; second.finishImport();
        expect(h.files).toEqual([first, second]); expect(h.opened).toHaveBeenCalledTimes(1);
        expect(second.close).not.toHaveBeenCalled();
    });
});

function syncHarness(existingInfo = true) {
    const h = model(); const file = new PendingFile({ id: 'sync-file', name: 'sync vault', active: true });
    h.files.push(file);
    if (existingInfo) h.infos.push(new Info({ id: file.id, name: file.name, modified: true }));
    return { ...h, file, real: file as unknown as RealFile };
}
function expectNoSync(h: ReturnType<typeof syncHarness>, infoCount: number) {
    expect(h.file.setSyncProgress).not.toHaveBeenCalled(); expect(h.file.getDataForSync).not.toHaveBeenCalled();
    expect(cacheSave).not.toHaveBeenCalled(); expect(remoteSave).not.toHaveBeenCalled();
    expect(Info.created).toHaveLength(infoCount); expect(h.infos.save).not.toHaveBeenCalled();
    expect(h.file.dirty).toBe(true);
}
async function recover(app: Model) {
    const access = getSessionAccess(app); const securing = access.beginSecuring();
    const epoch = access.requireRecovery(securing);
    const targets = await access.prepareRecovery(epoch);
    for (const target of targets) await access.verifyVault(epoch, target.id, { password });
    access.resumeRecovery(epoch);
    expect(access.state).toBe('open');
}

describe('AppModel background sync admission', () => {
    test('a rejected stale completion reports failure without publishing replacement file metadata', async () => {
        const h = syncHarness(); const done = mock();
        let completed!: Callback;
        cacheSave.mockImplementationOnce((_id, _opts, _data, callback) => { completed = callback!; });
        h.app.syncFile(h.real, undefined, done); await settle();
        expect(cacheSave).toHaveBeenCalledTimes(1);
        expect(done).not.toHaveBeenCalled();
        h.file.db = { credentials: new Credentials(ProtectedValue.fromString('replacement-password')) };
        // FileModel's encrypted replacement test covers the identity decision itself. Here
        // retain the admission fixture and exercise AppModel's handling of its false result.
        h.file.setSyncComplete.mockImplementationOnce(() => { h.file.syncing = false; return false; });
        completed(); await settle();
        expect(h.file.setSyncComplete).toHaveBeenCalledTimes(1);
        expect(done.mock.calls).toEqual([['The database changed before saving completed.']]);
        expect(h.app.getStoreOpts).not.toHaveBeenCalled();
        expect(h.infos[0].set).not.toHaveBeenCalled();
        expect(h.infos.save).not.toHaveBeenCalled();
        expect(h.file.modified && h.file.dirty).toBe(true);
    });
    test('default Classic open admits a normal sync with no explicit epoch', async () => {
        const h = syncHarness(); const done = mock();
        h.app.syncFile(h.real, undefined, done); await settle();
        expect(done.mock.calls).toEqual([[undefined]]);
        expect(h.file.setSyncProgress).toHaveBeenCalledTimes(1); expect(cacheSave).toHaveBeenCalledTimes(1);
        expect(h.infos.save).toHaveBeenCalledTimes(1);
    });

    test('securing rejects background/missing/stale epoch but saveAndLock supplies the explicit current epoch', async () => {
        const h = syncHarness(); const access = getSessionAccess(h.app); const epoch = access.beginSecuring();
        for (const options of [undefined, {}, { sessionEpoch: epoch - 1 }, { sessionEpoch: epoch + 1 }]) {
            const done = mock(); h.app.syncFile(h.real, options, done);
            expect(done.mock.calls).toEqual([['Session access suspended']]);
        }
        expectNoSync(h, 1); expect(beforeSync).not.toHaveBeenCalled();
        await saveAndLock(h.app);
        expect(cacheSave).toHaveBeenCalledTimes(1); expect(h.infos.save).toHaveBeenCalledTimes(1);
        expect(h.app.closeAllFiles).toHaveBeenCalledTimes(1);
    });

    for (const phase of ['recovery-required', 'closed'] as const) {
        test(`${phase} denies even an explicit current sync epoch`, () => {
            const h = syncHarness(); const access = getSessionAccess(h.app); const epoch = access.beginSecuring();
            if (phase === 'recovery-required') access.requireRecovery(epoch);
            else { h.file.active = false; access.completeClose(epoch); h.file.active = true; }
            const done = mock(); h.app.syncFile(h.real, { sessionEpoch: access.epoch }, done);
            expect(done.mock.calls).toEqual([['Session access suspended']]); expectNoSync(h, 1);
        });
    }

    for (const change of ['securing', 'recovery', 'reauthenticated', 'file-replaced', 'db-replaced', 'inactive', 'another-writer'] as const) {
        test(`delayed getStoreOpts setup is denied before FileInfo creation/write when ${change}`, async () => {
            const h = syncHarness(false); const pending = deferred<Record<string, unknown>>(); const done = mock();
            h.app.getStoreOpts = mock(() => pending.promise);
            const originalDb = h.file.db;
            h.app.syncFile(h.real, undefined, done);
            expect(h.app.getStoreOpts).toHaveBeenCalledTimes(1); expectNoSync(h, 0);
            if (change === 'securing') getSessionAccess(h.app).beginSecuring();
            if (change === 'recovery') {
                const access = getSessionAccess(h.app); access.requireRecovery(access.beginSecuring());
            }
            if (change === 'reauthenticated') await recover(h.app);
            if (change === 'file-replaced') h.files.splice(0, 1, new PendingFile({ id: h.file.id, active: true }));
            if (change === 'db-replaced') h.file.db = { credentials: originalDb.credentials };
            if (change === 'inactive') h.file.active = false;
            if (change === 'another-writer') h.file.syncing = true;
            pending.resolve({}); await settle();
            expect(done.mock.calls).toEqual([['Sync request expired']]); expectNoSync(h, 0);
            expect(h.infos).toHaveLength(0);
        });
    }

    test('delayed setup rejection reports the error once and creates no FileInfo or writer', async () => {
        const h = syncHarness(false); const pending = deferred<Record<string, unknown>>(); const done = mock();
        h.app.getStoreOpts = mock(() => pending.promise);
        h.app.syncFile(h.real, undefined, done);
        const error = new Error('credentials options failed'); pending.reject(error); await settle();
        expect(done.mock.calls).toEqual([[error]]); expectNoSync(h, 0);
    });

    test('unchanged delayed setup starts once and persists its new FileInfo', async () => {
        const h = syncHarness(false); const pending = deferred<Record<string, unknown>>(); const done = mock();
        h.app.getStoreOpts = mock(() => pending.promise);
        h.app.syncFile(h.real, undefined, done); expectNoSync(h, 0);
        pending.resolve({}); await settle();
        expect(done.mock.calls).toEqual([[undefined]]); expect(cacheSave).toHaveBeenCalledTimes(1);
        expect(Info.created).toHaveLength(1); expect(h.infos).toHaveLength(1); expect(h.infos.save).toHaveBeenCalledTimes(1);
    });

    test('existing FileInfo path also rejects a replaced database before starting a writer', () => {
        const h = syncHarness(); const done = mock();
        // The real provider hook is a synchronous external boundary before startSync.
        beforeSync.mockImplementationOnce(() => { h.file.db = { credentials: h.file.db.credentials }; });
        h.app.syncFile(h.real, undefined, done);
        expect(done.mock.calls).toEqual([['Sync request expired']]); expectNoSync(h, 1);
    });
});


describe('cache durability ownership', () => {
    test('local import queues primary bytes before the consumer can edit and save', async () => {
        const h = model(); h.app.settings.disableOfflineStorage = true;
        let finish!: Callback;
        cacheSave.mockImplementationOnce((_id, _opts, _data, done) => { finish = done!; });
        h.app.openFile({ name: 'import', fileData: bytes }, (_err, real) => {
            expect(cacheSave).toHaveBeenCalledTimes(1);
            const file = real as unknown as PendingFile;
            file.editSeq++; file.dirty = true;
        });
        const file = PendingFile.created[0]; file.modified = false;
        file.finishOpen(); await settle();
        finish(); expect(file.dirty).toBe(true);
    });
    test('failed local import remains dirty even when optional caching is disabled', async () => {
        const h = model(); h.app.settings.disableOfflineStorage = true;
        cacheSave.mockImplementationOnce((_id, _opts, _data, done) => done?.(new Error('quota')));
        h.app.openFile({ name: 'import', fileData: bytes }, mock());
        const file = PendingFile.created[0]; file.modified = false;
        file.finishOpen(); await settle();
        expect(file.dirty).toBe(true);
        expect((file as any).syncError).toContain('Browser storage could not save');
        h.infos.push(new Info({ id: file.id, name: file.name }));
        h.app.syncFile(file as unknown as RealFile); await settle();
        expect(cacheSave).toHaveBeenCalledTimes(2);
    });
    for (const change of ['edit', 'sync', 'replace', 'close'] as const) {
        test(`late import completion cannot clear dirty after ${change}`, async () => {
            const h = model(); let finish!: Callback;
            cacheSave.mockImplementationOnce((_id, _opts, _data, done) => { finish = done!; });
            h.app.openFile({ name: 'import', fileData: bytes }, mock());
            const file = PendingFile.created[0]; file.finishOpen(); await settle();
            if (change === 'edit') file.editSeq++;
            if (change === 'sync') file.syncing = true;
            if (change === 'replace') file.db = { credentials: file.db.credentials };
            if (change === 'close') file.active = false;
            finish(); expect(file.dirty).toBe(true);
        });
    }
    test('purge excludes local, modified, dirty and syncing vaults', () => {
        const h = model();
        for (const [id, props] of Object.entries({ local: { storage: null }, modified: { modified: true },
            dirty: { dirty: true }, syncing: { syncing: true }, eligible: {} })) {
            h.infos.push(new Info({ id, storage: 'webdav', modified: false, ...props }));
            h.files.push(new PendingFile({ id, dirty: false, modified: false, ...props }));
        }
        const done = mock(); h.app.deleteAllCachedFiles(done);
        expect(cacheRemove.mock.calls.map(call => call[0])).toEqual(['eligible']);
        expect(done.mock.calls).toEqual([[undefined]]);
    });
    test('purge guard rejects a copy that became modified while database open was pending', () => {
        const h = model(); const info = new Info({ id: 'remote', storage: 'webdav', modified: false });
        h.infos.push(info);
        let guard!: () => boolean; let finish!: Callback;
        cacheRemove.mockImplementationOnce((_id, _opts, done, canRemove) => { guard = canRemove!; finish = done!; });
        const done = mock(); h.app.deleteAllCachedFiles(done);
        expect(guard()).toBe(true); info.set({ modified: true }); expect(guard()).toBe(false);
        finish(); expect(done).toHaveBeenCalledTimes(1);
    });
    test('purge aggregates transaction failures and ignores duplicate callbacks', () => {
        const h = model();
        h.infos.push(new Info({ id: 'a', storage: 'webdav' }), new Info({ id: 'b', storage: 'webdav' }));
        const error = new Error('abort');
        cacheRemove.mockImplementationOnce((_id, _opts, done) => { done?.(error); done?.(); });
        const done = mock(); h.app.deleteAllCachedFiles(done);
        expect(done.mock.calls).toEqual([[error]]);
    });
});


describe('remote cache acknowledgements', () => {
    test('a cache commit for an older edit never clears newer dirty data during upload', async () => {
        const h = syncHarness(); h.file.storage = 'webdav'; h.infos[0].set({ storage: 'webdav' });
        let finish!: Callback;
        cacheSave.mockImplementationOnce((_id, _opts, _data, done) => { finish = done!; });
        h.app.syncFile(h.real); await settle(); h.file.editSeq++;
        finish(); expect(h.file.dirty).toBe(true); expect(remoteSave).toHaveBeenCalledTimes(1);
    });
    test('a cache commit cannot clear replacement database dirtiness or start its upload', async () => {
        const h = syncHarness(); h.file.storage = 'webdav'; h.infos[0].set({ storage: 'webdav' });
        let finish!: Callback;
        cacheSave.mockImplementationOnce((_id, _opts, _data, done) => { finish = done!; });
        h.app.syncFile(h.real); await settle();
        h.file.db = { credentials: h.file.db.credentials };
        h.file.setSyncComplete.mockImplementationOnce(() => { h.file.syncing = false; return false; });
        finish(); expect(h.file.dirty).toBe(true); expect(remoteSave).not.toHaveBeenCalled();
        expect(h.infos.save).not.toHaveBeenCalled();
    });
});
