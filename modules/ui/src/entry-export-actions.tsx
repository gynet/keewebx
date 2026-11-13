import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ProtectedValue } from 'kdbxweb';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import { KdbxToHtml } from 'comp/format/kdbx-to-html';
import { getSessionAccess } from 'comp/app/session-access';
import { VaultApi } from 'comp/app/vault-api';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { t } from './i18n';

const text = (value: unknown) => value instanceof ProtectedValue ? value.getText() : String(value ?? '');

/** Drag exports plaintext only through an explicit user gesture; Copy is the touch alternative. */
export function dragField(model: AppModel, entry: EntryModel, value: string, event: DragEvent) {
    const file = entry.file as FileModel, target = event.currentTarget as HTMLElement;
    if (!value || getSessionAccess(model).state !== 'open' || !file.active || model.files.get(file.id) !== file
        || file.getEntry(entry.id) !== entry || !target.isConnected || target.closest('[hidden], [inert]')) {
        event.preventDefault(); return;
    }
    event.dataTransfer?.setData('text/plain', value);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
}

export function EntryExportActions({ model, entry }: { model: AppModel; entry: EntryModel }) {
    const [request, setRequest] = useState<{ share: boolean; check: () => boolean; epoch: number } | null>(null);
    const [message, setMessage] = useState('');
    const begin = (share: boolean) => {
        const file = entry.file as FileModel, db = file.db, raw = entry.entry, seq = file.editSeq;
        const access = getSessionAccess(model), epoch = access.epoch;
        const check = () => access.state === 'open' && access.isCurrent(epoch) && file.active
            && model.files.get(file.id) === file && file.db === db && entry.entry === raw
            && file.getEntry(entry.id) === entry && file.editSeq === seq;
        if (!check()) return;
        setMessage(''); setRequest({ share, check, epoch });
    };
    return <div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            <button type="button" class="pill pill--tinted" onClick={() => begin(false)}>{t('Copy formatted entry…')}</button>
            <button type="button" class="pill pill--tinted" disabled={!entry.password?.getText()} onClick={() => begin(true)}>{t('Share password…')}</button>
        </div>
        {message && <p role="status">{message}</p>}
        {request && <ExportDialog model={model} entry={entry} request={request} onClose={() => setRequest(null)}
            onDone={value => { setMessage(value); setRequest(null); }} />}
    </div>;
}

function ExportDialog({ model, entry, request, onClose, onDone }: {
    model: AppModel; entry: EntryModel;
    request: { share: boolean; check: () => boolean; epoch: number };
    onClose: () => void; onDone: (message: string) => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [fallback, setFallback] = useState(typeof navigator.share !== 'function');
    const submitted = useRef(false);
    useLayoutEffect(() => {
        const element = dialog.current!, previous = document.activeElement as HTMLElement | null;
        if (typeof element.showModal !== 'function') { onClose(); return; }
        element.showModal(); cancel.current?.focus();
        const unsubscribe = getSessionAccess(model).subscribeInvalidation(() => { element.close(); onClose(); });
        return () => {
            unsubscribe(); element.close();
            if (getSessionAccess(model).state === 'open' && previous?.isConnected && !previous.closest('[hidden], [inert]')) previous.focus();
        };
    }, []);
    const available = () => request.check() && dialog.current?.open && dialog.current.isConnected && !dialog.current.closest('[hidden], [inert]');
    const apply = async () => {
        if (submitted.current || !available()) return;
        submitted.current = true; setBusy(true); setError('');
        try {
            if (request.share && !fallback) {
                await navigator.share({ title: entry.title || t('Password'), text: entry.password.getText() });
                if (available()) onDone(t('Password shared.'));
            } else {
                const plain = request.share ? entry.password.getText() : [
                    ...[...entry.entry.fields].map(([name, value]) => `${name}: ${text(value)}`),
                    `Tags: ${entry.tags.join(', ')}`,
                    ...[...entry.entry.binaries.keys()].map(name => `${t('Attachment')}: ${name}`)
                ].join('\n');
                if (!request.share && typeof ClipboardItem === 'function' && typeof navigator.clipboard.write === 'function') {
                    const html = KdbxToHtml.entryToHtml((entry.file as FileModel).db, entry.entry);
                    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([plain], { type: 'text/plain' }),
                        'text/html': new Blob([html], { type: 'text/html' }) })]);
                } else await navigator.clipboard.writeText(plain);
                // Register cleanup even when an authorized write finishes after locking.
                VaultApi.copied({ text: plain, password: !!entry.password.getText(), sessionEpoch: request.epoch });
                if (available()) onDone(t(request.share ? 'Password copied.' : 'Entry copied.'));
            }
        } catch (error) {
            if (!available()) return;
            if (request.share && !fallback) {
                if ((error as { name?: string }).name === 'AbortError') { onDone(t('Sharing canceled.')); return; }
                setFallback(true); setError(t('Sharing is unavailable. You can copy the password instead.'));
            } else setError(t('Could not copy. Check clipboard permission and try again.'));
            submitted.current = false;
        } finally { setBusy(false); }
    };
    return <dialog ref={dialog} aria-label={t(request.share ? 'Share password' : 'Copy formatted entry')} aria-modal="true"
        onCancel={event => { event.preventDefault(); onClose(); }}
        onClick={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onKeyDown={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        style={{ width: 'min(440px, calc(100vw - 32px))', boxSizing: 'border-box', maxHeight: 'calc(100dvh - 32px)',
            margin: 'auto', padding: '20px', overflow: 'auto', overflowWrap: 'anywhere', border: '1px solid var(--kx-line)',
            borderRadius: 'var(--kx-radius-card)', background: 'var(--kx-bg)', color: 'var(--kx-text)' }}>
        <h2>{t(request.share ? 'Share password' : 'Copy formatted entry')}</h2>
        <p>{t(request.share ? 'The password will be shared as plain text with the app you choose.'
            : 'Copy this entry as unencrypted content, including hidden secrets and attachment download links? Plain-text paste includes fields and attachment names. Only applied entry content is included.')}</p>
        {request.share && fallback && <p>{t('Sharing is unavailable in this browser. Copy the password instead?')}</p>}
        {!request.check() && <p role="alert">{t('The entry or session changed. Cancel and reopen this action.')}</p>}
        {error && <p role="alert">{error}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            <button ref={cancel} type="button" class="pill" onClick={onClose}>{t('Cancel')}</button>
            <button type="button" class="pill pill--primary" disabled={busy || !request.check()} onClick={() => void apply()}>
                {t(request.share ? fallback ? 'Copy password instead' : 'Share password' : 'Copy entry')}
            </button>
        </div>
    </dialog>;
}
