import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { Storage } from 'storage';
import { getSessionAccess } from 'comp/app/session-access';
import { saveVault, waitForSync } from 'comp/app/vault-files';
import { saveAsWebDav, webDavDestination } from 'comp/app/webdav-save-as';
import { beginPendingOperation, waitForPendingOperations } from './pending-operations';
import { savePendingDrafts } from './pending-drafts';
import { PromptDialog } from './extension-prompts';
import { t } from './i18n';

export function WebDavSaveAs({ model, file }: { model: AppModel; file: FileModel }) {
    const [open, setOpen] = useState(false), [message, setMessage] = useState('');
    return <>
        {!file.storage && !file.demo && !(file as FileModel & { readOnly?: boolean }).readOnly &&
            model.settings.canSaveTo && model.settings.webdav && Storage.webdav.enabled &&
            <button type="button" class="pill" onClick={() => { setMessage(''); setOpen(true); }}>{t('Save to WebDAV')}</button>}
        {message && <p role="status">{message}</p>}
        {open && <SaveDestination model={model} file={file} close={(result) => { setOpen(false); setMessage(result ?? ''); }} />}
    </>;
}

function SaveDestination({ model, file, close }: { model: AppModel; file: FileModel; close(message?: string): void }) {
    const [url, setUrl] = useState(''), [user, setUser] = useState(''), [password, setPassword] = useState('');
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const [inspected, setInspected] = useState<{ path: string; etag: string | null } | null>(null);
    const operation = useRef<AbortController | null>(null), mounted = useRef(true);
    const closed = useRef(false);
    const access = getSessionAccess(model), db = useRef(file.db), epoch = useRef(access.epoch);
    useEffect(() => {
        const off = access.subscribeInvalidation(() => { closed.current = true; operation.current?.abort(); close(); });
        return () => { mounted.current = false; operation.current?.abort(); off(); };
    }, []);
    const current = () => mounted.current && access.state === 'open' && access.epoch === epoch.current &&
        file.active && model.files.get(file.id) === file && file.db === db.current && !file.storage &&
        !file.demo && !(file as FileModel & { readOnly?: boolean }).readOnly &&
        model.settings.canSaveTo && model.settings.webdav && Storage.webdav.enabled;
    const cancel = () => {
        if (!mounted.current || closed.current) return;
        closed.current = true;
        operation.current?.abort();
        close(busy ? t('Save canceled. Your local vault is retained. If the upload started, a remote copy may exist; inspect the destination before retrying.') : undefined);
    };
    const run = async () => {
        if (operation.current || !current()) return;
        const controller = new AbortController(); operation.current = controller;
        setBusy(true); setError('');
        let finish: (() => void) | undefined;
        try {
            const path = webDavDestination(url);
            await waitForPendingOperations(model, controller.signal);
            await waitForSync(file, controller.signal);
            if (!current() || controller.signal.aborted) throw new Error('The vault changed. Reopen Save to WebDAV.');
            if (!inspected) {
                const etag = await Storage.webdav.inspectSaveDestination(path, { user, password }, controller.signal);
                if (current() && !controller.signal.aborted) setInspected({ path, etag });
                return;
            }
            finish = beginPendingOperation(model);
            if (model.settings.disableOfflineStorage || !Storage.cache.enabled) {
                throw new Error('Save to WebDAV needs a recoverable local copy. Enable offline storage before migrating this local vault.');
            }
            try { savePendingDrafts(); }
            catch { throw new Error('Apply or discard invalid or credential edits before saving to WebDAV.'); }
            // Commit a recoverable local copy before attempting any destination write.
            await saveVault(model, file);
            if (!current() || controller.signal.aborted) throw new Error('The vault changed. Reopen Save to WebDAV.');
            await saveAsWebDav(model, file, inspected.path, { user, password }, inspected.etag, controller.signal);
            if (mounted.current && access.state === 'open' && access.epoch === epoch.current) {
                closed.current = true;
                close(t('Saved to WebDAV. Future saves use this connection; your original disk file is unchanged.'));
            }
        } catch (failure) {
            if (current()) {
                setInspected(null);
                setError(`${t('The local vault is retained. Check the destination before retrying.')} ${failure instanceof Error ? t(failure.message) : String(failure)}`);
            }
        } finally {
            finish?.(); operation.current = null;
            if (mounted.current) setBusy(false);
        }
    };
    return <PromptDialog title={t('Save to WebDAV')} icon="cloud" cancel={cancel} confirm={() => void run()}
        confirmLabel={t(busy ? 'Saving…' : inspected ? inspected.etag ? 'Replace remote vault' : 'Save encrypted vault' : 'Check destination')}
        disabled={busy}>
        <p>{t('Save this local vault to a WebDAV server. Its database password and key file stay the same. WebDAV credentials only authorize the connection.')}</p>
        <fieldset disabled={busy || !!inspected} style={{ border: 0, padding: 0, minWidth: 0 }}>
            <label class="vault-form__field">{t('WebDAV address')}<input class="input" type="url" required value={url} onInput={(e) => setUrl(e.currentTarget.value)} /></label>
            <label class="vault-form__field">{t('WebDAV username')}<input class="input" autoComplete="off" value={user} onInput={(e) => setUser(e.currentTarget.value)} /></label>
            <label class="vault-form__field">{t('WebDAV password')}<input class="input" type="password" autoComplete="new-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} /></label>
        </fieldset>
        {inspected && <>
            <p role="status">{t(inspected.etag ? 'A vault already exists at this address. Replacing it removes its existing contents. Continue only if you have a backup.' : 'No vault exists at this address. Ready to save an encrypted copy.')}</p>
            <button type="button" class="link" disabled={busy} onClick={() => setInspected(null)}>{t('Change destination')}</button>
        </>}
        {error && <p role="alert">{error}</p>}
    </PromptDialog>;
}
