import type { AppModel } from 'models/app-model';

/** Periodic sync also checks for remote changes when the local file is clean. */
export function startPeriodicSync(model: AppModel): () => void {
    let timer: ReturnType<typeof setInterval> | undefined;
    const configure = () => {
        clearInterval(timer);
        const minutes = model.settings.autoSaveInterval;
        if (Number.isFinite(minutes) && minutes > 0) {
            timer = setInterval(() => {
                for (const file of model.files) {
                    if (file.active && !file.demo && !file.syncing) model.syncFile(file);
                }
            }, minutes * 60_000);
        }
    };
    model.settings.on('change:autoSaveInterval', configure);
    configure();
    return () => {
        clearInterval(timer);
        model.settings.off('change:autoSaveInterval', configure);
    };
}
