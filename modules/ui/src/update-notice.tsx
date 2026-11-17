import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { UpdateModel } from 'models/update-model';
import { ServiceWorkerClient } from 'comp/browser/service-worker-client';
import { t } from './i18n';

export function UpdateNotice({ canReload }: { canReload: boolean }) {
    const [ready, setReady] = useState(UpdateModel.updateStatus === 'ready');
    const allowed = useRef(canReload);
    const cancelUpdate = useRef<(() => void) | undefined>();
    allowed.current = canReload;
    useLayoutEffect(() => {
        allowed.current = canReload;
        return () => {
            allowed.current = false;
            cancelUpdate.current?.();
            cancelUpdate.current = undefined;
        };
    }, [canReload]);
    useEffect(() => {
        const changed = () => setReady(UpdateModel.updateStatus === 'ready');
        UpdateModel.on('change:updateStatus', changed);
        changed();
        return () => UpdateModel.off('change:updateStatus', changed);
    }, []);
    // Even a passive notification interrupts an open vault or a recovery flow.
    if (!ready || !canReload) return null;
    return <aside class="card" aria-label={t('App update')} style={{
        position: 'fixed', bottom: '1rem', right: '1rem', zIndex: 20,
        maxWidth: 'min(28rem, calc(100vw - 2rem))', padding: '1rem'
    }}>
        <p role="status">{t('An update is ready.')}</p>
        <button type="button" class="pill pill--primary" id="apply-app-update"
            onClick={() => {
                if (allowed.current) cancelUpdate.current = ServiceWorkerClient.applyUpdate(() => allowed.current);
            }}>
            {t('Reload to update')}
        </button>
    </aside>;
}
