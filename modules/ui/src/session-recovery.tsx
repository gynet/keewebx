import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from './i18n';

export interface RecoveryVault { id: string; name: string; }

/** This surface protects access while unsaved models and editor drafts remain in memory. */
export function SessionRecovery({ files, ready, error, verify, resume, retry }: {
    files: RecoveryVault[];
    ready: boolean;
    error: string;
    verify: (id: string, password: string, keyFile?: ArrayBuffer) => Promise<void>;
    resume: () => void;
    retry: () => void;
}) {
    const root = useRef<HTMLElement>(null);
    const returnButton = useRef<HTMLButtonElement>(null);
    const [verified, setVerified] = useState<string[]>([]);
    useLayoutEffect(() => { root.current?.focus(); }, []);
    useLayoutEffect(() => {
        if (!verified.length) return;
        const nextPassword = root.current?.querySelector<HTMLInputElement>('input[type="password"]');
        (nextPassword ?? returnButton.current)?.focus();
    }, [verified]);
    return <main ref={root} tabIndex={-1} class="start__main" aria-labelledby="recovery-title"
        style={{ minHeight: '100dvh', overflow: 'auto' }}>
        <section class="card" style={{ margin: 'auto', width: 'min(100%, 440px)' }}>
            <h1 id="recovery-title">{t(ready ? 'Verify to recover editing' : 'Securing your vaults')}</h1>
            <p>{t('Access is suspended. Unsaved changes remain in this tab’s memory.')}</p>
            {error && <p role="alert" class="error">{error}</p>}
            {ready && !files.length && <button class="pill" type="button" onClick={retry}>{t('Retry verification setup')}</button>}
            {!ready && <p role="status">{t('Waiting for the current save to finish…')}</p>}
            {ready && files.map((file) => <RecoveryForm key={file.id} file={file}
                verified={verified.includes(file.id)} verify={verify}
                onVerified={() => setVerified((current) => [...current, file.id])} />)}
            {ready && <button ref={returnButton} type="button" class="pill pill--primary"
                disabled={!files.length || files.some((file) => !verified.includes(file.id))} onClick={resume}>
                {t('Return to unsaved changes')}
            </button>}
        </section>
    </main>;
}

function RecoveryForm({ file, verified, verify, onVerified }: {
    file: RecoveryVault;
    verified: boolean;
    verify: (id: string, password: string, keyFile?: ArrayBuffer) => Promise<void>;
    onVerified: () => void;
}) {
    const [password, setPassword] = useState('');
    const [keyFile, setKeyFile] = useState<File>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const input = useRef<HTMLInputElement>(null);
    const passwordInput = useRef<HTMLInputElement>(null);
    useLayoutEffect(() => {
        if (!busy && error) passwordInput.current?.focus();
    }, [busy, error]);
    return <form aria-label={t('Verify database: {}', file.name)} onSubmit={async (event) => {
        event.preventDefault();
        if (busy || verified) return;
        setBusy(true); setError('');
        let data: ArrayBuffer | undefined;
        try {
            data = await keyFile?.arrayBuffer();
            await verify(file.id, password, data);
            setPassword(''); setKeyFile(undefined);
            if (input.current) input.current.value = '';
            onVerified();
        } catch {
            setError(t('Verification failed. Use the current password and key file for this database.'));
        } finally {
            if (data) new Uint8Array(data).fill(0);
            setBusy(false);
        }
    }}>
        <h2 style={{ overflowWrap: 'anywhere' }}>{file.name}</h2>
        {verified ? <p role="status">{t('Verified')}</p> : <fieldset disabled={busy}>
            <label class="vault-form__field">{t('Master password')}
                <input ref={passwordInput} type="password" class="input" autoComplete="current-password" value={password}
                    onInput={(event) => setPassword(event.currentTarget.value)} />
            </label>
            <label class="vault-form__field">{t('Key file')}
                <input ref={input} type="file" style={{ maxWidth: '100%' }}
                    onChange={(event) => setKeyFile(event.currentTarget.files?.[0])} />
            </label>
            {keyFile && <button type="button" class="pill" onClick={() => {
                setKeyFile(undefined); if (input.current) input.current.value = '';
            }}>{t('Remove key file')}</button>}
            <button type="submit" class="pill">{t(busy ? 'Verifying…' : 'Verify')}</button>
        </fieldset>}
        {error && <p role="alert" class="error">{error}</p>}
    </form>;
}
