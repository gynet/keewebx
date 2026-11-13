import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Events } from 'framework/events';
import { IdleTracker } from 'comp/browser/idle-tracker';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import { confirmDiscardDrafts, usePendingDraft } from './pending-drafts';
import { t } from './i18n';
import { getSessionAccess } from 'comp/app/session-access';
import { lifecycleSnapshot } from './lifecycle-guard';

export type GroupActionResult =
    | { action: 'create' | 'rename'; fileId: string; groupId: string; parentId: string }
    | { action: 'delete'; fileId: string; groupId: string; parentId: string; trashed: boolean };

export interface GroupActionsProps {
    model: AppModel;
    file: FileModel;
    /** Creation uses this parent; rename/delete use this target. A root permits creation only. */
    group: GroupModel;
    disabled?: boolean;
    /** Model mutation is complete, not necessarily persisted. Update selection using these IDs. */
    onComplete?: (result: GroupActionResult) => void;
    /** Focus fallback when a deleted group's trigger no longer exists. */
    getReturnFocus?: () => HTMLElement | null;
}

type Action = 'create' | 'rename' | 'delete';
interface Selection {
    action: Action;
    check: () => string;
    file: FileModel;
    group: GroupModel;
    object: GroupModel['group'];
    title: string;
    parentId: string | null;
    trashed: boolean;
    contents: string;
    trigger: HTMLElement | null;
}

function usesTrash(file: FileModel): boolean {
    return !!(file.db.meta.recycleBinEnabled && file.db.meta.recycleBinUuid);
}

function isRoot(file: FileModel, group: GroupModel): boolean {
    return group.top || !group.parentGroup || file.db.groups.includes(group.group);
}

function containsRecycleBin(file: FileModel, group: GroupModel['group']): boolean {
    const uuid = file.db.meta.recycleBinUuid;
    return !!uuid && (group.uuid.equals(uuid) || group.groups.some((child) => containsRecycleBin(file, child)));
}

function unavailable(model: AppModel, file: FileModel, group: GroupModel, action: Action): string {
    if (!file.active || model.files.get(file.id) !== file || group.file !== file
        || file.getGroup(group.id) !== group) {
        return t('This group is no longer available. Close this dialog and select it again.');
    }
    if ((file as FileModel & { readOnly?: boolean }).readOnly === true) {
        return t('This database is read-only.');
    }
    if (file.syncing) return t('A save is in progress. Wait for it to finish, then try again.');
    const recycleBin = file.db.meta.recycleBinUuid;
    let current: GroupModel | null = group;
    const visited = new Set<GroupModel>();
    while (current) {
        if (visited.has(current)) return t('This group is no longer available.');
        visited.add(current);
        if (recycleBin && current.group.uuid.equals(recycleBin)) {
            return t('Groups in the trash cannot be changed here.');
        }
        const parent: GroupModel | null = current.parentGroup;
        if (parent ? !parent.group.groups.includes(current.group) : !file.db.groups.includes(current.group)) {
            return t('This group is no longer available. Close this dialog and select it again.');
        }
        current = parent;
    }
    if (action !== 'create' && isRoot(file, group)) {
        return t('The database root cannot be renamed or deleted here.');
    }
    if (action === 'delete' && containsRecycleBin(file, group.group)) {
        return t('A group containing the recycle bin cannot be deleted here.');
    }
    return '';
}

function contents(group: GroupModel['group']): string {
    const pending = [group];
    const snapshot: unknown[] = [];
    while (pending.length) {
        const current = pending.pop()!;
        snapshot.push({
            id: current.uuid.toString(), name: current.name,
            entries: current.entries.map((entry) => entry.uuid.toString()),
            groups: current.groups.map((child) => child.uuid.toString())
        });
        pending.push(...current.groups);
    }
    return JSON.stringify(snapshot);
}

