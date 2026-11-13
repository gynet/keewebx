import { useEffect, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { getSessionAccess } from 'comp/app/session-access';
import { hasPendingDrafts } from './pending-drafts';
import { useVaultVersion } from './vault-state';
import { reloadAllowed, requestStandaloneReload } from './standalone-reload-guard';
import { t } from './i18n';

const standalone = () => (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
export function StandaloneReload({ model }: { model: AppModel }) {
    const [installed, setInstalled] = useState(standalone);
    useVaultVersion(model);
    useEffect(() => {
        const query = matchMedia('(display-mode: standalone)');
        const changed = () => setInstalled(standalone());
        query.addEventListener('change', changed);
        return () => query.removeEventListener('change', changed);
    }, []);
    if (!installed) return null;
    const read = () => ({ standalone: standalone(), openVaults: model.files.hasOpenFiles(), drafts: hasPendingDrafts(),
        phase: getSessionAccess(model).state, epoch: getSessionAccess(model).epoch });
    return <section aria-label={t('Standalone app')}>
        <p>{t('To reload the standalone app, save and lock all vaults first.')}</p>
        <button class="pill" type="button" disabled={!reloadAllowed(read())} onClick={event => {
            const button = event.currentTarget;
            requestStandaloneReload(read, () => button.isConnected && !button.closest('[inert], [hidden]'),
                () => window.confirm(t('Reload the app now?')), () => location.reload());
        }}>{t('Reload app')}</button>
    </section>;
}
