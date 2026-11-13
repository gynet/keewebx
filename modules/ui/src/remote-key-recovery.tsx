import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ByteUtils, ProtectedValue } from 'kdbxweb';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { Events } from 'framework/events';
import { getSessionAccess } from 'comp/app/session-access';
import { waitForSync } from 'comp/app/vault-files';
import { credentialChangeVersion } from 'util/kdbxweb/credential-changes';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { beginPendingOperation, waitForPendingOperations } from './pending-operations';
import { savePendingDrafts } from './pending-drafts';
import { t } from './i18n';
import './remote-key-recovery.css';

/** Remote key errors retain the open vault and its edits until the shared sync can merge. */
export function RemoteKeyRecovery({ model }: { model: AppModel }) {
    const [pending, setPending] = useState<FileModel[]>([]);
    const [selected, setSelected] = useState<FileModel | null>(null);
    const [message, setMessage] = useState('');
    const current = useRef<FileModel | null>(null);
    const access = getSessionAccess(model);
    const available = (file: FileModel) => file.active && model.files.get(file.id) === file;
    const choose = (file: FileModel) => {
        if (access.state !== 'open' || !available(file)) return;
        current.current = file; setSelected(file); setMessage('');
    };
    useEffect(() => {
        const changed = ({ file }: { file: FileModel }) => {
            if (!available(file)) return;
            setPending(files => files.includes(file) ? files : [...files, file]);
            if (!current.current && access.state === 'open' && !document.querySelector('dialog[open]')) choose(file);
        };
        const clean = () => setPending(files => files.filter(file => available(file) && !!file.syncError));
        const invalidate = access.subscribeInvalidation(() => {
            current.current = null; setSelected(null); setMessage('');
        });
        Events.on('remote-key-changed', changed);
        Events.on('all-files-closed', clean);
        const changedFile = () => setPending(files => files.filter(file => available(file) && (file.syncing || !!file.syncError)));
        model.files.on('change', changedFile);
        return () => { invalidate(); Events.off('remote-key-changed', changed); Events.off('all-files-closed', clean); model.files.off('change', changedFile); };
    }, [model]);
    const close = () => { current.current = null; setSelected(null); };
    const files = pending.filter(available);
    return <>
        {access.state === 'open' && !selected && (files.length > 0 || message) && <aside class="remote-key-notices" aria-label={t('Remote synchronization')}>
            {files.map(file => <div class="remote-key-notice" key={file.id}>
                <span>{t('{} needs its remote credentials. Local changes remain open.', file.name)}</span>
                <button type="button" class="pill" onClick={() => choose(file)}>{t('Resolve remote key')}</button>
            </div>)}
            {message && <div class="remote-key-notice"><span role="status">{message}</span><button class="pill" type="button" onClick={() => setMessage('')}>{t('Dismiss')}</button></div>}
        </aside>}
        {selected && <RemoteKeyForm key={selected.id} model={model} file={selected} close={close}
            resolved={() => {
                setPending(files => files.filter(file => file !== selected));
                setMessage(t('{} synchronized with the remote credentials.', selected.name)); close();
            }} />}
    </>;
}

