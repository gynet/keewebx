import type { AppModel } from 'models/app-model';
import { getSessionAccess } from './session-access';

export async function saveAndLock(appModel: AppModel, signal?: AbortSignal): Promise<void> {
    const checkActive = () => {
        if (signal?.aborted) throw new Error('Lock attempt canceled.');
    };
    checkActive();
    const pending = appModel.files.filter((file) => !file.demo && (file.dirty || file.modified));
    await Promise.all(pending.map(async (file) => {
        if (file.syncing) {
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
        if (file.dirty || file.modified) {
            checkActive();
            await new Promise<void>((resolve, reject) => {
                const abort = () => {
                    signal?.removeEventListener('abort', abort);
                    reject(new Error('Lock attempt canceled.'));
                };
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) { abort(); return; }
                try {
                    appModel.syncFile(file, { sessionEpoch: getSessionAccess(appModel).epoch }, () => {
                        signal?.removeEventListener('abort', abort);
                        resolve();
                    });
                } catch (error) {
                    signal?.removeEventListener('abort', abort);
                    reject(error);
                }
            });
        }
    }));
    // A timed-out lock may finish saving after the user has recovered their session.
    // Its late completion must never close that recovered session.
    checkActive();
    if (pending.some((file) => file.dirty)) {
        throw new Error('Changes could not be saved. Keep this vault open and try again.');
    }
    appModel.closeAllFiles();
}
