/** Re-renders the interface when the vault changes. */
import { useEffect, useState } from 'preact/hooks';
import { AppSettingsModel } from 'models/app-settings-model';
import { Events } from 'framework/events';
import type { AppModel } from 'models/app-model';

const VAULT_EVENTS = ['file-opened', 'one-file-closed', 'draft-changed', 'all-files-closed', 'refresh', 'file-changed', 'entry-updated', 'set-locale'];

export function useVaultVersion(model: AppModel): number {
    const [version, setVersion] = useState(0);
    useEffect(() => {
        const bump = () => setVersion((v) => v + 1);
        VAULT_EVENTS.forEach((e) => Events.on(e, bump));
        const files = model.files as unknown as { on(e: string, cb: () => void): void; off(e: string, cb: () => void): void };
        files.on('change', bump);
        AppSettingsModel.on('change', bump);
        // Sync state changes are posted for extensions; listen to them too.
        const onMessage = (e: MessageEvent) => {
            if (e.source === window && (e.data as { kwSyncState?: unknown })?.kwSyncState) {
                bump();
            }
        };
        window.addEventListener('message', onMessage);
        return () => {
            VAULT_EVENTS.forEach((e) => Events.off(e, bump));
            files.off('change', bump);
            AppSettingsModel.off('change', bump);
            window.removeEventListener('message', onMessage);
        };
    }, [model]);
    return version;
}
