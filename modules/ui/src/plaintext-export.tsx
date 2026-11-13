import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { exportPlaintext, type PlaintextFormat } from 'comp/app/vault-formats';
import { hasPendingDrafts } from './pending-drafts';
import { t } from './i18n';

export function PlaintextExport({ model, file, disabled }: { model: AppModel; file: FileModel; disabled: boolean }) {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const generation = useRef(0);
    useEffect(() => () => { generation.current++; }, []);
    const download = async (format: PlaintextFormat) => {
        if (disabled || busy) return;
        if (hasPendingDrafts()) { setMessage(t('Apply or discard unsaved edits before exporting.')); return; }
        if (!window.confirm(t('Export unencrypted {}? This file will expose passwords and other secrets to anyone who can read it.', format.toUpperCase()))) return;
        const version = ++generation.current;
        const assert = () => {
            if (version !== generation.current || hasPendingDrafts()) throw new Error('Export canceled or edits changed.');
        };
        setBusy(true); setMessage('');
        try {
            const data = await exportPlaintext(model, file, format, assert);
            assert();
            const url = URL.createObjectURL(new Blob([data], { type: format === 'xml' ? 'application/xml;charset=utf-8' : 'text/html;charset=utf-8' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = `${file.name.replace(/\.kdbx$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'vault'}.${format}`;
            document.body.appendChild(link);
            try { link.click(); }
            finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
            setMessage(t('Unencrypted download started. Store it securely.'));
        } catch { if (version === generation.current) setMessage(t('Export canceled or unavailable. Resolve edits and try again.')); }
        finally { if (version === generation.current) setBusy(false); }
    };
    if (!model.settings.canSaveTo) return null;
    return <div class="cardlist" aria-label={t('Plaintext export')}>
        <p>{t('XML preserves groups, protected-field markers, history and attachments. HTML is a readable copy without history or trash. Both expose secrets without encryption.')}</p>
        <div class="database-settings__actions">
            {model.settings.canExportXml && <button type="button" class="pill" disabled={disabled || busy} onClick={() => download('xml')}>{t('Export XML')}</button>}
            {model.settings.canExportHtml && <button type="button" class="pill" disabled={disabled || busy} onClick={() => download('html')}>{t('Export HTML')}</button>}
            {busy && <button type="button" class="pill" onClick={() => { ++generation.current; setBusy(false); setMessage(t('Export canceled.')); }}>{t('Cancel export')}</button>}
        </div>
        {message && <p role="status">{message}</p>}
    </div>;
}
