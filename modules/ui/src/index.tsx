import { PreferenceEffects } from './app-preferences';
import 'ui-kit/tokens.css';
import './styles.css';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Events } from 'framework/events';
import type { AppModel } from 'models/app-model';
import { saveAndLock, startVault } from 'boot';
import { ServiceWorkerClient } from 'comp/browser/service-worker-client';
import { UpdateNotice } from './update-notice';
import { Unlock } from './unlock';
import { Vault } from './vault';
import { Settings } from './settings';
import { useVaultVersion } from './vault-state';
import { t } from './i18n';
import { waitForSync } from 'comp/app/vault-files';
import { getSessionAccess, type RecoveryVault } from 'comp/app/session-access';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { SessionRecovery } from './session-recovery';
import { SaveVerificationWarning } from './save-verification-warning';
import { createNewProtocolUi } from './extension-ui';
import { NewProtocolUiHost } from './extension-prompts';
import { createExtensionSessionsApi } from './extension-sessions';
import { BrowserExtensionConnector } from 'comp/extension/browser-extension-connector';
import { EmbeddedVault } from 'comp/extension/embedded-vault';
import { createSessionProtocolAccess } from 'comp/extension/protocol-access';
import { waitForPendingOperations } from './pending-operations';
import { hasPendingDrafts, savePendingDrafts, confirmDiscardDrafts } from './pending-drafts';
import { RemoteKeyRecovery } from './remote-key-recovery';
import { CloseVault } from './close-vault';
import type { FileModel } from 'models/file-model';
import { MultiVaultOpen } from './multi-vault-open';
import { useVaultCommands } from './vault-commands';

declare const __KW_NEW_EXTENSION__: boolean;

