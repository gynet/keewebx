import { useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { applyDatabaseSettings, readDatabaseSettings } from 'comp/app/database-settings';
import { saveVault } from 'comp/app/vault-files';
import { DatabaseSettingsFields } from './database-settings-fields';
import { usePendingDraft } from './pending-drafts';
import { t } from './i18n';

export function DatabaseSettingsEditor({ model, file }: { model: AppModel; file: FileModel }) {
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
            applyDatabaseSettings(file, draft);
            setBaseline(JSON.stringify(draft));
            return true;
        } catch (error) { setMessage((error as Error).message); return false; }
    };
    usePendingDraft(JSON.stringify(draft) !== baseline, apply, reset, 'database');
    return <form ref={form} class="database-settings cardlist" aria-label={t('Database settings: {}', file.name)}
        onSubmit={async (event) => {
            event.preventDefault();
            if (!apply()) return;
            setBusy(true); setMessage('');
            try { await saveVault(model, file); setMessage(t('Database settings saved.')); }
            catch { setMessage(t('Changes are pending. Keep the vault open and retry saving.')); }
            finally { setBusy(false); }
        }}>
        <h3>{file.name}</h3>
        <fieldset disabled={busy}>
            <DatabaseSettingsFields value={draft} onChange={setDraft} />
            <div class="database-settings__actions">
                <button type="submit" class="pill pill--primary">{t('Save database settings')}</button>
                <button type="button" class="pill" onClick={reset}>{t('Cancel')}</button>
            </div>
        </fieldset>
        {message && <p role="status">{message}</p>}
    </form>;
}
