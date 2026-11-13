import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { getSessionAccess } from 'comp/app/session-access';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { Unlock } from './unlock';
import { t } from './i18n';
import './multi-vault-open.css';

/** Keep the existing workspace mounted; admission is revoked before closing this picker. */
export function MultiVaultOpen({ model, close, setupPasskey }: {
    model: AppModel; close(): void; setupPasskey(id: string): void;
}) {
    const access = getSessionAccess(model);
    const snapshot = useRef({ epoch: access.epoch, files: [...model.files] }).current;
    const active = useRef(true);
    const dialog = useRef<HTMLDialogElement>(null);
    const previousFocus = useRef(document.activeElement as HTMLElement | null);
    const [creating, setCreating] = useState(false);
    const canOpen = () => active.current && access.state === 'open' && access.isCurrent(snapshot.epoch) &&
        snapshot.files.every(file => file.active && model.files.get(file.id) === file);
    const finish = () => { active.current = false; close(); };
    useLayoutEffect(() => {
        const element = dialog.current!;
        element.showModal();
        const unsubscribe = access.subscribeInvalidation(finish);
        return () => {
            active.current = false; unsubscribe(); element.close();
            requestAnimationFrame(() => {
                const previous = previousFocus.current;
                if (access.state === 'open' && previous?.isConnected && !previous.closest('[hidden], [inert]')) previous.focus();
            });
        };
    }, []);
    return <dialog ref={dialog} class="multi-vault-open" aria-label={t('Open another vault')}
        onCancel={event => { event.preventDefault(); if (!creating) finish(); }}
        onKeyDown={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}>
        <header class="multi-vault-open__header">
            <div><h1>{t('Open another vault')}</h1><p>{t('Your open vaults and unsaved edits stay here.')}</p></div>
            <button type="button" class="pill" disabled={creating} onClick={finish}>{t('Cancel')}</button>
        </header>
        <Unlock model={model} canOpen={canOpen} onOpened={() => { if (canOpen()) finish(); }}
            onCreating={setCreating} onPasskeySetup={id => { if (canOpen()) setupPasskey(id); }} />
    </dialog>;
}
