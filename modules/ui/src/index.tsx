import 'ui-kit/tokens.css';
import './styles.css';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Events } from 'framework/events';
import type { AppModel } from 'models/app-model';
import { saveAndLock, startVault } from 'boot';
import { Unlock } from './unlock';
import { Vault } from './vault';
import { Settings } from './settings';
import { useVaultVersion } from './vault-state';
import { t } from './i18n';
import { waitForSync } from 'comp/app/vault-files';
import { hasPendingDrafts, savePendingDrafts, confirmDiscardDrafts } from './pending-drafts';

function App({ model }: { model: AppModel }) {
    const version = useVaultVersion(model);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [error, setError] = useState('');
    const locking = useRef(false);
    const surface = useRef<HTMLDivElement>(null);
    const lock = async () => {
        if (locking.current) return;
        locking.current = true;
        surface.current?.setAttribute('inert', '');
        setError('');
        try {
            await Promise.all(model.files.map((file) => waitForSync(file)));
            savePendingDrafts();
            await saveAndLock(model);
            setSettingsOpen(false);
        } catch {
            setError(t('Changes could not be saved. Keep this vault open and try again.'));
        } finally {
            surface.current?.removeAttribute('inert');
            locking.current = false;
        }
    };

    useEffect(() => {
        Events.on('user-idle', lock);
        Events.on('lock-workspace', lock);
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (model.files.hasDirtyFiles() || hasPendingDrafts()) {
                event.preventDefault();
                event.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', beforeUnload);
        return () => {
            Events.off('user-idle', lock);
            Events.off('lock-workspace', lock);
            window.removeEventListener('beforeunload', beforeUnload);
        };
    }, [model]);

    if (!model.files.hasOpenFiles()) {
        return <Unlock key={version} model={model} />;
    }
    return (
        <>
        {error && <div role="alert" class="error" style={{ padding: '12px 20px' }}>{error}</div>}
        <div ref={surface} style={{ height: '100%' }}>
        <div hidden={settingsOpen} style={{ height: '100%' }}>
        <Vault
            model={model}
            version={version}
            onSettings={() => setSettingsOpen(true)}
            onLock={() => void lock()}
        />
        </div>
        {settingsOpen && <Settings model={model} onBack={() => { if (confirmDiscardDrafts('database')) setSettingsOpen(false); }} />}
        </div>
        </>
    );
}

void startVault().then((model) => {
    render(<App model={model} />, document.getElementById('root')!);
}).catch(() => {
    render(
        <main class="start__main">
            <div class="card" role="alert">
                <h1>{t('Unable to open the vault')}</h1>
                <p>{t('Try opening the app directly or return to Classic.')}</p>
                <a href="index.html?ui=classic">{t('Open Classic')}</a>
            </div>
        </main>,
        document.getElementById('root')!
    );
});