function App({ model }: { model: AppModel }) {
    const version = useVaultVersion(model);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [openingAnother, setOpeningAnother] = useState(false);
    const [closingFile, setClosingFile] = useState<FileModel | null>(null);
    const closeFile = (file: FileModel) => { if (access.state === 'open' && file.active) setClosingFile(file); };
    const [passkeySettingsId, setPasskeySettingsId] = useState<string>();
    const [unlockRequest, setUnlockRequest] = useState(model.fileUnlockPromise);
    const access = getSessionAccess(model);
    const protocolUi = useMemo(() => createNewProtocolUi(model,
        () => !!document.querySelector('dialog[open]')), [model]);
    const extensionSessions = useMemo(() => createExtensionSessionsApi(model), [model]);
    const [gate, setGate] = useState<{ epoch: number; ready: boolean; files: readonly RecoveryVault[]; error: string } | null>(null);
    const operation = useRef<AbortController | null>(null);
    const surface = useRef<HTMLDivElement>(null);
    const previousFocus = useRef<HTMLElement | null>(null);
    const dialogs = useRef<HTMLDialogElement[]>([]);
    const preparation = useRef(0);
    const prepareRecovery = async (epoch: number) => {
        const attempt = ++preparation.current;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        setGate({ epoch, ready: false, files: [], error: '' });
        try {
            const files = await Promise.race([
                access.prepareRecovery(epoch),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => reject(new Error('Recovery preparation timed out')), 15_000);
                })
            ]);
            if (attempt === preparation.current && access.isCurrent(epoch)) {
                setGate({ epoch, ready: true, files, error: '' });
            }
        } catch {
            if (attempt === preparation.current) setGate((current) => current?.epoch === epoch ? {
                epoch: access.epoch, ready: true, files: [],
                error: t('Recovery is not ready or requires an unsupported authentication factor. Access remains suspended. Keep this tab open; retry when the current operation finishes.')
            } : current);
        } finally { clearTimeout(timeout); }
    };
    const reveal = () => {
        ++preparation.current;
        surface.current?.removeAttribute('inert');
        if (surface.current) surface.current.hidden = false;
        setGate(null);
        requestAnimationFrame(() => {
            if (access.state !== 'open') return;
            for (const dialog of dialogs.current) if (dialog.isConnected && !dialog.open) dialog.showModal();
            dialogs.current = [];
            if (previousFocus.current?.isConnected) previousFocus.current.focus();
        });
    };
    const lock = async () => {
        if (access.state !== 'open' || operation.current || !model.files.hasOpenFiles()) return;
        protocolUi.cancel();
        const controller = new AbortController();
        operation.current = controller;
        previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialogs.current = Array.from(surface.current?.querySelectorAll<HTMLDialogElement>('dialog[open]') ?? []);
        for (const dialog of dialogs.current) dialog.close();
        surface.current?.setAttribute('inert', '');
        if (surface.current) surface.current.hidden = true;
        let epoch: number;
        try { epoch = access.beginSecuring(); }
        catch {
            operation.current = null;
            setGate({ epoch: access.epoch, ready: true, files: [], error: t('This session changed unexpectedly. Access remains suspended.') });
            return;
        }
        setGate({ epoch, ready: false, files: [], error: '' });
        const timeout = window.setTimeout(() => controller.abort(), 15_000);
        try {
            await Promise.all(model.files.map((file) => waitForSync(file, controller.signal)));
            await waitForPendingOperations(model, controller.signal);
            if (controller.signal.aborted || !access.isCurrent(epoch)) throw new Error('Lock canceled');
            savePendingDrafts();
            await saveAndLock(model, controller.signal);
            access.completeClose(epoch);
            access.resetClosedSession();
            setSettingsOpen(false);
            dialogs.current = [];
            reveal();
        } catch {
            controller.abort();
            if (!access.isCurrent(epoch)) return;
            const recoveryEpoch = access.requireRecovery(epoch);
            await prepareRecovery(recoveryEpoch);
        } finally {
            clearTimeout(timeout);
            if (operation.current === controller) operation.current = null;
        }
    };

    const commands = useVaultCommands(model, surface, {
        open: () => setOpeningAnother(true),
        settings: () => { setPasskeySettingsId(undefined); setSettingsOpen(true); },
        lock: () => void lock()
    });

    useEffect(() => {
        Events.on('user-idle', lock);
        Events.on('lock-workspace', lock);
        const stopEmbedded = EmbeddedVault.init();
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (model.files.hasDirtyFiles() || hasPendingDrafts()) {
                event.preventDefault();
                event.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', beforeUnload);
        return () => {
            stopEmbedded?.();
            Events.off('user-idle', lock);
            Events.off('lock-workspace', lock);
            window.removeEventListener('beforeunload', beforeUnload);
        };
    }, [model]);

    useEffect(() => {
        if (!__KW_NEW_EXTENSION__) return;
        const updateUnlock = () => setUnlockRequest(model.fileUnlockPromise);
        const showUnlock = () => {
            if (access.state === 'open' && !model.files.hasOpenFiles()) setSettingsOpen(false);
        };
        Events.on('unlock-message-changed', updateUnlock);
        Events.on('show-open-view', showUnlock);
        BrowserExtensionConnector.init(model, protocolUi, createSessionProtocolAccess(model));
        return () => {
            protocolUi.cancel();
            BrowserExtensionConnector.stop();
            Events.off('unlock-message-changed', updateUnlock);
            Events.off('show-open-view', showUnlock);
        };
    }, [model, protocolUi]);

    return (
        <>
        <PreferenceEffects />
        <NewProtocolUiHost controller={protocolUi} />
        <SaveVerificationWarning model={model} version={version} suspended={!!gate} />
        <UpdateNotice canReload={!model.files.hasOpenFiles() && !gate} />
        {!model.files.hasOpenFiles() && !gate ? settingsOpen && model.settings.canOpenSettings ? <Settings model={model} onBack={() => setSettingsOpen(false)} /> : <Unlock model={model}
            onSettings={() => { if (model.settings.canOpenSettings) setSettingsOpen(true); }}
            onPasskeySetup={(id) => { if (model.settings.canOpenSettings) { setPasskeySettingsId(id); setSettingsOpen(true); } }}
            extensionRequest={unlockRequest?.unlockRes === 'extensionUnlockMessage'}
            onCancelExtensionRequest={() => {
                if (unlockRequest && model.fileUnlockPromise === unlockRequest) {
                    model.rejectPendingFileUnlockPromise('Extension unlock canceled');
                }
            }} /> : <>
        {gate && <SessionRecovery key={gate.epoch} files={[...gate.files]} ready={gate.ready} error={gate.error}
            retry={() => void prepareRecovery(gate.epoch)}
            verify={(id, password, keyFile) => access.verifyVault(gate.epoch, id, { password, keyFile })}
            resume={() => {
                try {
                    operation.current?.abort();
                    access.resumeRecovery(gate.epoch);
                    IdleTracker.regUserAction();
                    model.syncScheduler.retryAll();
                    reveal();
                } catch {
                    setGate({ ...gate, error: t('The session changed. Access remains suspended.') });
                }
            }} />}
        <div ref={surface} hidden={!!gate} style={{ height: '100%' }}>
        {commands.content}
        <RemoteKeyRecovery model={model} />
        {closingFile && <CloseVault key={closingFile.id} model={model} file={closingFile} close={() => {
            setClosingFile(null);
            if (!model.files.hasOpenFiles()) { setSettingsOpen(false); setPasskeySettingsId(undefined); }
        }} />}
        {openingAnother && <MultiVaultOpen model={model} close={() => setOpeningAnother(false)}
            setupPasskey={id => { setPasskeySettingsId(id); setSettingsOpen(true); }} />}
        <div hidden={(settingsOpen && model.settings.canOpenSettings) || openingAnother} style={{ height: '100%' }}>
        <Vault
            model={model}
            version={version}
            onSave={commands.save}
            onGenerator={commands.generator}
            onSettings={() => { if (model.settings.canOpenSettings) { setPasskeySettingsId(undefined); setSettingsOpen(true); } }}
            onLock={() => void lock()}
            onCloseVault={closeFile}
            onOpenAnother={() => { if (access.state === 'open') setOpeningAnother(true); }}
        />
        </div>
        {settingsOpen && model.settings.canOpenSettings && <Settings model={model} onCloseVault={closeFile} passkeyVaultId={passkeySettingsId} extensionSessions={__KW_NEW_EXTENSION__ ? extensionSessions : undefined} onBack={() => { if (confirmDiscardDrafts('database')) setSettingsOpen(false); }} />}
        </div>
        </>}
        </>
    );
}

void startVault().then((model) => {
    render(<App model={model} />, document.getElementById('root')!);
    ServiceWorkerClient.init();
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
