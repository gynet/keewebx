import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { Storage } from 'storage';
import { getSessionAccess } from './session-access';
import { waitForSync } from './vault-files';
import { credentialChangeVersion } from '../../util/kdbxweb/credential-changes';

export function webDavDestination(value: string): string {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash ||
        !url.pathname.toLowerCase().endsWith('.kdbx')) {
        throw new Error('Enter an HTTP or HTTPS address ending in .kdbx, without embedded credentials or a fragment.');
    }
    return url.href;
}

export async function saveAsWebDav(model: AppModel, file: FileModel, path: string,
    opts: { user: string; password: string }, etag: string | null, signal: AbortSignal): Promise<void> {
    path = webDavDestination(path);
    const access = getSessionAccess(model), epoch = access.epoch, db = file.db;
    const credentials = db.credentials, version = credentialChangeVersion(credentials);
    const valid = () => !signal.aborted && access.state === 'open' && access.epoch === epoch &&
        model.settings.canSaveTo && model.settings.webdav && Storage.webdav.enabled &&
        !model.settings.disableOfflineStorage && Storage.cache.enabled &&
        file.active && model.files.get(file.id) === file && !file.storage && file.db === db &&
        db.credentials === credentials && credentialChangeVersion(credentials) === version &&
        !(file as FileModel & { readOnly?: boolean }).readOnly;
    await waitForSync(file, signal);
    if (!valid()) throw new Error('The local vault or session changed. Reopen Save to WebDAV.');
    if (model.fileInfos.some((info) => info.storage === 'webdav' && info.path === path)) {
        throw new Error('This destination is already in your recent vaults. Open that vault instead.');
    }
    await new Promise<void>((resolve, reject) => model.syncFile(file, {
        storage: 'webdav', path, opts, saveAs: { etag, signal }, canContinue: valid
    }, (error) => error ? reject(new Error(String(error))) : resolve()));
}
