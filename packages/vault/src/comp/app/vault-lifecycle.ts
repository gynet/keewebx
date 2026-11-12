import type { AppModel } from 'models/app-model';

export async function saveAndLock(appModel: AppModel): Promise<void> {
    const pending = appModel.files.filter((file) => !file.demo && (file.dirty || file.modified));
    await Promise.all(pending.map(async (file) => {
        if (file.syncing) {
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
        if (file.dirty || file.modified) {
            await new Promise<void>((resolve) => appModel.syncFile(file, undefined, () => resolve()));
        }
    }));
    if (pending.some((file) => file.dirty)) {
        throw new Error('Changes could not be saved. Keep this vault open and try again.');
    }
    appModel.closeAllFiles();
}
