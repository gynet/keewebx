import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { Storage } from 'storage';
import { SettingsStore } from 'comp/settings/settings-store';
import { DateFormat } from 'comp/i18n/date-format';
import { UrlFormat } from 'util/formatting/url-format';
import { getSessionAccess } from './session-access';
import { credentialChangeVersion } from '../../util/kdbxweb/credential-changes';

export interface BackupSettings extends Record<string, unknown> {
    enabled?: boolean;
    storage?: string;
    path?: string;
    schedule?: string;
    opts?: Record<string, unknown>;
    lastTime?: number;
    lastError?: string;
    pending?: boolean;
}
export interface BackupProvider {
    enabled?: boolean;
    backup?: boolean;
    name?: string;
    getPathForName?(path: string): string;
    stat?(path: string, opts: Record<string, unknown> | undefined, done: (error?: unknown) => void): void;
    mkdir?(path: string, done: (error?: unknown) => void): void;
    save(path: string, opts: Record<string, unknown> | undefined, data: ArrayBuffer, done: (error?: unknown) => void): void;
}
export const backupSchedules = ['', '0', '1d', '1w', '1m'] as const;
export function backupProviders(): [string, BackupProvider][] {
    return Object.entries(Storage as Record<string, BackupProvider>).filter(([, provider]) =>
        provider?.enabled === true && provider.backup === true && typeof provider.save === 'function');
}
export function readBackup(file: FileModel): BackupSettings { return (file.backup ?? {}) as BackupSettings; }
const configuration = (backup: BackupSettings) => JSON.stringify([backup.enabled, backup.storage, backup.path, backup.schedule, backup.opts]);
export function validateBackup(backup: BackupSettings): void {
    if (!backup.enabled) return;
    if (!backupProviders().some(([name]) => name === backup.storage)) throw new Error('The configured backup provider is unavailable or does not support backups.');
    if (typeof backup.path !== 'string' || !backup.path.trim() || /[\x00-\x1f\x7f]/.test(backup.path)) throw new Error('Enter a valid backup path.');
    if (!(backupSchedules as readonly unknown[]).includes(backup.schedule ?? '')) throw new Error('Choose a supported backup schedule.');
}

/** Persist the complete recent list before claiming that a backup preference/status was saved. */
export function storeBackup(model: AppModel, fileId: string, backup: BackupSettings): void {
    const info = model.fileInfos.get(fileId);
    if (!info) throw new Error('The recent vault record is unavailable.');
    const next = JSON.parse(JSON.stringify(backup)) as BackupSettings;
    const records = model.fileInfos.map(item => ({ ...JSON.parse(JSON.stringify(item)), ...(item.id === fileId ? { backup: next } : {}) }));
    SettingsStore.saveRequired('file-info', records);
    info.backup = next;
    const file = model.files.get(fileId);
    if (file) file.backup = next;
}

export function backupDue(backup: BackupSettings, now = Date.now()): boolean {
    // Manual and unknown schedules never run implicitly, including their first save.
    if (!backup.enabled || !['0', '1d', '1w', '1m'].includes(backup.schedule ?? '')) return false;
    if (backup.schedule === '0' || !backup.lastTime) return true;
    const next = new Date(backup.lastTime);
    if (backup.schedule === '1d') next.setDate(next.getDate() + 1);
    else if (backup.schedule === '1w') next.setDate(next.getDate() + 7);
    else next.setMonth(next.getMonth() + 1);
    return next.getTime() <= now;
}

const running = new WeakMap<FileModel, object>();
const revisions = new WeakMap<FileModel, number>();
export interface BackupAttemptOptions { canPublish?: () => boolean; signal?: AbortSignal; }

