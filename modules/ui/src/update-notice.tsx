import { useEffect, useState } from 'preact/hooks';
import { UpdateModel } from 'models/update-model';
import { ServiceWorkerClient } from 'comp/browser/service-worker-client';
import { t } from './i18n';

export function UpdateNotice({ canReload }: { canReload: boolean }) {
    const [ready, setReady] = useState(UpdateModel.updateStatus === 'ready');
    useEffect(() => {
        const changed = () => setReady(UpdateModel.updateStatus === 'ready');
        UpdateModel.on('change:updateStatus', changed);
        changed();
        return () => UpdateModel.off('change:updateStatus', changed);
    }, []);
    if (!ready) return null;
    return <aside class="card" aria-label={t('App update')} style={{
        position: 'fixed', bottom: '1rem', right: '1rem', zIndex: 20,
        maxWidth: 'min(28rem, calc(100vw - 2rem))', padding: '1rem'
    }}>
        <p role="status">{canReload ? t('An update is ready.')
            : t('An update is ready. Lock your vaults, then reload to update.')}</p>
        <button type="button" class="btn" id="apply-app-update" disabled={!canReload}
            onClick={() => { if (canReload) ServiceWorkerClient.applyUpdate(); }}>
            {t('Reload to update')}
        </button>
    </aside>;
}
