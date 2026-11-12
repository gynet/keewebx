import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import { getSessionAccess } from 'comp/app/session-access';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { Events } from 'framework/events';
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
    suffix: string;
}

function unavailable(model: AppModel, selection: Selection): string {
    const { entry, file, group } = selection;
    const access = getSessionAccess(model);
    if (access.state !== 'open' || !access.isCurrent(selection.epoch)) return t('The session changed. Cancel and open Make a copy again.');
    if (!file.active || model.files.get(file.id) !== file || file.db !== selection.db
        || entry.file !== file || file.getEntry(entry.id) !== entry || entry.entry !== selection.object
        || entry.group !== group || file.getGroup(group.id) !== group || group.group !== selection.groupObject
        || entry.entry.parentGroup !== group.group || !group.group.entries.includes(entry.entry)
        || file.editSeq !== selection.editSeq) return t('This entry changed. Cancel and open Make a copy again.');
    const visited = new Set<GroupModel>();
    for (let current: GroupModel | null = group; current; current = current.parentGroup) {
        if (visited.has(current) || current.file !== file || file.getGroup(current.id) !== current
            || file.db.meta.recycleBinUuid?.equals(current.group.uuid)
            || !(current.parentGroup ? current.parentGroup.group.groups : file.db.groups).includes(current.group)) {
            return t('Restore this entry from trash before making a copy.');
        }
        visited.add(current);
    }
    if ((file as FileModel & { readOnly?: boolean }).readOnly === true) return t('This database is read-only.');
    if (file.syncing) return t('A save is in progress. Wait for it to finish, then try again.');
    return '';
}

export function EntryClone({ model, entry, onCloned }: {
    model: AppModel; entry: EntryModel; onCloned: (id: string, groupId: string) => void;
}) {
    const [selection, setSelection] = useState<Selection | null>(null);
    const [error, setError] = useState('');
    const trigger = useRef<HTMLButtonElement>(null);
    const begin = () => {
        if (selection) return;
        const file = entry.file as FileModel;
        const group = entry.group as GroupModel;
        const next = { entry, object: entry.entry, file, db: file.db, group, groupObject: group.group,
            epoch: getSessionAccess(model).epoch, editSeq: file.editSeq, suffix: ` ${t('Copy')}` };
        const reason = unavailable(model, next);
        if (reason) { setError(reason); return; }
        setError(''); setSelection(next);
    };
    return <div>
        <button ref={trigger} type="button" class="pill pill--tinted" onClick={begin}>{t('Make a copy…')}</button>
        {error && <p role="status">{error}</p>}
        {selection && <CloneDialog model={model} selection={selection} trigger={trigger}
            onCancel={() => setSelection(null)} onCloned={id => {
                setSelection(null); onCloned(id, selection.group.id);
            }} />}
    </div>;
}

function CloneDialog({ model, selection, trigger, onCancel, onCloned }: {
    model: AppModel; selection: Selection; trigger: { current: HTMLButtonElement | null };
    onCancel: () => void; onCloned: (id: string) => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const applied = useRef(false);
    const [error, setError] = useState('');
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
    const clone = () => {
        if (applied.current || !supported) return;
        let reason = unavailable(model, selection);
        if (reason) { setError(reason); return; }
        if (!confirmDiscardDrafts()) return;
        // The discard prompt may outlive sync or reauthentication; never recapture its epoch.
        reason = unavailable(model, selection);
        if (reason) { setError(reason); return; }
        try {
            // A throwing shared mutation may already have created a record; do not retry it here.
            applied.current = true;
            const created = selection.entry.cloneEntry(selection.suffix);
            model.updateTags(); Events.emit('refresh'); onCloned(created.id);
        } catch { setError(t('The copy could not be completed. Close this dialog and check the database.')); }
    };
    if (!supported) return <div role="alert">
        <p>{t('This browser cannot open the copy dialog. Use a browser that supports modal dialogs.')}</p>
        <button type="button" class="pill" onClick={onCancel}>{t('Cancel')}</button>
    </div>;
    return <dialog ref={dialog} aria-label={t('Make a copy')} aria-modal="true"
        onCancel={event => { event.preventDefault(); onCancel(); }}
        onKeyDown={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        style={{ width: 'min(440px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)',
            padding: '24px', margin: 'auto', overflow: 'auto', overflowWrap: 'anywhere',
            border: '1px solid var(--kx-line)', borderRadius: 'var(--kx-radius-card)',
            background: 'var(--kx-bg)', color: 'var(--kx-text)' }}>
        <h2>{t('Make a copy')}</h2>
        {reason ? <p role="alert" class="error">{reason}</p> : <>
            <p>{t('Create “{}” in the same group?', selection.entry.title + selection.suffix)}</p>
            <p>{t('Copies the current entry’s fields and attachments. Earlier history versions are not copied.')}</p>
            <p>{t('Unsaved drafts are not included. You will be asked before discarding them.')}</p>
        </>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            <button ref={cancel} type="button" class="pill" onClick={onCancel}>{t('Cancel')}</button>
            <button type="button" class="pill pill--primary" disabled={!!reason || applied.current} onClick={clone}>{t('Create copy')}</button>
        </div>
        {error && <p role="alert" class="error">{error}</p>}
    </dialog>;
}
