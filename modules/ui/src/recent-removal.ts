import type { AppModel } from 'models/app-model';
import { Storage } from 'storage';
import { getSessionAccess } from 'comp/app/session-access';

/** Keep the recent record until the encrypted cache deletion commits. */
export async function removeRecent(model: AppModel, id: string): Promise<void> {
    const info = model.fileInfos.get(id);
    const access = getSessionAccess(model), epoch = access.epoch;
    const current = () => !!info && model.fileInfos.get(id) === info && model.settings.canRemoveLatest &&
        access.state === 'open' && access.isCurrent(epoch) && !model.files.get(id)?.active;
    if (!current()) throw new Error('The vault changed. Select it again before removing it.');
    await new Promise<void>((resolve, reject) => {
        Storage.cache.remove(id, null, error => {
            if (error) reject(error);
            else if (!current()) reject(new Error('The vault changed during removal. Check its local copy before retrying.'));
            else resolve();
        }, current);
    });
    if (!current()) throw new Error('The vault changed during removal. Check its local copy before retrying.');
    model.fileInfos.remove(id);
    model.fileInfos.save();
}
