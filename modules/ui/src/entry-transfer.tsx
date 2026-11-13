import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { prepareEntryTransfer, type TransferResult } from 'comp/app/entry-transfer';
import { getSessionAccess } from 'comp/app/session-access';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { Events } from 'framework/events';
import { beginPendingOperation } from './pending-operations';
import { confirmDiscardDrafts } from './pending-drafts';
import { t } from './i18n';

export type EntryTransferRequest = ReturnType<typeof prepareEntryTransfer>;

/** Mounted by Vault, so removing the source entry cannot unmount an in-flight save. */
export function EntryTransfer({ model, request, onClose, onResult }: {
    model: AppModel; request: EntryTransferRequest;
    onClose: () => void; onResult: (result: TransferResult) => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
    const controller = useRef(new AbortController()), submitted = useRef(false);
    const [destinationId, setDestinationId] = useState('');
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [supported, setSupported] = useState(true);
    const destination = request.destinations.find(item => item.group.id === destinationId);
    const reason = busy ? '' : request.check(destination);
    useLayoutEffect(() => {
        const element = dialog.current!, previous = document.activeElement as HTMLElement | null;
        if (typeof element.showModal !== 'function') { setSupported(false); return; }
        element.showModal(); cancel.current?.focus();
        const unsubscribe = getSessionAccess(model).subscribeInvalidation(() => {
            controller.current.abort(); element.close(); onClose();
        });
        return () => {
            controller.current.abort(); unsubscribe(); element.close();
            if (getSessionAccess(model).state === 'open' && previous?.isConnected
                && !previous.closest('[inert], [hidden]')) previous.focus();
        };
    }, []);
    const close = () => { if (busy) controller.current.abort(); else onClose(); };
    const move = async () => {
        const visible = () => dialog.current?.open && dialog.current.isConnected && !dialog.current.closest('[inert], [hidden]');
        if (!visible() || submitted.current || !destination) return;
        let problem = request.check(destination);
        if (problem) { setError(problem); return; }
        if (!confirmDiscardDrafts()) return;
        problem = request.check(destination);
        if (!visible() || problem) { setError(problem); return; }
        submitted.current = true; setBusy(true); setError('');
        const finish = beginPendingOperation(model);
        try {
            const result = await request.move(destination, controller.current.signal);
            Events.emit('refresh'); onResult(result); onClose();
        } catch (error) {
            setError(error instanceof Error ? error.message : t('Move failed. The source has not been removed.'));
        } finally { finish(); setBusy(false); }
    };
    if (!supported) return <div role="alert">
        <p>{t('This browser cannot open the move dialog.')}</p>
        <button type="button" class="pill" onClick={onClose}>{t('Cancel')}</button>
    </div>;
    return <dialog ref={dialog} aria-label={t('Move entry to another vault')} aria-modal="true"
        onCancel={event => { event.preventDefault(); close(); }}
        onKeyDown={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        style={{ width: 'min(460px, calc(100vw - 32px))', boxSizing: 'border-box', maxHeight: 'calc(100dvh - 32px)',
            margin: 'auto', padding: '20px', overflow: 'auto', overflowWrap: 'anywhere',
            border: '1px solid var(--kx-line)', borderRadius: 'var(--kx-radius-card)', background: 'var(--kx-bg)', color: 'var(--kx-text)' }}>
        <form onSubmit={event => { event.preventDefault(); void move(); }}>
            <h2>{t('Move entry to another vault')}</h2>
            <p>{t('The destination will be saved first. Then the entry will be removed from the source and the source saved. This does not use the trash.')}</p>
            <p>{t('Existing or deleted entry UUIDs are rejected, even if their content matches. Matching titles are allowed. Unsaved drafts are not included; you will be asked before discarding them.')}</p>
            <label class="vault-form__field">{t('Destination vault and group')}
                <select class="input" style={{ width: '100%', minWidth: 0 }} disabled={busy || submitted.current}
                    value={destinationId} onChange={event => { setDestinationId(event.currentTarget.value); setError(''); }}>
                    <option value="">{t('Choose a destination')}</option>
                    {request.destinations.map(item => <option key={item.group.id} value={item.group.id}>{item.label}</option>)}
                </select>
            </label>
            {!request.destinations.length && <p>{t('Open another writable vault, then reopen Move.')}</p>}
            {destination && <p>{t('Destination: {}', destination.label)}</p>}
            {busy && <p role="status">{t('Saving the move… Stopping may leave a destination copy; the result will say whether the source was removed.')}</p>}
            {(reason || error) && <p role="alert">{reason || error}</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '16px' }}>
                <button ref={cancel} type="button" class="pill" onClick={close}>{t(busy ? 'Stop move' : 'Cancel')}</button>
                <button type="submit" class="pill pill--primary" disabled={busy || submitted.current || !destination || !!reason}>
                    {t('Move and save both vaults')}
                </button>
            </div>
        </form>
    </dialog>;
}
