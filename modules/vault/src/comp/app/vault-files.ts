import { ProtectedValue } from 'kdbxweb';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { applyDatabaseSettings, validateDatabaseSettings, type DatabaseSettings } from './database-settings';
import { createExportSnapshot } from '../../util/kdbxweb/export-snapshot';
import { credentialChangeVersion, waitForCredentialChanges } from '../../util/kdbxweb/credential-changes';

/** Wait for the existing writer before starting another explicit save. */
export async function waitForSync(file: FileModel, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Lock attempt canceled.');
    if (!file.syncing) return;
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            file.off('change:syncing', finished);
            signal?.removeEventListener('abort', abort);
        };
        const abort = () => { cleanup(); reject(new Error('Lock attempt canceled.')); };
        const finished = () => {
            if (!file.syncing) {
                cleanup();
                resolve();
            }
        };
        file.on('change:syncing', finished);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        finished();
    });
}

export async function saveVault(model: AppModel, file: FileModel): Promise<void> {
    await waitForSync(file);
    await new Promise<void>((resolve, reject) => model.syncFile(file, undefined,
        (error) => error ? reject(new Error(String(error))) : resolve()));
}

export async function createVault(
    model: AppModel, name: string, password: string, settings?: DatabaseSettings,
    onCreated?: (file: FileModel) => void
): Promise<FileModel> {
    name = name.trim().replace(/\.kdbx$/i, '');
    if (!name || !password) throw new Error('A name and master password are required.');
    if (!model.settings.canCreate) throw new Error('Creating vaults is disabled.');
    if (settings) validateDatabaseSettings(settings);
    const file = await new Promise<FileModel>((resolve, reject) => {
        model.createNewFile(name, (created) => {
            created.setPassword(ProtectedValue.fromString(password));
            if (settings) applyDatabaseSettings(created, { ...settings, name });
            resolve(created);
        }, reject);
    });
    // Retain the admitted model even if its initial save fails, so UI retries save
    // this vault instead of creating another database with the same name.
    onCreated?.(file);
    await saveVault(model, file);
    return file;
}

/**
 * Export a point-in-time encrypted copy of the current model, including unsynced changes.
 * No cache/network I/O, cleanup of live history, or saved-state changes occur here.
 * UI callers must apply/validate their drafts before invoking this helper.
 */
export async function exportVault(file: FileModel): Promise<ArrayBuffer> {
    for (;;) {
        if (!file.active) throw new Error('Cannot export a closed vault.');
        const db = file.db;
        const credentials = db.credentials;
        const version = credentialChangeVersion(credentials);
        await waitForCredentialChanges(credentials);
        if (!file.active) throw new Error('Cannot export a closed vault.');
        // A remote refresh may replace the database while credentials are awaited.
        if (db !== file.db || credentials !== db.credentials || version !== credentialChangeVersion(credentials)) continue;
        const snapshot = createExportSnapshot(db);
        const data = await snapshot.save();
        if (!file.active || file.db !== db) throw new Error('The vault changed or closed during export. Retry exporting.');
        return data;
    }
}
