import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { Events } from 'framework/events';
import { getSessionAccess } from 'comp/app/session-access';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { t } from './i18n';
import './close-vault.css';

/** Dismissal belongs to this admitted model and deadline, never a later reopen. */
export function KeyChangeReminder({ model, enabled, version, change }: {
    model: AppModel; enabled: boolean; version: number; change(file: FileModel): void;
}) {
    const access = getSessionAccess(model);
    const dismissed = useRef(new WeakMap<FileModel, string>());
    const dialog = useRef<HTMLDialogElement>(null);
    const [tick, refresh] = useState(0);
    const signature = (file: FileModel) => `${+file.db.meta.keyChanged!}:${file.db.meta.keyChangeForce}`;
    const file = enabled && access.state === 'open' ? model.files.find(candidate => candidate.active &&
        candidate.isKeyChangePending(true) && dismissed.current.get(candidate) !== signature(candidate)) : undefined;
    const db = file?.db;
    const epoch = access.epoch;
    const stamp = file && signature(file);
    const current = () => !!file && enabled && access.state === 'open' && access.isCurrent(epoch) &&
        model.files.get(file.id) === file && file.active && file.db === db && signature(file) === stamp &&
        dismissed.current.get(file) !== stamp;
    const dismiss = () => {
        if (current()) dismissed.current.set(file!, stamp!);
        dialog.current?.close(); refresh(n => n + 1);
    };
    useEffect(() => {
        const update = () => refresh(n => n + 1);
        Events.on('key-change-pending', update);
        const unsubscribe = access.subscribeInvalidation(() => { dialog.current?.close(); update(); });
        return () => { Events.off('key-change-pending', update); unsubscribe(); };
    }, [model]);
    useEffect(() => {
        const element = dialog.current;
        if (!element || !file) return;
        // Opening and recovery dialogs take priority; wait for them to leave the top layer.
        const show = () => {
            if (current() && !element.open && !document.querySelector('dialog[open]')) element.showModal();
        };
        const observer = new MutationObserver(show);
        observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
        show();
        return () => { observer.disconnect(); element.close(); };
    }, [file, db, stamp, enabled, version, epoch, tick]);
    if (!file) return null;
    const name = model.files.filter(candidate => candidate.name === file.name).length > 1
        ? t('{} (vault {})', file.name, String(model.files.indexOf(file) + 1)) : file.name;
    return <dialog ref={dialog} class="close-vault" aria-label={t('Master key change reminder')}
        onCancel={event => { event.preventDefault(); dismiss(); }}
        onKeyDown={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}>
        <h2>{t('Time to change the master key')}</h2>
        <p>{t('The master key for {} is older than its configured deadline.', name)}</p>
        <p>{t('Review its credentials and save the database after changing them. Other open vaults and unsaved edits stay available.')}</p>
        <div class="close-vault__actions">
            <button type="button" class="pill" autoFocus onClick={dismiss}>{t('Remind me next time')}</button>
            <button type="button" class="pill pill--primary" onClick={() => {
                if (!current()) return;
                dismiss(); change(file);
            }}>{t('Review master key')}</button>
        </div>
    </dialog>;
}
