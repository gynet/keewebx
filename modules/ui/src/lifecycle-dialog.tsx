import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { confirmDiscardDrafts } from './pending-drafts';
import { t } from './i18n';

export function LifecycleDialog({ title, confirm, check, apply, onClose, children, destructive = false }: {
    title: string; confirm: string; check: () => string; apply: () => void;
    onClose: () => void; children: ComponentChildren; destructive?: boolean;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const applied = useRef(false);
    const [error, setError] = useState('');
    const [supported, setSupported] = useState(true);
    useLayoutEffect(() => {
        const element = dialog.current!;
        const trigger = document.activeElement as HTMLElement | null;
        if (typeof element.showModal !== 'function') { setSupported(false); return; }
        element.showModal(); cancel.current?.focus();
        return () => {
            element.close();
            requestAnimationFrame(() => {
                if (trigger?.isConnected && !trigger.closest('[hidden], [inert]') && !trigger.matches(':disabled')) trigger.focus();
            });
        };
    }, []);
    const submit = () => {
        const visible = () => supported && dialog.current?.isConnected && dialog.current.open
            && !dialog.current.closest('[hidden], [inert]');
        if (applied.current || !visible()) return;
        let reason = check();
        if (reason) { setError(reason); return; }
        if (!confirmDiscardDrafts()) return;
        reason = check();
        if (reason) { setError(reason); return; }
        if (!visible()) return;
        // Shared operations are synchronous; a partial failure must never be delivered twice.
        applied.current = true;
        try { apply(); onClose(); }
        catch { setError(t('The change could not be completed. Cancel and check the database before trying again.')); }
    };
    if (!supported) return <div role="alert">
        <p>{t('This browser cannot open the dialog. Use a browser that supports modal dialogs.')}</p>
        <button type="button" class="pill" onClick={onClose}>{t('Cancel')}</button>
    </div>;
    return <dialog ref={dialog} aria-label={title} aria-modal="true"
        onCancel={event => { event.preventDefault(); onClose(); }}
        onKeyDown={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        style={{ width: 'min(440px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)',
            padding: '24px', margin: 'auto', overflow: 'auto', overflowWrap: 'anywhere',
            border: '1px solid var(--kx-line)', borderRadius: 'var(--kx-radius-card)',
            background: 'var(--kx-bg)', color: 'var(--kx-text)' }}>
        <form onSubmit={event => { event.preventDefault(); submit(); }}>
            <h2>{title}</h2>
            {children}
            {destructive && <p>{t('This cannot be undone.')}</p>}
            <p class="muted">{t('Unsaved drafts will require a separate discard confirmation.')}</p>
            {error && <p role="alert" class="error">{error}</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '16px' }}>
                <button ref={cancel} type="button" class="pill" onClick={onClose}>{t('Cancel')}</button>
                <button type="submit" disabled={applied.current} class={destructive ? 'pill pill--danger' : 'pill pill--primary'}>{confirm}</button>
            </div>
        </form>
    </dialog>;
}
