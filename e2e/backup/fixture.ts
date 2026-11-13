// Registered provider fixture: production UI and shared backup pipeline, real HTTP storage.
import { registerStorage } from 'hooks/data-registry';
import { AppModel } from 'models/app-model';
import { Storage } from 'storage';
import { storeBackup } from 'comp/app/vault-backup';
registerStorage('backup-fixture', () => ({
    name: 'backup-fixture', enabled: true, backup: true, system: false,
    init() {}, getPathForName: (path: string) => path,
    stat(path: string, _opts: unknown, done: (error?: unknown) => void) {
        fetch('/backup-api/' + encodeURIComponent(path), { method: 'HEAD' }).then(response => done(response.ok ? undefined : new Error('Stat failed')), done);
    },
    save(path: string, opts: unknown, data: ArrayBuffer, done: (error?: unknown) => void) {
        fetch('/backup-api/' + encodeURIComponent(path), { method: 'PUT', body: data,
            headers: { 'X-Backup-Account': 'fixture-account', 'X-Backup-Options': JSON.stringify(opts ?? null) } })
            .then(response => done(response.ok ? undefined : new Error('Backup HTTP failure')), done);
    }
}));
Object.assign(window, { backupFixture: {
    primaryOptions() { AppModel.instance.files[0].opts = { user: 'primary-user', password: 'primary-credential-never-forward' }; },
    disableProvider() { (Storage['backup-fixture'] as { enabled: boolean }).enabled = false; },
    unsupported() { const model = AppModel.instance, file = model.files[0]; storeBackup(model, file.id,
        { enabled: true, storage: 'webdav', path: '/preserved-backup.kdbx', schedule: '1w', lastTime: 42 }); },
    stats() { const file = AppModel.instance.files[0]; return { storage: file.storage, path: file.path, dirty: file.dirty,
        modified: file.modified, backup: file.backup }; }
} });
void import('../../modules/ui/src/index');
