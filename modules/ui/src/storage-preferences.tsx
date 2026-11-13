import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { SettingsStore } from 'comp/settings/settings-store';
import { getSessionAccess } from 'comp/app/session-access';
import { waitForSync } from 'comp/app/vault-files';
import { beginPendingOperation, waitForPendingOperations } from './pending-operations';
import { useVaultVersion } from './vault-state';
import { t } from './i18n';

export function StoragePreferences({ model }: { model: AppModel }) {
    useVaultVersion(model);
    const [, render] = useState(0);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [purgeFailed, setPurgeFailed] = useState(false);
    const operation = useRef<AbortController | null>(null);
    const mounted = useRef(true);
    const access = getSessionAccess(model);
    useEffect(() => {
        mounted.current = true;
        const changed = () => render(value => value + 1);
        AppSettingsModel.on('change:disableOfflineStorage', changed);
        const unsubscribe = access.subscribeInvalidation(() => {
            operation.current?.abort(); setMessage('');
        });
        return () => {
            mounted.current = false;
            operation.current?.abort(); unsubscribe();
            AppSettingsModel.off('change:disableOfflineStorage', changed);
        };
    }, [model]);
    const change = async (disabled: boolean) => {
        if (operation.current || access.state !== 'open') return;
        const controller = new AbortController(), epoch = access.epoch;
        operation.current = controller; setBusy(true); setMessage('');
        let finish: (() => void) | undefined;
        const current = () => !controller.signal.aborted && access.state === 'open' && access.isCurrent(epoch);
        try {
            await waitForPendingOperations(model, controller.signal);
            await Promise.all(model.files.map(file => waitForSync(file, controller.signal)));
            if (!current()) return;
            finish = beginPendingOperation(model);
            // Do not claim a persistent policy change if browser settings storage fails.
            SettingsStore.saveRequired('app-settings', { ...model.settings, disableOfflineStorage: disabled });
            model.settings.disableOfflineStorage = disabled;
            setPurgeFailed(false);
            if (disabled) {
                await new Promise<void>((resolve) => model.deleteAllCachedFiles(error => {
                    if (current()) {
                        setPurgeFailed(!!error);
                        setMessage(error
                            ? t('Some cached copies could not be removed. Remote offline caching is disabled. Retry cache removal.')
                            : t('Remote offline caching is disabled. Eligible cached copies were removed. Local-only vaults and unsynchronized remote copies are kept.'));
                    }
                    resolve();
                }));
            } else {
                setMessage(t('Remote offline caching is enabled. Future remote saves can keep an offline copy.'));
            }
        } catch {
            if (current()) setMessage(t('The storage preference could not be applied. Keep your vaults open and retry.'));
        } finally {
            finish?.();
            if (operation.current === controller) operation.current = null;
            if (mounted.current) setBusy(false);
        }
    };
    const unsaved = model.files.filter(file => file.active && !file.demo && file.dirty && !!file.syncError);
    return <section class="general-preferences" aria-label={t('Browser storage')}>
        <h2 class="group-title">{t('Browser storage')}</h2>
        <div class="cardlist">
            <label class="cardlist__row" for="setting-disable-offline-cache">
                <span>{t('Disable offline cache for remote vaults')}</span>
                <input id="setting-disable-offline-cache" type="checkbox" checked={model.settings.disableOfflineStorage}
                    disabled={busy || access.state !== 'open'} onChange={event => void change(event.currentTarget.checked)} />
            </label>
            <p class="general-preferences__help">{t('Local-only vaults still require browser storage as their primary saved copy. This preference only disables optional offline copies of remote vaults. Unsynchronized copies are kept to protect your changes.')}</p>
            <p class="general-preferences__help">{t('Without an offline copy, a remote save failure leaves changes only in this tab. Keep the tab open, retry Save now, or use Download KDBX in the Database tab. A download does not confirm synchronization or update the original file.')}</p>
            {unsaved.length > 0 && <p class="general-preferences__help" role="alert">
                {t('Changes are not safely saved: {}. Keep this tab open. Use Save now to retry or Download KDBX in the Database tab to recover an encrypted copy.', unsaved.map(file => file.name).join(', '))}
            </p>}
            {message && <p class="general-preferences__help" role="status">{message}</p>}
            {purgeFailed && model.settings.disableOfflineStorage && <div class="cardlist__row">
                <button type="button" class="pill" disabled={busy || access.state !== 'open'} onClick={() => void change(true)}>{t('Retry cache removal')}</button>
            </div>}
        </div>
    </section>;
}
