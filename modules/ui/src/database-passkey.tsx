import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { probePasskeyCapability } from 'comp/passkey/passkey-capability';
import type { PasskeyCeremony } from 'comp/passkey/passkey-unlock';
import { canUseLocalPasskeys, enrollLocalPasskey, forgetLocalPasskey, hasLocalPasskeyData, localPasskeyError } from './local-passkeys';
import { usePendingDraft } from './pending-drafts';
import { t } from './i18n';

export function DatabasePasskey({ model, file }: { model: AppModel; file: FileModel }) {
    const mounted = useRef(true), running = useRef(false);
    const keyInput = useRef<HTMLInputElement>(null);
    const [password, setPassword] = useState('');
    const [keyFile, setKeyFile] = useState<File>();
    const [busy, setBusy] = useState(false);
    const [needsVerification, setNeedsVerification] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const verifyingNow = useRef(false);
    const verification = useRef<{
        request(): Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void;
    }>();
    const [message, setMessage] = useState('');
    const [capability, setCapability] = useState<'checking' | 'unsupported' | 'available'>(canUseLocalPasskeys() ? 'checking' : 'unsupported');
    const info = model.fileInfos.get(file.id);
    const registered = hasLocalPasskeyData(info);
    useEffect(() => {
        mounted.current = true;
        if (canUseLocalPasskeys()) void probePasskeyCapability().then((value) => {
            if (mounted.current) setCapability(value.prf === 'unsupported' ? 'unsupported' : 'available');
        }, () => { if (mounted.current) setCapability('available'); });
        return () => {
            mounted.current = false;
            const pending = verification.current;
            verification.current = undefined;
            pending?.reject(new Error('The vault or session changed. Try again.'));
        };
    }, []);
    const clear = () => {
        setPassword(''); setKeyFile(undefined);
        if (keyInput.current) keyInput.current.value = '';
    };
    const cancelVerification = () => {
        const pending = verification.current;
        verification.current = undefined;
        setNeedsVerification(false);
        pending?.reject(new Error('Passkey setup stopped. Your password still works. The new passkey may remain in your provider.'));
    };
    usePendingDraft(!!password || !!keyFile || needsVerification, () => {
        setMessage(t('Finish or discard passkey enrollment before continuing.')); return false;
    }, () => { cancelVerification(); clear(); }, 'database', file.id);
    const runCeremony: PasskeyCeremony = <T,>(stage: 'create' | 'verify', request: () => Promise<T>) => {
        if (stage === 'create') {
            // Password/key-file verification is complete; the native File can be released.
            clear();
            return request().catch(error => {
                const name = (error as { name?: string })?.name;
                if (name === 'NotAllowedError' || name === 'AbortError') {
                    throw new Error('Passkey creation was not completed. It may have been canceled or refused by your browser or provider. A saved passkey still needs WebAuthn PRF support for encrypted unlock.');
                }
                throw error;
            });
        }
        return new Promise<T>((resolve, reject) => {
            if (!mounted.current) { reject(new Error('The vault or session changed. Try again.')); return; }
            verification.current = { request, resolve: value => resolve(value as T), reject };
            setNeedsVerification(true);
            setMessage(t('Your passkey was created. Verify it to finish enabling encrypted unlock.'));
        });
    };
    const verify = async () => {
        const pending = verification.current;
        if (!pending || verifyingNow.current) return;
        verifyingNow.current = true; setVerifying(true); setMessage('');
        try {
            // Invoke WebAuthn directly from this click, before any await.
            const result = await pending.request();
            if (verification.current !== pending) {
                if (result instanceof Uint8Array) result.fill(0);
                return;
            }
            verification.current = undefined;
            setNeedsVerification(false);
            pending.resolve(result);
        } catch (error) {
            if (verification.current !== pending || !mounted.current) return;
            const name = (error as { name?: string })?.name;
            if (name === 'NotAllowedError' || name === 'AbortError') {
                setMessage(t('Your passkey was created, but encryption verification did not finish. Retry verification with the same passkey. Your provider must support WebAuthn PRF.'));
            } else {
                verification.current = undefined;
                setNeedsVerification(false);
                pending.reject(error);
            }
        } finally {
            verifyingNow.current = false;
            if (mounted.current) setVerifying(false);
        }
    };
    const enroll = async () => {
        if (running.current) return;
        running.current = true; setBusy(true); setMessage('');
        const operation = enrollLocalPasskey(model, file, password, keyFile, () => mounted.current, runCeremony);
        // Keep provider-backed key-file access until the asynchronous read completes.
        setPassword(''); setKeyFile(undefined);
        try {
            await operation;
            if (mounted.current) setMessage(t('Passkey unlock saved in this browser. Keep your master password and any required key file.'));
        } catch (error) { if (mounted.current) setMessage(t(localPasskeyError(error))); }
        finally { running.current = false; if (mounted.current) { clear(); setBusy(false); } }
    };
    return <section data-vault-id={file.id} tabIndex={-1} class="database-passkey" aria-label={t('Local passkey unlock')}>
        <h4>{t('Local passkey unlock')}</h4>
        <p>{t('A passkey unlocks this vault in this browser. A configured key file is still required.')}</p>
        {registered && <p>{t('This browser has a passkey registration for this vault.')}</p>}
        {capability === 'unsupported' ? <p>{t('Passkey unlock is unavailable here. Use your password and any required key file.')}</p> : <>
            <p>{t('Save the vault first, then verify its current password and any required key file to enable or replace local passkey unlock.')}</p>
            {!needsVerification && <><label>{t('Current master password')}
                <input class="input" type="password" autoComplete="current-password" value={password}
                    disabled={busy} onInput={(event) => setPassword(event.currentTarget.value)} />
            </label>
            <label>{t('Current key file (if required)')}
                <input ref={keyInput} type="file" disabled={busy} style={{ width: '100%', maxWidth: '100%', minWidth: 0 }}
                    onChange={(event) => setKeyFile(event.currentTarget.files?.[0])} />
            </label>
            {keyFile && <p style={{ overflowWrap: 'anywhere' }}>{keyFile.name}</p>}
            <div class="database-settings__actions">
                <button type="button" class="pill" disabled={busy || capability === 'checking'} onClick={enroll}>
                    {busy ? t('Waiting for passkey…') : registered ? t('Replace local passkey') : t('Enable local passkey')}
                </button>
                <button type="button" class="pill" disabled={busy} onClick={clear}>{t('Discard passkey inputs')}</button>
            </div></>}
            {needsVerification && <div class="database-settings__actions">
                <button type="button" class="pill" disabled={verifying} onClick={verify}>
                    {verifying ? t('Waiting for passkey…') : t('Verify passkey')}
                </button>
                <button type="button" class="pill" disabled={verifying} onClick={cancelVerification}>{t('Cancel passkey setup')}</button>
            </div>}
        </>}
        {registered && <button type="button" class="link" disabled={busy} onClick={() => {
            if (!window.confirm(t('Forget passkey unlock for this vault in this browser? The vault stays intact. Remove the authenticator credential separately in your device or password manager.'))) return;
            try {
                forgetLocalPasskey(model, file.id, () => mounted.current);
                clear(); setMessage(t('Local passkey registration forgotten. The authenticator credential was not deleted.'));
            } catch (error) { setMessage(t(localPasskeyError(error))); }
        }}>{t('Forget local passkey')}</button>}
        {message && <p role="status">{message}</p>}
    </section>;
}
