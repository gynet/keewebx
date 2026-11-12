import { useEffect, useRef, useState } from 'preact/hooks';
import { Credentials } from 'kdbxweb';
import type { FileModel } from 'models/file-model';
import { applyDatabaseCredentials, captureDatabaseCredentials, type DatabaseCredentialDraft } from 'comp/app/database-credentials';
import { usePendingDraft } from './pending-drafts';
import { t } from './i18n';

/** Register synchronously before invoking operation; drain it before recovery snapshots or close. */
export type RunCredentialOperation = (operation: (canPublish: () => boolean) => Promise<void>) => Promise<void>;

export function DatabaseCredentialsEditor({ file, onBusyChange, onDraftChange, canApply, canDownload, runOperation }: {
    file: FileModel;
    onBusyChange: (busy: boolean) => void;
    onDraftChange: (dirty: boolean) => void;
    canApply: () => boolean;
    canDownload: () => boolean;
    runOperation: RunCredentialOperation;
}) {
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [resetPassword, setResetPassword] = useState(false);
    const [keyAction, setKeyAction] = useState<'keep' | 'set' | 'remove' | 'reset'>('keep');
    const [keyFile, setKeyFile] = useState<File | null>(null);
    const [generated, setGenerated] = useState(false);
    const [keySaved, setKeySaved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const baseline = useRef(captureDatabaseCredentials(file));
    const lifecycle = useRef({ mounted: true, generation: 0, busy: false });
    const input = useRef<HTMLInputElement>(null);
    const dirty = !!(password || confirmation || resetPassword || keyAction !== 'keep' || busy);
    useEffect(() => {
        lifecycle.current.mounted = true;
        return () => { lifecycle.current.mounted = false; lifecycle.current.generation++; };
    }, []);
    useEffect(() => { onDraftChange(dirty); }, [dirty]);
    const discard = () => {
        lifecycle.current.generation++;
        setPassword(''); setConfirmation(''); setResetPassword(false);
        setKeyAction('keep'); setKeyFile(null); setGenerated(false); setKeySaved(false);
        if (input.current) input.current.value = '';
        baseline.current = captureDatabaseCredentials(file);
        setMessage('');
        onDraftChange(false);
    };
    const startEdit = () => {
        if (!dirty) baseline.current = captureDatabaseCredentials(file);
        onDraftChange(true);
        setMessage('');
    };
    const refuseImplicitApply = () => {
        setMessage(t('Apply or discard credential edits before saving, downloading, or locking.'));
        return false;
    };
    usePendingDraft(dirty, refuseImplicitApply, discard, 'database');
    const run = async (action: (current: () => boolean) => Promise<void>) => {
        if (lifecycle.current.busy) return;
        const generation = ++lifecycle.current.generation;
        const current = () => lifecycle.current.mounted && lifecycle.current.generation === generation && canApply();
        lifecycle.current.busy = true; setBusy(true); onBusyChange(true); setMessage('');
        try { await runOperation((canPublish) => action(() => current() && canPublish())); }
        catch (error) {
            if (current()) setMessage(error instanceof Error ? t(error.message) : t('Could not apply credentials. Check the current settings before retrying.'));
        } finally {
            lifecycle.current.busy = false;
            if (lifecycle.current.mounted) { setBusy(false); onBusyChange(false); }
        }
    };
    const apply = () => run(async (current) => {
        const generation = lifecycle.current.generation;
        if (!current()) throw new Error('The vault is no longer available for this change.');
        if (generated && !keySaved) throw new Error('Save the generated key file before applying it.');
        if (keyAction === 'set' && !keyFile) throw new Error('Select a key file first.');
        const data = keyAction === 'set' ? await keyFile!.arrayBuffer() : undefined;
        try {
            const draft: DatabaseCredentialDraft = {
                password: resetPassword ? { action: 'reset' } : password || confirmation
                    ? { action: 'set', value: password, confirmation } : { action: 'keep' },
                keyFile: keyAction === 'set' ? { action: 'set', data: data!, name: keyFile!.name } : { action: keyAction }
            };
            await applyDatabaseCredentials(file, baseline.current, draft, current);
            // A successful synchronous commit is final even if an observer began securing.
            // Clear this operation's inputs without clearing a newer draft or remounted editor.
            if (lifecycle.current.mounted && lifecycle.current.generation === generation) {
                discard();
                setMessage(t('Credentials applied in memory. Save database settings to persist them; keep the previous credentials until synchronization succeeds.'));
            }
        } finally { if (data) new Uint8Array(data).fill(0); }
    });
    const generate = () => {
        startEdit();
        void run(async (current) => {
            if (!current()) throw new Error('The vault is no longer available for this change.');
            const bytes = await Credentials.createRandomKeyFile(2);
            try {
                if (!current()) return;
                const buffer = new ArrayBuffer(bytes.byteLength);
                new Uint8Array(buffer).set(bytes);
                setKeyFile(new File([buffer], `${file.name.replace(/[\\/:*?"<>|]/g, '_') || 'vault'}.keyx`));
                new Uint8Array(buffer).fill(0);
                setKeyAction('set'); setGenerated(true); setKeySaved(false);
            } finally { bytes.fill(0); }
        });
    };
    const downloadKey = () => {
        if (!keyFile || !canDownload()) return;
        const url = URL.createObjectURL(keyFile);
        const link = document.createElement('a');
        link.href = url; link.download = keyFile.name; document.body.appendChild(link);
        try { link.click(); }
        finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    };
    return <section aria-label={t('Database credentials')}>
        <h3>{t('Database credentials')}</h3>
        <p>{t('Keep a safe copy of your credentials. Losing a required password or key file prevents access to this database.')}</p>
        <p>{file.passwordChanged || file.keyFileChanged
            ? t('Credential changes are pending synchronization.') : t('No pending credential changes.')}</p>
        <fieldset disabled={busy || !!file.chalResp || file.syncing}>
            <label class="vault-form__field">{t('New master password')}
                <input class="input" type="password" autoComplete="new-password" value={password}
                    onInput={(e) => { startEdit(); setResetPassword(false); setPassword(e.currentTarget.value); }} />
            </label>
            <label class="vault-form__field">{t('Confirm new master password')}
                <input class="input" type="password" autoComplete="new-password" value={confirmation}
                    onInput={(e) => { startEdit(); setResetPassword(false); setConfirmation(e.currentTarget.value); }} />
            </label>
            <button type="button" class="pill" disabled={!file.passwordChanged && !password && !confirmation}
                onClick={() => { startEdit(); setPassword(''); setConfirmation(''); setResetPassword(true); }}>
                {t('Reset password change')}
            </button>
            {resetPassword && <p>{t('Apply to restore the password from the last successful save.')}</p>}
            <p style={{ overflowWrap: 'anywhere' }}>{t('Current key file: {}', file.keyFileName || t('None'))}</p>
            <label class="vault-form__field">{t('Key file action')}
                <select class="input" value={keyAction} onChange={(e) => {
                    startEdit(); setKeyAction(e.currentTarget.value as typeof keyAction);
                    setKeyFile(null); setGenerated(false); setKeySaved(false);
                    if (input.current) input.current.value = '';
                }}>
                    <option value="keep">{t('Keep current key file')}</option>
                    <option value="set">{t('Add or replace key file')}</option>
                    <option value="remove">{t('Remove key file')}</option>
                    <option value="reset">{t('Reset key file change')}</option>
                </select>
            </label>
            {keyAction === 'set' && <label class="vault-form__field">{t('Select key file')}
                <input ref={input} class="input" type="file" onChange={(e) => {
                    startEdit(); setKeyFile(e.currentTarget.files?.[0] ?? null); setGenerated(false); setKeySaved(false);
                }} />
            </label>}
            <button type="button" class="pill" onClick={generate}>{t('Generate key file')}</button>
            {keyAction === 'remove' && <p>{t('Apply to stop requiring the current key file. A password must remain.')}</p>}
            {keyAction === 'reset' && <p>{t('Apply to restore the key file from the last successful save.')}</p>}
            {keyFile && <p style={{ overflowWrap: 'anywhere' }}>{t('Selected key file: {}', keyFile.name)}</p>}
            {generated && <>
                <button type="button" class="pill" onClick={downloadKey}>{t('Download generated key file')}</button>
                <label class="vault-form__field"><span><input type="checkbox" checked={keySaved}
                    onChange={(e) => {
                        const saved = e.currentTarget.checked;
                        setKeySaved(saved);
                        if (saved) setMessage(current => current === t('Save the generated key file before applying it.') ? '' : current);
                    }} /> {t('I saved the generated key file in a safe place.')}</span></label>
            </>}
            <div class="database-settings__actions">
                <button type="button" class="pill pill--primary" disabled={!dirty} onClick={apply}>{t('Apply credential changes')}</button>
                <button type="button" class="pill" disabled={!dirty} onClick={discard}>{t('Discard credential edits')}</button>
            </div>
        </fieldset>
        {file.chalResp && <p>{t('Manage additional authentication factors in Classic.')}</p>}
        {message && <p role="status">{message}</p>}
    </section>;
}