export function GroupActions({ model, file, group, disabled = false, onComplete, getReturnFocus }: GroupActionsProps) {
    const [selection, setSelection] = useState<Selection | null>(null);
    const [message, setMessage] = useState('');
    const toolbar = useRef<HTMLDivElement>(null);
    const begin = (action: Action) => {
        if (disabled || selection || getSessionAccess(model).state !== 'open') return;
        const reason = unavailable(model, file, group, action);
        if (reason) { setMessage(reason); return; }
        if (!confirmDiscardDrafts()) return;
        if (getSessionAccess(model).state !== 'open' || unavailable(model, file, group, action)) return;
        setMessage('');
        setSelection({
            action, check: lifecycleSnapshot(model, [file]), file, group, object: group.group, title: group.title,
            parentId: group.parentGroup?.id ?? null,
            trashed: usesTrash(file), contents: action === 'delete' ? contents(group.group) : '',
            trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null
        });
    };
    const finish = (result: GroupActionResult) => {
        setSelection(null);
        setMessage(t('Group changes applied. Check the database sync status.'));
        onComplete?.(result);
    };
    return <div ref={toolbar} role="group" aria-label={t('Group actions: {}', group.title)} tabIndex={-1}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {(['create', 'rename', 'delete'] as const).map((action) => {
                const reason = unavailable(model, file, group, action);
                return <button key={action} type="button"
                    class={`pill pill--tinted${action === 'delete' ? ' pill--danger' : ''}`}
                    disabled={disabled || !!selection || !!reason} title={reason || undefined}
                    onClick={() => begin(action)}>
                    {t(action === 'create' ? 'New group' : action === 'rename' ? 'Rename group' : 'Delete group')}
                </button>;
            })}
        </div>
        {message && <p role="status">{message}</p>}
        {selection && <GroupActionDialog model={model} selection={selection} disabled={disabled}
            onCancel={() => setSelection(null)} onComplete={finish}
            getReturnFocus={() => getReturnFocus?.() ?? toolbar.current} />}
    </div>;
}

