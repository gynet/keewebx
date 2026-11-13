import { useEffect, useState } from 'preact/hooks';
import { Events } from 'framework/events';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { getSessionAccess } from 'comp/app/session-access';
import { saveVault } from 'comp/app/vault-files';
import { beginPendingOperation } from './pending-operations';
import { savePendingDrafts } from './pending-drafts';
import { t } from './i18n';

export function SaveVerificationWarning({ model, version, suspended }: {
    model: AppModel; version: number; suspended: boolean;
}) {
    const [failed, setFailed] = useState<FileModel[]>([]);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        const onFailure = ({ file }: { file: FileModel }) => {
            if (model.files.get(file.id) === file) setFailed((current) => current.includes(file) ? current : [...current, file]);
        };
        const onVerified = ({ file }: { file: FileModel }) => setFailed((current) => current.filter((item) => item !== file));
        Events.on('save-verify-failed', onFailure);
        Events.on('save-verify-passed', onVerified);
        return () => {
            Events.off('save-verify-failed', onFailure);
            Events.off('save-verify-passed', onVerified);
        };
    }, [model]);
    useEffect(() => {
        setFailed((current) => current.filter((file) => model.files.get(file.id) === file && file.active &&
            (file.dirty || file.modified || file.syncing || !!file.syncError)));
    }, [model, version]);
    if (!failed.length) return null;
    const retry = async () => {
        if (busy || getSessionAccess(model).state !== 'open') return;
        const finish = beginPendingOperation(model);
        setBusy(true);
        try {
            savePendingDrafts();
            await Promise.allSettled(failed.map(async (file) => {
                if (model.files.get(file.id) === file && file.active) await saveVault(model, file);
            }));
        } catch { /* The warning and invalid draft remain available for correction. */ }
        finally { finish(); setBusy(false); }
    };
    return <section role="alert" aria-label={t('Save verification failed')} class="card"
        style={{ margin: '8px', padding: '12px', overflowWrap: 'anywhere' }}>
        <strong>{t('Save verification failed')}</strong>
        <p>{t('The latest changes could not be verified and have not been saved. Keep this tab open. Return to editing and retry saving.')}</p>
        <button type="button" class="pill" disabled={suspended || busy || failed.some((file) => file.syncing)}
            onClick={() => void retry()}>{t(busy ? 'Retrying…' : 'Retry saving')}</button>
    </section>;
}