/** A provider acknowledgement confirms a copy, never a primary save or a successful lock. */
export function backupFile(model: AppModel, file: FileModel, data: ArrayBuffer, callback: (error?: unknown) => void, options: BackupAttemptOptions = {}): void {
    const backup = { ...readBackup(file) };
    const access = getSessionAccess(model), epoch = access.epoch, db = file.db;
    const credentials = db?.credentials, credentialVersion = credentials && credentialChangeVersion(credentials);
    const signature = configuration(backup), revision = revisions.get(file) ?? 0, editSeq = file.editSeq;
    const provider = backupProviders().find(([name]) => name === backup.storage)?.[1];
    const current = () => file.active && !file.demo && model.files.get(file.id) === file && file.db === db
        && db.credentials === credentials && credentialChangeVersion(credentials) === credentialVersion
        && access.state === 'open' && access.isCurrent(epoch) && model.settings.canSaveTo !== false
        && configuration(readBackup(file)) === signature && options.canPublish?.() !== false
        && !options.signal?.aborted && provider?.enabled === true && provider.backup === true
        && Storage[backup.storage!] === provider;
    if (running.has(file)) { callback(new Error('A backup is already in progress.')); return; }
    try { validateBackup(backup); if (!backup.enabled || !current()) throw new Error('The vault or backup configuration is no longer available.'); }
    catch (error) { callback(error); return; }
    const token = {}; running.set(file, token);
    let complete = false, timer: ReturnType<typeof setTimeout>;
    const finish = (error?: unknown, written = false) => {
        if (complete) return;
        complete = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
        if (running.get(file) === token) running.delete(file);
        const valid = current();
        if (!valid) error = new Error('Backup interrupted. A remote copy may exist; its completion was not recorded.');
        if (valid) {
            const next = { ...readBackup(file), pending: !!error || revision !== (revisions.get(file) ?? 0) || editSeq !== file.editSeq };
            if (error) next.lastError = 'Backup failed or timed out. The primary vault save is unchanged. Check the destination before retrying.';
            else { next.lastTime = Date.now(); delete next.lastError; }
            try { storeBackup(model, file.id, next); }
            catch {
                error = new Error(written ? 'The backup was written, but its status could not be saved on this device.' : 'Backup status could not be saved on this device.');
                file.backup = { ...readBackup(file), lastError: (error as Error).message, pending: true };
            }
        }
        callback(error);
    };
    const abort = () => finish(new Error('Backup canceled. A remote copy may exist.'));
    const guarded = (action: () => void) => {
        if (complete) return;
        if (!current()) { finish(new Error('Backup interrupted.')); return; }
        try { action(); } catch (error) { finish(error); }
    };
    timer = setTimeout(() => finish(new Error('Backup timed out.')), 30_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    // Never forward primary-file options, even for the same provider. Destination
    // options must be explicitly configured; account-backed providers own their auth.
    guarded(() => {
        const opts = backup.opts ? JSON.parse(JSON.stringify(backup.opts)) : undefined;
        const bytes = data.slice(0);
        let path = backup.path!.replace(/\{date\}/g, DateFormat.dtStrFs(new Date()));
        if (provider!.getPathForName) path = provider!.getPathForName(path);
        // A backup must never overwrite the active primary destination.
        if (backup.storage === file.storage && path === file.path) throw new Error('Choose a backup path different from the primary vault.');
        const save = () => guarded(() => provider!.save(path, opts, bytes, error => {
            if (complete) return;
            finish(error, !error);
        }));
        const folder = UrlFormat.fileToDir(path);
        if (!provider!.stat || !folder) { save(); return; }
        let statDone = false;
        provider!.stat(folder, opts, error => {
            if (statDone) return; statDone = true;
            guarded(() => {
                if (!error) { save(); return; }
                if (!(error as { notFound?: boolean }).notFound || !provider!.mkdir) { finish(error); return; }
                let mkdirDone = false;
                provider!.mkdir(folder, error => {
                    if (mkdirDone) return; mkdirDone = true;
                    guarded(() => { if (error) finish(error); else save(); });
                });
            });
        });
    });
}

export function scheduleBackupFile(model: AppModel, file: FileModel, data: ArrayBuffer): void {
    const backup = readBackup(file), db = file.db, access = getSessionAccess(model), epoch = access.epoch;
    if (!backup.enabled || !file.active || file.demo) return;
    revisions.set(file, (revisions.get(file) ?? 0) + 1);
    // Backup errors must never escape into the already-completed primary save.
    try {
        storeBackup(model, file.id, { ...backup, pending: true });
        if (!backupDue(backup) || running.has(file)) return;
        backupFile(model, file, data, error => {
            // Admission/configuration failures do not pass through the transport
            // completion path. Show them without recording a successful backup.
            if (error && file.active && model.files.get(file.id) === file && file.db === db && access.state === 'open' && access.isCurrent(epoch) && configuration(readBackup(file)) === configuration(backup) && !readBackup(file).lastError) {
                try { storeBackup(model, file.id, { ...readBackup(file), pending: true, lastError: 'Automatic backup did not complete. Check provider availability and retry.' }); }
                catch { file.backup = { ...readBackup(file), pending: true, lastError: 'Backup status could not be saved on this device.' }; }
            }
        });
    } catch { file.backup = { ...backup, pending: true, lastError: 'Backup settings could not be saved on this device.' }; }
}
