import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { getSessionAccess } from 'comp/app/session-access';
import { waitForSync } from 'comp/app/vault-files';
import { beginPendingOperation, waitForPendingOperations } from './pending-operations';
import { hasPendingDrafts, savePendingDrafts } from './pending-drafts';
import { t } from './i18n';

/** Persist without dismissing the template editor or losing its recovery baseline. */
export function TemplatePersistence({ model, file, onCloseVault }: {
    model: AppModel; file: FileModel; onCloseVault?(file: FileModel): void;
}) {
    const mounted = useRef(true);
    const operation = useRef<AbortController | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    useEffect(() => () => { mounted.current = false; operation.current?.abort(); }, []);
    const save = async () => {
        const access = getSessionAccess(model);
        if (operation.current || access.state !== 'open' || !file.active) return;
        const epoch = access.epoch, db = file.db;
        const controller = new AbortController(); operation.current = controller;
        const unsubscribe = access.subscribeInvalidation(() => controller.abort());
        const finish = beginPendingOperation(model, file.id);
        const timer = setTimeout(() => controller.abort(), 15_000);
        const check = () => {
            access.assertOpen(epoch);
            if (controller.signal.aborted || !file.active || model.files.get(file.id) !== file || file.db !== db) throw new Error(t('Saving was canceled.'));
        };
        setBusy(true); setError(''); setMessage('');
        try {
            await waitForPendingOperations(model, controller.signal, file.id, finish);
            await waitForSync(file, controller.signal); check();
            if (!file.demo && !file.storage && model.settings.disableOfflineStorage) throw new Error(t('Browser storage is disabled. Enable storage or download an encrypted copy before closing.'));
            savePendingDrafts(file.id, true);
            await new Promise<void>((resolve, reject) => {
                const abort = () => { cleanup(); reject(new Error(t('Saving timed out or was canceled. Your changes remain open.'))); };
                const cleanup = () => controller.signal.removeEventListener('abort', abort);
                controller.signal.addEventListener('abort', abort, { once: true });
                if (controller.signal.aborted) { abort(); return; }
                try {
                    model.syncFile(file, { canContinue: () => !controller.signal.aborted && access.state === 'open' && access.isCurrent(epoch) && file.active && file.db === db }, error => {
                        cleanup(); error ? reject(new Error(String(error))) : resolve();
                    });
                } catch (error) { cleanup(); reject(error); }
            }); check();
            if (file.dirty || file.modified || hasPendingDrafts(file.id)) throw new Error(t('Changes are still pending. Keep this vault open and retry saving.'));
            setMessage(t('Vault saved. You can keep editing.'));
        } catch (error) {
            if (mounted.current && access.state === 'open' && access.isCurrent(epoch)) setError(error instanceof Error ? error.message : t('Could not save this vault. Your changes remain open.'));
        } finally {
            clearTimeout(timer); unsubscribe(); finish(); operation.current = null;
            if (mounted.current) setBusy(false);
        }
    };
    return <section aria-label={t('Template vault persistence')}>
        <p>{t('Save the vault without leaving this editor, or save and close this vault.')}</p>
        <button class="pill" type="button" disabled={busy || file.syncing} onClick={() => void save()}>{t('Save vault and keep editing')}</button>
        {onCloseVault && <button class="pill" type="button" disabled={busy} onClick={() => onCloseVault(file)}>{t('Close template vault…')}</button>}
        {busy && <p role="status">{t('Saving…')}</p>}
        {message && <p role="status">{message}</p>}
        {error && <p role="alert">{error}</p>}
    </section>;
}
