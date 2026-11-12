import { useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { applyDatabaseSettings, readDatabaseSettings } from 'comp/app/database-settings';
import { exportVault, saveVault } from 'comp/app/vault-files';
import { getSessionAccess } from 'comp/app/session-access';
import { DatabaseSettingsFields } from './database-settings-fields';
import { savePendingDrafts, usePendingDraft } from './pending-drafts';
import { t } from './i18n';

export function DatabaseSettingsEditor({ model, file, onCancel }: { model: AppModel; file: FileModel; onCancel: () => void }) {
    const [draft, setDraft] = useState(() => readDatabaseSettings(file));
    const [baseline, setBaseline] = useState(() => JSON.stringify(draft));
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const form = useRef<HTMLFormElement>(null);
    const reset = () => {
        const current = readDatabaseSettings(file);
        setDraft(current); setBaseline(JSON.stringify(current)); setMessage('');
    };
    const apply = () => {
        try {
            if (!form.current?.checkValidity()) throw new Error('Please correct the invalid settings.');
            if (JSON.stringify(readDatabaseSettings(file)) !== baseline) {
                throw new Error('This database changed while you were editing. Cancel to reload its settings before editing again.');
            }
            applyDatabaseSettings(file, draft);
            setBaseline(JSON.stringify(draft));
            return true;
        } catch (error) { setMessage((error as Error).message); return false; }
    };
    usePendingDraft(JSON.stringify(draft) !== baseline, apply, reset, 'database');
    const download = async () => {
        if (busy) return;
        // Validate before taking the snapshot; a download must include visible edits.
        if (!form.current?.reportValidity()) {
            setMessage(t('Resolve invalid settings before downloading.'));
            return;
        }
        try { savePendingDrafts(); }
        catch { setMessage(t('Resolve invalid or conflicting edits before downloading.')); return; }
        setBusy(true); setMessage('');
        try {
            const access = getSessionAccess(model);
            const epoch = access.epoch;
            access.assertOpen(epoch);
            const data = await exportVault(file);
            access.assertOpen(epoch);
            const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = `${file.name.replace(/\.kdbx$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'vault'}.kdbx`;
            document.body.appendChild(link);
            try { link.click(); }
            finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
            setMessage(t('Encrypted download started. This does not confirm remote synchronization.'));
        } catch {
            setMessage(t('Could not export the database. Keep the vault open and retry.'));
        } finally { setBusy(false); }
    };
    return <form ref={form} class="database-settings cardlist" aria-label={t('Database settings: {}', file.name)}
        onSubmit={async (event) => {
            event.preventDefault();
            if (!apply()) return;
            setBusy(true); setMessage('');
            try { await saveVault(model, file); setMessage(t('Database settings saved.')); }
            catch { setMessage(t('Changes are pending. Keep the vault open and retry saving.')); }
            finally { setBusy(false); }
        }}>
        <h3 style={{ overflowWrap: 'anywhere' }}>{file.name}</h3>
        <fieldset disabled={busy}>
            <DatabaseSettingsFields value={draft} onChange={setDraft} />
            <div class="database-settings__actions">
                <button type="submit" class="pill pill--primary">{t('Save database settings')}</button>
                <button type="button" class="pill" onClick={download}>{t('Download KDBX')}</button>
                <button type="button" class="pill" onClick={onCancel}>{t('Cancel')}</button>
            </div>
        </fieldset>
        {message && <p role="status">{message}</p>}
    </form>;
}
