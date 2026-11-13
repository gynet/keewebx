import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { SettingsStore } from 'comp/settings/settings-store';
import { getSessionAccess } from 'comp/app/session-access';
import { waitForSync } from 'comp/app/vault-files';
import { Storage } from 'storage';
import { beginPendingOperation, waitForPendingOperations } from './pending-operations';
import { hasPendingDrafts, savePendingDrafts } from './pending-drafts';
import { PromptDialog } from './extension-prompts';
import { t } from './i18n';

export function ClassicSwitch({ model }: { model: AppModel }) {
    const [open, setOpen] = useState(false);
    return <>
        <button role="radio" aria-checked="false" id="use-classic" onClick={() => setOpen(true)}>{t('Classic')}</button>
        {open && <SwitchDialog model={model} close={() => setOpen(false)} />}
    </>;
}

function SwitchDialog({ model, close }: { model: AppModel; close(): void }) {
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const operation = useRef<AbortController | null>(null), mounted = useRef(true);
    const access = getSessionAccess(model), epoch = useRef(access.epoch);
    useEffect(() => {
        const off = access.subscribeInvalidation(() => { operation.current?.abort(); close(); });
        return () => { mounted.current = false; operation.current?.abort(); off(); };
    }, []);
    const cancel = () => { operation.current?.abort(); close(); };
    const run = async () => {
        if (operation.current) return;
        const controller = new AbortController(); operation.current = controller;
        const timeout = setTimeout(() => controller.abort(), 30_000);
        const files = model.files.filter((file) => file.active && !file.demo).map((file) => ({ file, db: file.db }));
        const current = () => mounted.current && !controller.signal.aborted && access.state === 'open' &&
            access.epoch === epoch.current && model.files.filter((file) => file.active && !file.demo).length === files.length &&
            files.every(({ file, db }) => file.active && model.files.get(file.id) === file && file.db === db);
        const check = () => { if (!current()) throw new Error('The operation was canceled or the open vaults changed. Retry when ready.'); };
        let finish: (() => void) | undefined;
        setBusy(true); setError('');
        try {
            await waitForPendingOperations(model, controller.signal);
            await Promise.all(files.map(({ file }) => waitForSync(file, controller.signal)));
            check();
            try { savePendingDrafts(); }
            catch { throw new Error('Apply or discard invalid or credential edits before switching interfaces.'); }
            finish = beginPendingOperation(model);
            for (const { file } of files) {
                check();
                const readOnly = (file as typeof file & { readOnly?: boolean }).readOnly;
                if (readOnly && (file.dirty || file.modified)) throw new Error('A read-only vault has pending changes. Keep it open to recover them.');
                if (!readOnly) await new Promise<void>((resolve, reject) => {
                    const abort = () => reject(new Error('Saving was canceled. Keep the vault open and retry.'));
                    controller.signal.addEventListener('abort', abort, { once: true });
                    model.syncFile(file, { canContinue: current }, (failure) => {
                        controller.signal.removeEventListener('abort', abort);
                        failure ? reject(new Error(String(failure))) : resolve();
                    });
                });
                check();
                if (file.modified || file.dirty) throw new Error('Changes are still pending. Keep the vault open and retry.');
                if (!file.storage) {
                    const info = model.getFileInfo(file);
                    await new Promise<void>((resolve, reject) => Storage.cache.load(info?.id ?? file.id, null, (failure, data) =>
                        failure || !(data instanceof ArrayBuffer) || !data.byteLength
                            ? reject(new Error('The local copy is unavailable. Download a backup before leaving.')) : resolve()));
                }
            }
            check();
            if (hasPendingDrafts() || files.some(({ file }) => file.dirty || file.modified || file.syncing)) {
                throw new Error('New changes are pending. Retry before leaving.');
            }
            SettingsStore.saveRequired('file-info', model.fileInfos);
            const previous = AppSettingsModel.ui;
            try {
                AppSettingsModel.ui = 'classic';
                SettingsStore.saveRequired('app-settings', AppSettingsModel);
            } catch (failure) { AppSettingsModel.ui = previous; throw failure; }
            location.href = 'index.html?ui=classic';
        } catch (failure) {
            if (mounted.current && access.state === 'open' && access.epoch === epoch.current) {
                setError(`${t('Not switched. Your vaults and edits remain open.')} ${failure instanceof Error ? t(failure.message) : String(failure)}`);
            }
        } finally {
            clearTimeout(timeout); finish?.(); operation.current = null;
            if (mounted.current) setBusy(false);
        }
    };
    return <PromptDialog title={t('Switch to Classic')} icon="file" cancel={cancel} disabled={busy}
        confirm={() => void run()} confirmLabel={t(busy ? 'Saving…' : 'Save and switch')}>
        <p>{t('Save open drafts and synchronize your vaults before switching. If saving fails, stay here to retry. Cancel keeps this interface and your edits.')}</p>
        {error && <p role="alert">{error}</p>}
    </PromptDialog>;
}