function RemoteKeyForm({ model, file, close, resolved }: {
    model: AppModel; file: FileModel; close: () => void; resolved: () => void;
}) {
    const access = getSessionAccess(model);
    const snapshot = useRef({ epoch: access.epoch, db: file.db, credentials: file.db.credentials,
        version: credentialChangeVersion(file.db.credentials) }).current;
    const dialog = useRef<HTMLDialogElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const previousFocus = useRef(document.activeElement as HTMLElement | null);
    const [password, setPassword] = useState('');
    const [keyMode, setKeyMode] = useState<'none' | 'keep' | 'choose'>(snapshot.credentials.keyFileHash ? 'keep' : 'none');
    const [keyFile, setKeyFile] = useState<File>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const operation = useRef<AbortController | null>(null);
    const mounted = useRef(true);
    const available = () => mounted.current && access.state === 'open' && access.epoch === snapshot.epoch &&
        file.active && model.files.get(file.id) === file && !(file as FileModel & { readOnly?: boolean }).readOnly;
    const original = () => available() && file.db === snapshot.db && file.db.credentials === snapshot.credentials &&
        credentialChangeVersion(file.db.credentials) === snapshot.version;
    useEffect(() => { if (!busy && error) input.current?.focus(); }, [busy, error]);
    useLayoutEffect(() => {
        const element = dialog.current!;
        element.showModal(); input.current?.focus();
        const unsubscribe = access.subscribeInvalidation(() => {
            operation.current?.abort(); setPassword(''); setKeyFile(undefined); close();
        });
        return () => {
            mounted.current = false; operation.current?.abort(); unsubscribe(); element.close();
            requestAnimationFrame(() => {
                const previous = previousFocus.current;
                if (access.state === 'open' && previous?.isConnected && !previous.closest('[hidden], [inert]')) previous.focus();
            });
        };
    }, []);
    const cancel = () => { operation.current?.abort(); setPassword(''); setKeyFile(undefined); close(); };
    const submit = async (event: Event) => {
        event.preventDefault();
        if (operation.current) return;
        if (!original()) { setError(t('This vault or session changed. Cancel and reopen remote-key recovery.')); return; }
        if (keyMode === 'choose' && !keyFile) { setError(t('Choose the remote key file before retrying.')); return; }
        const controller = new AbortController(); operation.current = controller;
        const current = () => !controller.signal.aborted && available();
        const check = () => {
            if (!current() || !original()) throw new Error('This vault or session changed. Cancel and reopen remote-key recovery.');
        };
        let finish: (() => void) | undefined;
        let data: ArrayBuffer | undefined;
        let secret: ProtectedValue | undefined;
        setBusy(true); setError('');
        try {
            await waitForPendingOperations(model, controller.signal);
            await waitForSync(file, controller.signal);
            check();
            try { savePendingDrafts(); }
            catch { throw new Error('Apply or discard invalid or credential edits before resolving the remote key.'); }
            check();
            finish = beginPendingOperation(model);
            if (keyMode === 'choose') data = await keyFile!.arrayBuffer();
            check();
            if (password) secret = ProtectedValue.fromString(password);
            await new Promise<void>((resolve, reject) => model.syncFile(file, {
                canContinue: current,
                remoteKey: { canMerge: original, onMerged: db => {
                    // Only this attempt's authorized merge may advance the snapshot.
                    // Later unrelated credential/database changes still fail original().
                    if (!current() || file.db !== db) return;
                    snapshot.db = db; snapshot.credentials = db.credentials;
                    snapshot.version = credentialChangeVersion(db.credentials);
                }, password: secret, keyFileName: keyMode === 'keep' ? file.keyFileName || 'current.key' :
                    keyMode === 'choose' ? keyFile!.name : undefined, keyFileData: data }
            }, error => error ? reject(error) : resolve()));
            if (!current()) return;
            if (file.modified || file.dirty) {
                setError(t('Changes remain to be synchronized. Retry with the remote credentials.')); return;
            }
            setPassword(''); setKeyFile(undefined); resolved();
        } catch (error) {
            if (!current()) return;
            setError(error instanceof Error && !('code' in error) ? t(error.message) :
                t('Could not synchronize. Check the remote password and key file, then retry. Local changes remain open.'));
            input.current?.focus();
        } finally {
            if (data) ByteUtils.zeroBuffer(data);
            if (secret) { ByteUtils.zeroBuffer(secret.value); ByteUtils.zeroBuffer(secret.salt); }
            finish?.(); operation.current = null;
            if (mounted.current) setBusy(false);
        }
    };
    return <dialog ref={dialog} class="remote-key-dialog" aria-label={t('Resolve remote master key')} aria-modal="true"
        onCancel={event => { event.preventDefault(); cancel(); }}
        onKeyDown={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}>
        <h2>{t('Remote master key changed')}</h2>
        <p class="remote-key-dialog__name">{file.name}</p>
        <p>{t('Enter the credentials for the copy on your storage. Retry merges your open local changes with that copy before saving.')}</p>
        <form onSubmit={submit}>
            <fieldset disabled={busy}>
                <label class="vault-form__field">{t('Remote master password')}
                    <input ref={input} class="input" type="password" autoComplete="off" value={password}
                        onInput={event => setPassword(event.currentTarget.value)} />
                </label>
                <p class="muted">{t('Leave the password blank to reuse the password of the open vault.')}</p>
                <label class="vault-form__field">{t('Remote key file')}
                    <select class="input" value={keyMode} onChange={event => { setKeyMode(event.currentTarget.value as typeof keyMode); setKeyFile(undefined); }}>
                        <option value="none">{t('No key file')}</option>
                        {snapshot.credentials.keyFileHash && <option value="keep">{t('Use the current key file')}</option>}
                        <option value="choose">{t('Choose a different key file')}</option>
                    </select>
                </label>
                {keyMode === 'choose' && <label class="vault-form__field">{t('Choose remote key file')}
                    <input class="input" type="file" onChange={event => setKeyFile(event.currentTarget.files?.[0])} />
                </label>}
            </fieldset>
            {error && <p class="error" role="alert">{error}</p>}
            {busy && <p role="status">{t('Synchronizing with remote credentials…')}</p>}
            <div class="remote-key-dialog__actions">
                <button class="pill" type="button" onClick={cancel}>{t('Cancel')}</button>
                <button class="pill pill--primary" type="submit" disabled={busy}>{t('Retry synchronization')}</button>
            </div>
        </form>
    </dialog>;
}
