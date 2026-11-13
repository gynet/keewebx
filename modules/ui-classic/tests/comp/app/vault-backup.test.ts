import { beforeEach, expect, mock, test } from 'bun:test';
import { Credentials, ProtectedValue } from 'kdbxweb';
// Isolated process: storage boundaries are controlled, backup/session code stays real.
const providers: Record<string, any> = {};
let persisted: any, failPersistence = false;
mock.module('storage', () => ({ Storage: providers }));
mock.module('comp/settings/settings-store', () => ({ SettingsStore: { saveRequired: (_key: string, data: unknown) => {
    if (failPersistence) throw new Error('Quota'); persisted = JSON.parse(JSON.stringify(data));
} } }));
mock.module('comp/i18n/date-format', () => ({ DateFormat: { dtStrFs: (date: Date) => date.toISOString().slice(0, 10) } }));
const { backupFile, scheduleBackupFile, backupDue, backupProviders, storeBackup } = await import('../../../../vault/src/comp/app/vault-backup');
const { getSessionAccess } = await import('../../../../vault/src/comp/app/session-access');
type Done = (error?: unknown) => void;
let stat: Done, mkdir: Done, save: Done, writes: { path: string; opts: any; bytes: ArrayBuffer }[];
let file: any, model: any, info: any;
const bytes = new Uint8Array([3, 217, 162, 154, 103, 251, 75, 181]).buffer;
beforeEach(() => {
    for (const key of Object.keys(providers)) delete providers[key];
    failPersistence = false; persisted = undefined; writes = [];
    providers.backups = { enabled: true, backup: true, name: 'backups',
        stat: (_path: string, _opts: unknown, done: Done) => { stat = done; },
        mkdir: (_path: string, done: Done) => { mkdir = done; },
        save: (path: string, opts: unknown, data: ArrayBuffer, done: Done) => { writes.push({ path, opts, bytes: data }); save = done; } };
    providers.webdav = { enabled: true, backup: false, save: mock(() => {}) };
    file = { id: 'one', active: true, demo: false, editSeq: 1, dirty: true, modified: true,
        storage: 'webdav', path: '/primary.kdbx', opts: { user: 'primary-user', password: 'primary-secret' },
        db: { credentials: new Credentials(ProtectedValue.fromString('database-password')) },
        backup: { enabled: true, storage: 'backups', path: '/copies/vault.{date}.kdbx', schedule: '' } };
    info = { id: file.id, backup: file.backup };
    const files: any = [file]; files.get = (id: string) => files.find((value: any) => value.id === id);
    const infos: any = [info]; infos.get = (id: string) => infos.find((value: any) => value.id === id);
    model = { files, fileInfos: infos, settings: { canSaveTo: true } };
});
function start(options?: any) { const done = mock((_error?: unknown) => {}); backupFile(model, file, bytes, done, options); return done; }
test('only explicitly capable enabled providers are offered; unsupported config is retained', () => {
    expect(backupProviders().map(([name]) => name)).toEqual(['backups']);
    const original = { ...file.backup, storage: 'webdav' }; file.backup = original;
    const done = start(); expect(done.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(file.backup).toBe(original); expect(providers.webdav.save).not.toHaveBeenCalled();
    providers.backups.enabled = false; expect(backupProviders()).toHaveLength(0);
});
test('manual, unknown and disabled schedules never start their first automatic backup', () => {
    for (const schedule of ['', 'unexpected']) { file.backup.schedule = schedule; scheduleBackupFile(model, file, bytes); }
    expect(writes).toHaveLength(0); expect(file.backup.lastTime).toBeUndefined();
    expect(backupDue({ enabled: false, schedule: '0' })).toBe(false);
    expect(backupDue({ enabled: true, schedule: '0' })).toBe(true);
});
test('daily weekly monthly due boundaries and first scheduled save', () => {
    const now = new Date('2026-03-15T12:00:00Z').getTime();
    for (const [schedule, previous] of [['1d', '2026-03-14'], ['1w', '2026-03-08'], ['1m', '2026-02-15']]) {
        expect(backupDue({ enabled: true, schedule }, now)).toBe(true);
        const lastTime = new Date(previous + 'T12:00:00Z').getTime();
        expect(backupDue({ enabled: true, schedule, lastTime }, now)).toBe(true);
        expect(backupDue({ enabled: true, schedule, lastTime: lastTime + 1 }, now)).toBe(false);
    }
});
test('backup bytes are detached and primary credentials never cross provider boundaries', () => {
    for (const storage of ['webdav', 'backups']) {
        file.storage = storage; const done = start(); stat();
        const sent = writes.at(-1)!; expect(sent.opts).toBeUndefined(); expect(sent.bytes).not.toBe(bytes);
        expect(new Uint8Array(sent.bytes)).toEqual(new Uint8Array(bytes)); save(); expect(done).toHaveBeenCalledWith(undefined);
    }
    expect(file.opts.password).toBe('primary-secret'); expect(file.dirty).toBe(true); expect(file.modified).toBe(true);
    expect(file.backup.lastTime).toBeGreaterThan(0); expect(persisted[0].backup.lastTime).toBe(file.backup.lastTime);
});
test('explicit backup options are copied and never taken from primary file', () => {
    file.backup.opts = { account: 'destination' }; start(); stat();
    expect(writes[0].opts).toEqual({ account: 'destination' }); expect(writes[0].opts).not.toBe(file.backup.opts); save();
});
test('duplicate stat and mkdir callbacks cannot write twice', () => {
    const done = start(); stat({ notFound: true }); stat({ notFound: true }); mkdir(); mkdir();
    expect(writes).toHaveLength(1); save(); save(new Error('duplicate')); expect(done).toHaveBeenCalledTimes(1);
});
for (const phase of ['stat', 'mkdir', 'save']) test(`configuration replacement during ${phase} rejects late completion`, () => {
    const done = start();
    if (phase !== 'stat') stat({ notFound: true });
    if (phase === 'save') mkdir();
    file.backup = { ...file.backup, path: '/new-destination.kdbx' };
    if (phase === 'stat') stat(); else if (phase === 'mkdir') mkdir(); else save();
    expect(writes.length).toBe(phase === 'save' ? 1 : 0); expect(done.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(file.backup.lastTime).toBeUndefined(); expect(persisted).toBeUndefined();
});
for (const change of ['closed', 'db', 'credentials', 'epoch', 'provider']) test(`late provider callback after ${change} cannot publish success`, () => {
    const done = start(); stat();
    if (change === 'closed') file.active = false;
    if (change === 'db') file.db = { ...file.db };
    if (change === 'credentials') file.db.credentials = new Credentials(ProtectedValue.fromString('replacement'));
    if (change === 'epoch') getSessionAccess(model).beginSecuring();
    if (change === 'provider') providers.backups.enabled = false;
    save(); expect(done.mock.calls[0][0]).toBeInstanceOf(Error); expect(persisted).toBeUndefined();
});
test('cancel is exactly once; delayed save cannot mark a backup successful', () => {
    const controller = new AbortController(); const done = start({ signal: controller.signal }); stat();
    controller.abort(); save(); expect(done).toHaveBeenCalledTimes(1); expect(file.backup.lastTime).toBeUndefined();
});
test('failed transport preserves last success and primary save flags; scheduled errors do not throw', () => {
    file.backup.lastTime = 42; file.backup.schedule = '0'; scheduleBackupFile(model, file, bytes); stat(); save(new Error('Network'));
    expect(file.backup.lastTime).toBe(42); expect(file.backup.lastError).toContain('failed'); expect(file.backup.pending).toBe(true);
    expect(file.dirty).toBe(true); expect(file.modified).toBe(true);
    providers.backups.stat = () => { throw new Error('provider throw'); };
    expect(() => scheduleBackupFile(model, file, bytes)).not.toThrow();
});
test('concurrent scheduled save does not overlap transport or clear newer pending changes', () => {
    file.backup.schedule = '0'; scheduleBackupFile(model, file, bytes); stat();
    scheduleBackupFile(model, file, bytes); expect(writes).toHaveLength(1); save(); expect(file.backup.pending).toBe(true);
});
test('primary path cannot be overwritten and unavailable settings storage cannot report success', () => {
    file.storage = 'backups'; file.path = file.backup.path.replace('{date}', new Date().toISOString().slice(0, 10));
    const done = start(); expect(writes).toHaveLength(0); expect(done.mock.calls[0][0]).toBeInstanceOf(Error);
    const previous = info.backup; failPersistence = true;
    expect(() => storeBackup(model, file.id, { ...file.backup, enabled: false })).toThrow('Quota'); expect(info.backup).toBe(previous);
    file.path = '/primary'; const failed = start(); stat(); save();
    expect(failed.mock.calls[0][0]).toBeInstanceOf(Error); expect(file.backup.lastTime).toBeUndefined();
    expect(file.backup.lastError).toContain('status could not be saved');
});
test('timeout completes once without accepting a later provider success', () => {
    const original = globalThis.setTimeout; let deadline!: () => void;
    globalThis.setTimeout = ((callback: () => void, milliseconds: number) => {
        deadline = callback; return original(callback, milliseconds);
    }) as typeof setTimeout;
    let done: ReturnType<typeof start>;
    try { done = start(); } finally { globalThis.setTimeout = original; }
    stat(); deadline(); save();
    expect(done!).toHaveBeenCalledTimes(1); expect(done!.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(file.backup.lastTime).toBeUndefined(); expect(file.backup.lastError).toContain('timed out');
});
