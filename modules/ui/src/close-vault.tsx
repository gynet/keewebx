import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { getSessionAccess } from 'comp/app/session-access';
import { waitForSync } from 'comp/app/vault-files';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { beginPendingOperation, waitForPendingOperations } from './pending-operations';
import { discardPendingDrafts, hasPendingDrafts, savePendingDrafts } from './pending-drafts';
import { t } from './i18n';
import './close-vault.css';

/** Save and close one admitted model. Cancel/timeout never authorizes a late close. */
export function CloseVault({ model, file, close }: { model: AppModel; file: FileModel; close(): void }) {
    const access = getSessionAccess(model);
    const snapshot = useRef({ epoch: access.epoch, db: file.db }).current;
    const dialog = useRef<HTMLDialogElement>(null);
    const previousFocus = useRef(document.activeElement as HTMLElement | null);
    const mounted = useRef(true);
    const operation = useRef<AbortController | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [discarding, setDiscarding] = useState(false);
    const available = () => mounted.current && access.state === 'open' && access.isCurrent(snapshot.epoch) &&
        file.active && model.files.get(file.id) === file && file.db === snapshot.db;
    const cancel = () => { operation.current?.abort(); close(); };
    useLayoutEffect(() => {
        const element = dialog.current!;
        element.showModal();
        const unsubscribe = access.subscribeInvalidation(cancel);
        return () => {
            mounted.current = false; operation.current?.abort(); unsubscribe(); element.close();
            requestAnimationFrame(() => {
                const previous = previousFocus.current;
                if (access.state === 'open' && previous?.isConnected && !previous.closest('[hidden], [inert]')) previous.focus();
            });
        };
    }, []);
    const finishClose = async (discard: boolean) => {
        if (operation.current) return;
        const controller = new AbortController();
        operation.current = controller; setBusy(true); setError('');
        const current = () => !controller.signal.aborted && available();
        const check = () => { if (!current()) throw new Error(t('The vault changed or closing was canceled. Keep it open and retry.')); };
        const finish = beginPendingOperation(model, file.id);
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
            check();
            await waitForPendingOperations(model, controller.signal, file.id, finish);
            await waitForSync(file, controller.signal);
            check();
            if (!discard) {
                if (!file.demo && !file.storage && model.settings.disableOfflineStorage) {
                    throw new Error(t('Browser storage is disabled. Download an encrypted copy before explicitly closing without saving, or enable storage and retry.'));
                }
                // Apply only this vault's drafts, retaining the editors until persistence succeeds.
                savePendingDrafts(file.id, true);
                check();
                const editSeq = file.editSeq;
                if (!file.demo && (file.dirty || file.modified)) {
                    await new Promise<void>((resolve, reject) => {
                        const abort = () => { cleanup(); reject(new Error(t('Closing timed out or was canceled. The vault remains open.'))); };
                        const cleanup = () => controller.signal.removeEventListener('abort', abort);
                        controller.signal.addEventListener('abort', abort, { once: true });
                        if (controller.signal.aborted) { abort(); return; }
                        try {
                            model.syncFile(file, { canContinue: current }, error => {
                                cleanup(); error ? reject(new Error(String(error))) : resolve();
                            });
                        } catch (error) { cleanup(); reject(error); }
                    });
                }
                check();
                if (!file.demo && (file.dirty || file.modified || file.syncing || file.editSeq !== editSeq || hasPendingDrafts(file.id))) {
                    throw new Error(t('Changes are still pending. The vault remains open; retry saving.'));
                }
            }
            check();
            // Explicit discard affects only still-unapplied UI drafts. Existing durable copies
            // and recent connection/passkey records are deliberately retained by closeFile.
            discardPendingDrafts(undefined, file.id);
            model.closeFile(file);
            close();
        } catch (error) {
            if (mounted.current && access.state === 'open') {
                setError(error instanceof Error ? error.message : t('Could not close this vault. Your changes remain open.'));
            }
        } finally {
            clearTimeout(timeout); finish();
            if (operation.current === controller) operation.current = null;
            if (mounted.current) setBusy(false);
        }
    };
    const dirty = file.dirty || file.modified || hasPendingDrafts(file.id) || (!file.storage && model.settings.disableOfflineStorage);
    return <dialog ref={dialog} class="close-vault" aria-label={t('Close vault: {}', file.name)}
        onCancel={event => { event.preventDefault(); cancel(); }}
        onKeyDown={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}>
        <h2>{t('Close {}?', t('{} (vault {})', file.name, String(model.files.indexOf(file) + 1)))}</h2>
        <p>{t('Only this vault will close. Other open vaults and their edits stay available.')}</p>
        <p>{t('Save and close saves this vault even when automatic saving is off. Its recent entry, passkey registration and saved copies are kept.')}</p>
        {discarding && <p role="alert">{t('Discard changes still in memory and close this vault? Changes already saved to browser storage or WebDAV are kept. An unsaved new vault may be lost. This cannot be undone.')}</p>}
        {error && <p class="error" role="alert">{error}</p>}
        {busy && <p role="status">{t('Waiting for this vault’s pending work and save…')}</p>}
        <div class="close-vault__actions">
            <button type="button" class="pill" onClick={cancel} autoFocus>{t('Cancel')}</button>
            {discarding ? <button type="button" class="pill" disabled={busy} onClick={() => void finishClose(true)}>{t('Discard remaining changes and close')}</button>
                : <>
                    {dirty && <button type="button" class="pill" disabled={busy} onClick={() => setDiscarding(true)}>{t('Close without saving…')}</button>}
                    <button type="button" class="pill pill--primary" disabled={busy} onClick={() => void finishClose(false)}>{t('Save and close')}</button>
                </>}
        </div>
    </dialog>;
}