function GroupActionDialog({ model, selection, disabled, onCancel, onComplete, getReturnFocus }: {
    model: AppModel;
    selection: Selection;
    disabled: boolean;
    onCancel: () => void;
    onComplete: (result: GroupActionResult) => void;
    getReturnFocus: () => HTMLElement | null;
}) {
    const { action, file, group } = selection;
    const [name, setName] = useState(action === 'rename' ? selection.title : '');
    const [error, setError] = useState('');
    const [available, setAvailable] = useState(true);
    const dialog = useRef<HTMLDialogElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const applied = useRef(false);
    const failed = useRef(false);
    const returnFocus = useRef(getReturnFocus);
    returnFocus.current = getReturnFocus;
    const title = t(action === 'create' ? 'New group' : action === 'rename' ? 'Rename group'
        : selection.trashed ? 'Move group to trash' : 'Permanently delete group');

    useLayoutEffect(() => {
        const element = dialog.current!;
        if (typeof element.showModal !== 'function') {
            setAvailable(false);
            setError(t('This browser cannot open the group dialog. Use a browser that supports modal dialogs.'));
            return;
        }
        element.showModal();
        if (action === 'delete') cancel.current?.focus();
        else { input.current?.focus(); input.current?.select(); }
        return () => {
            element.close();
            requestAnimationFrame(() => {
                const trigger = selection.trigger;
                if (trigger?.isConnected && !trigger.matches(':disabled')) trigger.focus();
                else returnFocus.current()?.focus();
            });
        };
    }, []);

    const apply = (savingDraft = false): boolean => {
        if (applied.current) return false;
        const securingDraft = savingDraft && action !== 'delete' && getSessionAccess(model).state === 'securing';
        if (disabled || !available || (!securingDraft && (getSessionAccess(model).state !== 'open'
            || !dialog.current?.isConnected || !dialog.current.open || dialog.current.closest('[hidden], [inert]')))) return false;
        let result: GroupActionResult;
        try {
            const reason = (action === 'delete' ? selection.check() : '') || unavailable(model, file, group, action);
            if (reason) throw new Error(reason);
            if (group.group !== selection.object || group.title !== selection.title
                || (group.parentGroup?.id ?? null) !== selection.parentId
                || (action === 'delete' && (usesTrash(file) !== selection.trashed || contents(group.group) !== selection.contents))) {
                throw new Error(t('This group changed while the dialog was open. Cancel and open the action again.'));
            }
            const trimmed = name.trim();
            if (action !== 'delete' && (!trimmed || name.length > 1024)) {
                setError(t('Enter a group name between 1 and 1024 characters.'));
                input.current?.focus();
                return false;
            }
            applied.current = true;
            if (action === 'create') {
                const created = model.createNewGroupWithName(group, file, trimmed);
                result = { action, fileId: file.id, groupId: created.id, parentId: group.id };
            } else if (action === 'rename') {
                if (trimmed !== group.title) group.setName(trimmed);
                result = { action, fileId: file.id, groupId: group.id, parentId: selection.parentId! };
            } else {
                group.moveToTrash();
                result = { action, fileId: file.id, groupId: group.id, parentId: selection.parentId!, trashed: selection.trashed };
            }
        } catch (error) {
            failed.current = applied.current;
            setError(error instanceof Error ? error.message : t('The group could not be changed.'));
            return false;
        }
        model.updateTags();
        Events.emit('refresh');
        onComplete(result);
        return true;
    };

    usePendingDraft(action !== 'delete' && (!applied.current || failed.current)
        && name !== (action === 'rename' ? selection.title : ''), () => apply(true), onCancel, 'group');

    if (!available) return <div role="alert">
        <p class="error">{error}</p>
        <button type="button" class="pill" onClick={onCancel}>{t('Cancel')}</button>
    </div>;

    return <dialog ref={dialog} aria-label={title} aria-modal="true"
        onCancel={(event) => { event.preventDefault(); onCancel(); }}
        onKeyDown={(event) => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={(event) => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        style={{
            width: 'min(440px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)',
            padding: '24px', margin: 'auto', overflow: 'auto', overflowWrap: 'anywhere',
            border: '1px solid var(--kx-line)', borderRadius: 'var(--kx-radius-card)',
            background: 'var(--kx-bg)', color: 'var(--kx-text)'
        }}>
        <form onSubmit={(event) => { event.preventDefault(); apply(); }}>
            <h2 style={{ margin: '0 0 16px' }}>{title}</h2>
            <p class="muted">{t('Database: {}', file.name)}</p>
            {action === 'delete' ? <p>{selection.trashed
                ? t('Move “{}” and all its subgroups and entries to trash?', selection.title)
                : t('Permanently delete “{}” and all its subgroups and entries? Trash is unavailable for this database. This cannot be undone.', selection.title)}</p>
                : <>
                    {action === 'create' && <p>{t('Parent group: {}', selection.title)}</p>}
                    <label class="vault-form__field">{t('Group name')}
                        <input ref={input} class="input" required maxLength={1024} value={name}
                            autoComplete="off" onInput={(event) => { setName(event.currentTarget.value); setError(''); }} />
                    </label>
                </>}
            {error && <p class="error" role="alert">{error}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: '8px', marginTop: '20px' }}>
                <button ref={cancel} type="button" class="pill" onClick={onCancel}>{t('Cancel')}</button>
                <button type="submit" disabled={disabled || applied.current}
                    class={action === 'delete' ? 'pill pill--tinted pill--danger' : 'pill pill--primary'}>
                    {t(action === 'create' ? 'Create group' : action === 'rename' ? 'Save name'
                        : selection.trashed ? 'Move to trash' : 'Delete permanently')}
                </button>
            </div>
        </form>
    </dialog>;
}
