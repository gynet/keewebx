import { ProtectedValue } from 'kdbxweb';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';

/** Wait for the existing writer before starting another explicit save. */
async function waitForSync(file: FileModel): Promise<void> {
    if (!file.syncing) return;
    await new Promise<void>((resolve) => {
        const finished = () => {
            if (!file.syncing) {
                file.off('change:syncing', finished);
                resolve();
            }
        };
        file.on('change:syncing', finished);
        finished();
    });
}

export async function saveVault(model: AppModel, file: FileModel): Promise<void> {
    await waitForSync(file);
    await new Promise<void>((resolve, reject) => model.syncFile(file, undefined,
        (error) => error ? reject(new Error(String(error))) : resolve()));
}

export async function createVault(model: AppModel, name: string, password: string): Promise<FileModel> {
    name = name.trim().replace(/\.kdbx$/i, '');
    if (!name || !password) throw new Error('A name and master password are required.');
    if (!model.settings.canCreate) throw new Error('Creating vaults is disabled.');
    const file = await new Promise<FileModel>((resolve) => {
        model.createNewFile(name, (created) => {
            created.setPassword(ProtectedValue.fromString(password));
            resolve(created);
        });
    });
    await saveVault(model, file);
    return file;
}

/** Export uses the same KDBX serializer as synchronization. It does not mark unsynced changes saved. */
export async function exportVault(file: FileModel): Promise<ArrayBuffer> {
    await waitForSync(file);
    return new Promise((resolve, reject) => file.getData((data, error) =>
        data ? resolve(data) : reject(new Error(String(error || 'Unable to export vault')))));
}
