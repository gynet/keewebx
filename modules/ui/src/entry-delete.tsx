import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import { getSessionAccess } from 'comp/app/session-access';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { Events } from 'framework/events';
import { Icon } from 'ui-kit/mark';
import { confirmDiscardDrafts } from './pending-drafts';
import { t } from './i18n';

interface Selection {
    entry: EntryModel;
    object: EntryModel['entry'];
    file: FileModel;
    db: FileModel['db'];
    group: GroupModel;
    groupObject: GroupModel['group'];
    epoch: number;
    editSeq: number;
    binEnabled: boolean | undefined;
    binId: string | undefined;
    trash: boolean;
}

function inTrash(file: FileModel, group: GroupModel): boolean {
    const visited = new Set<GroupModel>();
    for (let current: GroupModel | null = group; current && !visited.has(current); current = current.parentGroup) {
        if (file.db.meta.recycleBinUuid?.equals(current.group.uuid)) return true;
        visited.add(current);
    }
    return false;
}

function unavailable(model: AppModel, selection: Selection): string {
    const { entry, file, group } = selection;
    const access = getSessionAccess(model);
    if (access.state !== 'open' || !access.isCurrent(selection.epoch)) return t('The session changed. Cancel and open the delete action again.');
    const changed = t('This entry or database changed. Cancel and open the delete action again.');
    if (!file.active || model.files.get(file.id) !== file || file.db !== selection.db
        || entry.file !== file || file.getEntry(entry.id) !== entry || entry.entry !== selection.object
        || entry.group !== group || file.getGroup(group.id) !== group || group.group !== selection.groupObject
        || entry.entry.parentGroup !== group.group || !group.group.entries.includes(entry.entry)
        || file.editSeq !== selection.editSeq || file.db.meta.recycleBinEnabled !== selection.binEnabled
        || file.db.meta.recycleBinUuid?.id !== selection.binId || inTrash(file, group) !== selection.trash) return changed;
    const visited = new Set<GroupModel>();
    for (let current: GroupModel | null = group; current; current = current.parentGroup) {
        if (visited.has(current) || current.file !== file || file.getGroup(current.id) !== current
            || current.group.parentGroup !== (current.parentGroup?.group ?? undefined)
            || !(current.parentGroup ? current.parentGroup.group.groups : file.db.groups).includes(current.group)) return changed;
        visited.add(current);
    }
    if ((file as FileModel & { readOnly?: boolean }).readOnly === true) return t('This database is read-only.');
    if (file.syncing) return t('A save is in progress. Wait for it to finish, then try again.');
    return '';
}

export function EntryDelete({ model, entry, onDeleted }: {
    model: AppModel; entry: EntryModel; onDeleted: () => void;
}) {
    const [selection, setSelection] = useState<Selection | null>(null);
    const [error, setError] = useState('');
    const trigger = useRef<HTMLButtonElement>(null);
    const applied = useRef(false);
    const file = entry.file as FileModel;
    const group = entry.group as GroupModel;
    const permanent = inTrash(file, group) || !file.db.meta.recycleBinEnabled;
    const apply = (target: Selection, canApply: () => boolean = () => true) => {
        if (applied.current || !canApply()) return;
        let reason = unavailable(model, target);
        if (reason) { setError(reason); return; }
        if (!confirmDiscardDrafts()) return;
        // A draft confirmation may outlive sync or recovery. Keep the original snapshot.
        reason = unavailable(model, target);
        if (reason) { setError(reason); return; }
        if (!canApply()) return;
        try {
            // Shared deletion can mutate before throwing; this confirmation is one-shot.
            applied.current = true;
            if (target.trash) target.entry.deleteFromTrash();
            else target.entry.moveToTrash();
            model.updateTags(); Events.emit('refresh'); onDeleted();
        } catch { setError(t('The deletion could not be completed. Cancel and check the database before trying again.')); }
    };
    const begin = () => {
        if (selection || applied.current) return;
        const next: Selection = { entry, object: entry.entry, file, db: file.db, group, groupObject: group.group,
            epoch: getSessionAccess(model).epoch, editSeq: file.editSeq,
            binEnabled: file.db.meta.recycleBinEnabled, binId: file.db.meta.recycleBinUuid?.id, trash: inTrash(file, group) };
        const reason = unavailable(model, next);
        if (reason) { setError(reason); return; }
        setError('');
        if (next.trash || !next.binEnabled) setSelection(next);
        else apply(next);
    };
    return <div>
        <button ref={trigger} type="button" class="pill pill--tinted pill--danger" onClick={begin}>
            <Icon name="trash" size={16} />
            {t(permanent ? 'Delete permanently…' : 'Move to Trash')}
        </button>
        {!selection && error && <p role="status">{error}</p>}
        {selection && <DeleteDialog model={model} selection={selection} trigger={trigger} error={error}
            applied={applied.current} onCancel={() => { setSelection(null); setError(''); }} onDelete={canApply => apply(selection, canApply)} />}
    </div>;
}

function DeleteDialog({ model, selection, trigger, error, applied, onCancel, onDelete }: {
    model: AppModel; selection: Selection; trigger: { current: HTMLButtonElement | null };
    error: string; applied: boolean; onCancel: () => void; onDelete: (canApply: () => boolean) => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const [supported, setSupported] = useState(true);
    const reason = unavailable(model, selection);
    useLayoutEffect(() => {
        const element = dialog.current!;
        if (typeof element.showModal !== 'function') { setSupported(false); return; }
        element.showModal(); cancel.current?.focus();
        return () => {
            element.close();
            requestAnimationFrame(() => {
                const button = trigger.current;
                if (getSessionAccess(model).state === 'open' && button?.isConnected && !button.closest('[hidden], [inert]')) button.focus();
            });
        };
    }, []);
    if (!supported) return <div role="alert">
        <p>{t('This browser cannot open the delete dialog. Use a browser that supports modal dialogs.')}</p>
        <button type="button" class="pill" onClick={onCancel}>{t('Cancel')}</button>
    </div>;
    return <dialog ref={dialog} aria-label={t('Permanently delete entry')} aria-modal="true"
        onCancel={event => { event.preventDefault(); onCancel(); }}
        onKeyDown={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        style={{ width: 'min(440px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)',
            padding: '24px', margin: 'auto', overflow: 'auto', overflowWrap: 'anywhere',
            border: '1px solid var(--kx-line)', borderRadius: 'var(--kx-radius-card)',
            background: 'var(--kx-bg)', color: 'var(--kx-text)' }}>
        <h2>{t('Permanently delete entry')}</h2>
        <p>{t('Permanently delete “{}”?', selection.entry.title || t('(no title)'))}</p>
        <p>{t('This cannot be undone. This entry, its history and its attachments will be removed from this database.')}</p>
        {!selection.trash && <p>{t('The recycle bin is disabled. This entry will not be moved to Trash.')}</p>}
        <p>{t('Unsaved drafts will require a separate discard confirmation.')}</p>
        {reason && <p role="alert" class="error">{reason}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            <button ref={cancel} type="button" class="pill" onClick={onCancel}>{t('Cancel')}</button>
            <button type="button" class="pill pill--danger" disabled={!!reason || applied} onClick={() => {
                const canApply = () => {
                    const element = dialog.current;
                    return !!(supported && element?.isConnected && element.open && !element.closest('[hidden], [inert]'));
                };
                if (canApply()) onDelete(canApply);
            }}>{t('Delete permanently')}</button>
        </div>
        {error && <p role="alert" class="error">{error}</p>}
    </dialog>;
}
