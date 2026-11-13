import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { fileSyncState } from 'comp/app/sync-scheduler';
import { hasPendingDrafts } from './pending-drafts';
import { t } from './i18n';

/** URLs can contain connection secrets; details never reveal userinfo, query or fragment. */
function displayLocation(value: string): string {
    return value.replace(/https?:\/\/[^\s]+/gi, raw => {
        try {
            const url = new URL(raw);
            url.username = ''; url.password = ''; url.search = ''; url.hash = '';
            return url.toString();
        } catch { return t('Remote location'); }
    });
}

export function DatabaseDetails({ model, file }: { model: AppModel; file: FileModel }) {
    const states = { saved: 'No pending changes', pending: 'Unsaved changes', syncing: 'Saving…',
        offline: 'Remote save pending', error: 'Save failed' };
    const state = fileSyncState(file);
    return <section aria-label={t('Database details')} style={{ overflowWrap: 'anywhere' }}>
        <dl>
            <dt>{t('Source')}</dt><dd>{file.demo ? t('Demo') : file.storage || t('Local file or new database')}</dd>
            <dt>{t('Location')}</dt><dd>{file.path ? displayLocation(file.path) : file.storage ? t('Not available') : t('External file managed by you')}</dd>
            <dt>{t('Save status')}</dt><dd>{hasPendingDrafts(file.id) ? t('Unsaved draft') : t(states[state])}</dd>
            <dt>{t('Last successful synchronization')}</dt><dd>{file.syncDate ? new Date(file.syncDate).toLocaleString() : t('Not recorded')}</dd>
            {file.syncError && <><dt>{t('Last save error')}</dt><dd>{displayLocation(String(file.syncError))}</dd></>}
        </dl>
        {!file.storage && !file.demo && <p>{t('Download KDBX to update your external copy. Browser downloads do not overwrite the original file automatically.')}</p>}
        {!file.demo && <p>{model.settings.disableOfflineStorage
            ? t('Browser storage is disabled. Keep an encrypted copy outside this browser.')
            : t('Browser storage is enabled. It is separate from your external or remote copy and can be cleared by the browser.')}</p>}
    </section>;
}
