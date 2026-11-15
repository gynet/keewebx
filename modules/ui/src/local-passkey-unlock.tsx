import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { AppModel } from 'models/app-model';
import { canUseLocalPasskeys, forgetLocalPasskey, hasLocalPasskey, hasLocalPasskeyData, localPasskeyError, unlockWithLocalPasskey } from './local-passkeys';
import { t } from './i18n';

export function LocalPasskeyUnlock({ model, id, keyFile, busy, setBusy, setMessage, onAttempt, setupAfterUnlock, onSetupChange, canOpen, onOpened, options, optionsOpen, onForgot }: {
    model: AppModel; id?: string; keyFile: { name: string; data: string } | null;
    busy: boolean; setBusy: (busy: boolean) => void; setMessage: (message: string) => void;
    canOpen?(): boolean; onOpened?(): void;
    onAttempt(): void; setupAfterUnlock: boolean; onSetupChange(value: boolean): void;
    options: ComponentChildren; optionsOpen: boolean; onForgot(): void;
}) {
    const mounted = useRef(true), running = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const info = id ? model.fileInfos.get(id) : undefined;
    return <>
        {hasLocalPasskey(info) && <button type="button" class="pill pill--primary pill--block unlock-card__action"
            disabled={busy || !canUseLocalPasskeys()} onClick={async () => {
                if (!info || running.current) return;
                onAttempt();
                running.current = true; setBusy(true); setMessage('');
                try {
                    await unlockWithLocalPasskey(model, info.id, keyFile, () => mounted.current && (!canOpen || canOpen()));
                    if (mounted.current && (!canOpen || canOpen())) onOpened?.();
                }
                catch (error) { if (mounted.current) setMessage(t(localPasskeyError(error))); }
                finally { running.current = false; if (mounted.current) setBusy(false); }
            }}>{t('Unlock with passkey')}</button>}
        {hasLocalPasskeyData(info) && <p class="unlock-card__help">{t('Your master password remains available. A required key file is still needed with a passkey.')}</p>}
        {hasLocalPasskeyData(info) && !canUseLocalPasskeys() && <p role="status">{t('Passkey unlock is unavailable here. Use your password and any required key file.')}</p>}
        <details class="unlock-card__options" open={optionsOpen}>
            <summary>{t('Unlock options')}</summary>
            <div class="unlock-card__extras">
                {options}
                {!hasLocalPasskeyData(info) ? <label class="passkey-setup-option">
                    <input type="checkbox" checked={setupAfterUnlock} disabled={busy}
                        onChange={(event) => onSetupChange(event.currentTarget.checked)} />
                    <span>{t('Set up passkey after unlocking')}</span>
                </label> : <button type="button" class="link unlock-card__forget" disabled={busy} onClick={() => {
                        if (!info || !window.confirm(t('Forget passkey unlock for this vault in this browser? The vault stays intact. Remove the authenticator credential separately in your device or password manager.'))) return;
                        try {
                            forgetLocalPasskey(model, info.id, () => mounted.current);
                            setMessage(t('Local passkey registration forgotten. The authenticator credential was not deleted.'));
                            onForgot();
                        } catch (error) { setMessage(t(localPasskeyError(error))); }
                    }}>{t('Forget local passkey')}</button>}
            </div>
        </details>
    </>;
}
