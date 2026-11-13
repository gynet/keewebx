import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { getSessionAccess } from 'comp/app/session-access';
import { beginPendingOperation } from './pending-operations';

/** Register before reading/hashing. Securing captures credential versions, so it cancels publication. */
export async function runCredentialOperation(
    model: AppModel, file: FileModel, mounted: () => boolean,
    operation: (canPublish: () => boolean) => Promise<void>
): Promise<void> {
    const access = getSessionAccess(model);
    const epoch = access.epoch;
    const db = file.db;
    const credentials = db.credentials;
    const available = () => mounted() && file.active && model.files.get(file.id) === file &&
        !(file as unknown as { readOnly?: boolean }).readOnly && file.db === db && db.credentials === credentials;
    access.assertOpen(epoch);
    if (!available()) throw new Error('The vault is no longer available for this change.');
    const finish = beginPendingOperation(model, file.id);
    const canPublish = () => available() && access.state === 'open' && access.epoch === epoch;
    try { await operation(canPublish); }
    finally { finish(); }
}
