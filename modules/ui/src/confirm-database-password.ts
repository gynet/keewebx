import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { getSessionAccess } from 'comp/app/session-access';
import { t } from './i18n';

/** Existing key-only or unprotected databases keep their factors; saving never sets a password. */
export function confirmDatabasePassword(model: AppModel, file: FileModel, current: () => boolean): boolean {
    const access = getSessionAccess(model), epoch = access.epoch, db = file.db;
    const passwordHash = db.credentials.passwordHash;
    const valid = () => current() && access.state === 'open' && access.isCurrent(epoch) &&
        model.files.get(file.id) === file && file.active && file.db === db && db.credentials.passwordHash === passwordHash;
    if (!valid()) return false;
    if (!file.passwordLength && !window.confirm(t('This database has no master password. Without a required key file, anyone with its copy can open it. Continue saving or downloading with the existing credentials?'))) return false;
    return valid();
}
