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
            : t('An update is ready for the next time you open KeeWebX.')}</p>
        {canReload && <button type="button" class="pill pill--primary" id="apply-app-update"
            onClick={() => { if (canReload) ServiceWorkerClient.applyUpdate(); }}>
            {t('Reload to update')}
        </button>}
    </aside>;
}
