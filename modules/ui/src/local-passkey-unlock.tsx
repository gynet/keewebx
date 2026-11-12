import { useEffect, useRef } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { canUseLocalPasskeys, forgetLocalPasskey, hasLocalPasskey, hasLocalPasskeyData, localPasskeyError, unlockWithLocalPasskey } from './local-passkeys';
import { t } from './i18n';

export function LocalPasskeyUnlock({ model, id, keyFile, busy, setBusy, setMessage }: {
    model: AppModel; id?: string; keyFile: { name: string; data: string } | null;
    busy: boolean; setBusy: (busy: boolean) => void; setMessage: (message: string) => void;
}) {
    const mounted = useRef(true), running = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const info = id ? model.fileInfos.get(id) : undefined;
    if (!hasLocalPasskeyData(info)) return <p class="card__sub">{t('After opening, enable local passkey unlock in Database settings.')}</p>;
    return <>
        {hasLocalPasskey(info) && <button type="button" class="pill pill--block"
            disabled={busy || !canUseLocalPasskeys()} onClick={async () => {
                if (!info || running.current) return;
                running.current = true; setBusy(true); setMessage('');
                try { await unlockWithLocalPasskey(model, info.id, keyFile, () => mounted.current); }
                catch (error) { if (mounted.current) setMessage(t(localPasskeyError(error))); }
                finally { running.current = false; if (mounted.current) setBusy(false); }
            }}>{t('Unlock with passkey')}</button>}
        <p class="card__sub">{t('Your master password remains available. A required key file is still needed with a passkey.')}</p>
        {!canUseLocalPasskeys() && <p role="status">{t('Passkey unlock is unavailable here. Use your password and any required key file.')}</p>}
        <button type="button" class="link" disabled={busy} onClick={() => {
            if (!info || !window.confirm(t('Forget passkey unlock for this vault in this browser? The vault stays intact. Remove the authenticator credential separately in your device or password manager.'))) return;
            try {
                forgetLocalPasskey(model, info.id, () => mounted.current);
                setMessage(t('Local passkey registration forgotten. The authenticator credential was not deleted.'));
            } catch (error) { setMessage(t(localPasskeyError(error))); }
        }}>{t('Forget local passkey')}</button>
    </>;
}
