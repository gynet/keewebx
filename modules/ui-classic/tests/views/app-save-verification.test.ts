import { beforeEach, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
// Load the actual Classic handler; unrelated views/platform imports are inert.
const alerts = { alertDisplayed: false, buttons: { ok: {} }, error: mock((_options: any) => {}) };
mock.module('framework/views/view', () => ({ View: class {} }));
mock.module('framework/events', () => ({ Events: {} }));
mock.module('comp/browser/idle-tracker', () => ({ IdleTracker: {} }));
mock.module('comp/settings/settings-manager', () => ({ SettingsManager: {} }));
mock.module('comp/ui/alerts', () => ({ Alerts: alerts }));
mock.module('const/keys', () => ({ Keys: {} }));
mock.module('models/update-model', () => ({ UpdateModel: {} }));
mock.module('comp/browser/service-worker-client', () => ({ ServiceWorkerClient: {} }));
mock.module('util/features', () => ({ Features: {} }));
mock.module('util/locale', () => ({ Locale: {} }));
mock.module('util/logger', () => ({ Logger: {} }));
mock.module('util/data/csv-parser', () => ({ CsvParser: {} }));
mock.module('views/details/details-view', () => ({ DetailsView: {} }));
mock.module('views/drag-view', () => ({ DragView: {} }));
mock.module('views/dropdown-view', () => ({ DropdownView: {} }));
mock.module('views/footer-view', () => ({ FooterView: {} }));
mock.module('views/generator-presets-view', () => ({ GeneratorPresetsView: {} }));
mock.module('views/grp-view', () => ({ GrpView: {} }));
mock.module('views/key-change-view', () => ({ KeyChangeView: {} }));
mock.module('views/list-view', () => ({ ListView: {} }));
mock.module('views/list-wrap-view', () => ({ ListWrapView: {} }));
mock.module('views/menu/menu-view', () => ({ MenuView: {} }));
mock.module('views/open-view', () => ({ OpenView: {} }));
mock.module('views/settings/settings-view', () => ({ SettingsView: {} }));
mock.module('views/tag-view', () => ({ TagView: {} }));
mock.module('views/import-csv-view', () => ({ ImportCsvView: {} }));
mock.module('views/titlebar-view', () => ({ TitlebarView: {} }));
mock.module('templates/app.hbs', () => ({ default: '' }));

const { AppView } = await import('../../app/scripts/views/app-view');
class File extends EventEmitter { active = true; dirty = true; syncing = false; syncError: string | null = null; name = 'Disposable'; }
function view(files: File[], sync: (file: File, options: unknown, done: (error?: unknown) => void) => void) {
    const instance = Object.create(AppView.prototype) as InstanceType<typeof AppView>;
    Object.assign(instance, { model: { files: Object.assign(files, { hasDirtyFiles: () => files.some((f) => f.dirty) }), syncFile: sync },
        closeAllFilesAndShowFirst: mock(() => {}) });
    return instance;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => { alerts.alertDisplayed = false; alerts.error.mockClear(); });
test('Classic lock waits for an existing verification failure and preserves the open file', async () => {
    const file = new File(); file.syncing = true;
    const sync = mock(() => {}), done = mock(); const app = view([file], sync);
    app.saveAndLock(done); await settle();
    expect(app.closeAllFilesAndShowFirst).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
    alerts.alertDisplayed = true; // Existing save-verify-failed handler has displayed its warning.
    file.syncError = 'Save verification failed'; file.syncing = false; file.emit('change:syncing'); await settle();
    expect(app.closeAllFilesAndShowFirst).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(false); expect(file.dirty).toBe(true);
    expect(file.listenerCount('change:syncing')).toBe(0);
});
test('Classic lock waits for an existing verified save before closing', async () => {
    const file = new File(); file.syncing = true;
    const sync = mock(() => {}), done = mock(); const app = view([file], sync);
    app.saveAndLock(done); await settle(); expect(app.closeAllFilesAndShowFirst).not.toHaveBeenCalled();
    file.dirty = false; file.syncing = false; file.emit('change:syncing'); await settle();
    expect(app.closeAllFilesAndShowFirst).toHaveBeenCalledTimes(1); expect(done).toHaveBeenCalledWith(true);
    expect(sync).not.toHaveBeenCalled();
});
test('Classic synchronous save rejection cannot underflow the pending count and close', async () => {
    const file = new File(); const done = mock();
    const app = view([file], (_file, _options, callback) => callback('Save failed'));
    app.saveAndLock(done); await settle();
    expect(app.closeAllFilesAndShowFirst).not.toHaveBeenCalled(); expect(alerts.error).toHaveBeenCalledTimes(1);
    alerts.error.mock.calls[0][0].complete(''); expect(done).toHaveBeenCalledWith(false);
});
test('Classic counts every vault before synchronous success callbacks run', async () => {
    const files = [new File(), new File()], done = mock();
    const sync = mock((file: File, _options: unknown, callback: (error?: unknown) => void) => { file.dirty = false; callback(); });
    const app = view(files, sync); app.saveAndLock(done); await settle();
    expect(sync).toHaveBeenCalledTimes(2); expect(app.closeAllFilesAndShowFirst).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1); expect(done).toHaveBeenCalledWith(true);
});

test('Classic successful callback cannot close edits made during verification', async () => {
    const file = new File(), done = mock();
    const app = view([file], (_file, _options, callback) => callback());
    app.saveAndLock(done); await settle();
    expect(app.closeAllFilesAndShowFirst).not.toHaveBeenCalled();
    expect(alerts.error).toHaveBeenCalledTimes(1);
    alerts.error.mock.calls[0][0].complete(''); expect(done).toHaveBeenCalledWith(false);
});

test('Classic lock admits dirty or syncing vaults even without the modified flag', () => {
    const file = new File(); file.syncing = true;
    const app = view([file], mock(() => {}));
    Object.assign(app.model, { settings: { autoSave: true } });
    Object.assign(app.model.files, { hasUnsavedFiles: () => false });
    app.saveAndLock = mock(() => {});
    app.lockWorkspace();
    expect(app.saveAndLock).toHaveBeenCalledTimes(1);
    expect(app.closeAllFilesAndShowFirst).not.toHaveBeenCalled();
});
