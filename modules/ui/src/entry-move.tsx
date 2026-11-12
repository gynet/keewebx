import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import { Events } from 'framework/events';
import { getSessionAccess } from 'comp/app/session-access';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { confirmDiscardDrafts } from './pending-drafts';
import { t } from './i18n';

interface GroupReference {
    model: GroupModel;
    object: GroupModel['group'];
    parent: GroupModel | null;
    title: string;
    position: number;
    label: string;
    sameNameCount: number;
}
interface Destination {
    id: string;
    path: string;
    chain: GroupReference[];
}
interface Selection {
    file: FileModel;
    db: FileModel['db'];
    entry: EntryModel;
    object: EntryModel['entry'];
    source: GroupModel;
    editSeq: number;
    epoch: number;
    destinations: Destination[];
    restore: boolean;
    suggestedId: string;
    originalAvailable: boolean;
}

// Check actual parent membership, not just a possibly stale group ID/index.
function groupChain(file: FileModel, group: GroupModel, allowTrash = false): GroupReference[] | null {
    const chain: GroupReference[] = [];
    const visited = new Set<GroupModel>();
    for (let current: GroupModel | null = group; current; current = current.parentGroup) {
        if (visited.has(current) || current.file !== file || file.getGroup(current.id) !== current
            || (!allowTrash && file.db.meta.recycleBinUuid?.equals(current.group.uuid))) return null;
        visited.add(current);
        const parent: GroupModel | null = current.parentGroup;
        const siblings = parent ? parent.group.groups : file.db.groups;
        const position = siblings.indexOf(current.group);
        if (position < 0) return null;
        const title = current.title;
        const sameName = siblings.filter(sibling => file.getGroup(file.subId(sibling.uuid.id))?.title === title);
        // Quote reserved path/ordinal characters so a literal "Work / Archive"
        // or "Work (1)" cannot masquerade as ancestry or a generated ordinal.
        const name = !title || /[\/"\\()\u0000-\u001f]/.test(title) ? JSON.stringify(title) : title;
        const label = sameName.length > 1 ? t('{} ({})', name, String(sameName.indexOf(current.group) + 1)) : name;
        chain.unshift({ model: current, object: current.group, parent, title, position, label, sameNameCount: sameName.length });
    }
    return chain;
}

function unavailable(model: AppModel, entry: EntryModel, restore = false): string {
    const file = entry.file as FileModel;
    if (getSessionAccess(model).state !== 'open') return t('Unlock the database before moving an entry.');
    if (!file.active || model.files.get(file.id) !== file || file.getEntry(entry.id) !== entry
        || !(entry.group as GroupModel).group.entries.includes(entry.entry)
        || entry.entry.parentGroup !== (entry.group as GroupModel).group) {
        return t(restore ? 'This entry changed. Cancel and open Restore again.' : 'This entry is no longer available outside the trash.');
    }
    const chain = groupChain(file, entry.group as GroupModel, restore);
    if (!chain) return t('This entry changed. Cancel and reopen the entry.');
    if (restore && !chain.some(group => file.db.meta.recycleBinUuid?.equals(group.object.uuid))) {
        return t('This entry is no longer in trash. Cancel and reopen the entry.');
    }
    if ((file as FileModel & { readOnly?: boolean }).readOnly === true) return t('This database is read-only.');
    if (file.syncing) return t('A save is in progress. Wait for it to finish, then try again.');
    return '';
}

function destinations(file: FileModel): Destination[] {
    const result: Destination[] = [];
    const visited = new Set<GroupModel>();
    const visit = (group: GroupModel) => {
        if (visited.has(group)) return;
        visited.add(group);
        const chain = groupChain(file, group);
        if (!chain) return;
        result.push({ id: group.id, path: chain.map(({ label }) => label).join(' / '), chain });
        for (const child of group.group.groups) {
            const childModel = file.getGroup(file.subId(child.uuid.id));
            if (childModel) visit(childModel);
        }
    };
    for (const root of file.groups) visit(root);
    return result;
}

function changed(model: AppModel, selection: Selection, destination?: Destination): string {
    const { file, entry } = selection;
    const access = getSessionAccess(model);
    if (access.state !== 'open' || !access.isCurrent(selection.epoch)) {
        return t(selection.restore ? 'The session changed. Cancel and open Restore again.' : 'The session changed. Cancel and open Move to group again.');
    }
    const reason = unavailable(model, entry, selection.restore);
    if (reason) return reason;
    if (entry.file !== file || file.db !== selection.db || entry.entry !== selection.object
        || entry.group !== selection.source || file.editSeq !== selection.editSeq) {
        return t(selection.restore ? 'This entry changed. Cancel and open Restore again.' : 'This entry changed. Cancel and open Move to group again.');
    }
    if (destination) {
        const current = groupChain(file, destination.chain[destination.chain.length - 1].model);
        if (!current || current.length !== destination.chain.length || current.some((item, index) => {
            const original = destination.chain[index];
            return item.model !== original.model || item.object !== original.object
                || item.parent !== original.parent || item.title !== original.title
                || item.position !== original.position || item.label !== original.label;
        })) return t('The destination changed. Cancel and choose a group again.');
    }
    return '';
}

/** Entry-only, same-vault movement. No new records or cross-vault import/delete. */
export function EntryMove({ model, entry, onMoved, restore = false }: {
    model: AppModel;
    entry: EntryModel;
    onMoved: (entryId: string, groupId: string) => void;
    restore?: boolean;
}) {
    const [selection, setSelection] = useState<Selection | null>(null);
    const [message, setMessage] = useState('');
    const trigger = useRef<HTMLButtonElement>(null);
    const reason = unavailable(model, entry, restore);
    const begin = () => {
        if (selection || unavailable(model, entry, restore) || (!restore && !confirmDiscardDrafts())) return;
        // The discard confirmation can outlive a sync or session transition.
        const reason = unavailable(model, entry, restore);
        if (reason) { setMessage(reason); return; }
        const file = entry.file as FileModel;
        const choices = destinations(file);
        const original = restore && entry.entry.previousParentGroup
            ? choices.find(destination => destination.id === file.subId(entry.entry.previousParentGroup!.id)) : undefined;
        const suggested = original ?? (restore ? choices.find(destination => destination.chain.length === 1) : undefined);
        setMessage('');
        setSelection({ file, db: file.db, entry, object: entry.entry,
            source: entry.group as GroupModel, editSeq: file.editSeq,
            epoch: getSessionAccess(model).epoch, destinations: choices, restore,
            suggestedId: suggested?.id ?? '', originalAvailable: !!original });
    };
    return <div>
        <button ref={trigger} type="button" class="pill pill--tinted" disabled={!!reason || !!selection}
            title={reason || undefined} onClick={begin}>{t(restore ? 'Restore' : 'Move to group…')}</button>
        {message && <p role="status">{message}</p>}
        {selection && <MoveDialog model={model} selection={selection} trigger={trigger}
            onCancel={() => setSelection(null)} onMoved={(groupId) => {
                setSelection(null);
                setMessage(t(selection.restore ? 'Entry restored. Check the database sync status.' : 'Entry moved. Check the database sync status.'));
                onMoved(selection.entry.id, groupId);
            }} />}
    </div>;
}

function MoveDialog({ model, selection, trigger, onCancel, onMoved }: {
    model: AppModel;
    selection: Selection;
    trigger: { current: HTMLButtonElement | null };
    onCancel: () => void;
    onMoved: (groupId: string) => void;
}) {
    const [destinationId, setDestinationId] = useState(selection.suggestedId);
    const [error, setError] = useState('');
    const [supported, setSupported] = useState(true);
    const dialog = useRef<HTMLDialogElement>(null);
    const select = useRef<HTMLSelectElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const applied = useRef(false);
    const destination = selection.destinations.find(({ id }) => id === destinationId);
    const reason = changed(model, selection, destination);
    useLayoutEffect(() => {
        const element = dialog.current!;
        if (typeof element.showModal !== 'function') {
            setSupported(false);
            setError(t('This browser cannot open the move dialog. Use a browser that supports modal dialogs.'));
            return;
        }
        element.showModal();
        if (selection.restore) cancel.current?.focus(); else select.current?.focus();
        return () => {
            element.close();
            requestAnimationFrame(() => {
                const button = trigger.current;
                if (getSessionAccess(model).state === 'open' && button?.isConnected
                    && !button.disabled && !button.closest('[hidden], [inert]')) button.focus();
            });
        };
    }, []);

    const move = () => {
        if (applied.current || !supported) return;
        let reason = changed(model, selection, destination);
        if (reason) { setError(reason); return; }
        if (!destination || destination.id === selection.source.id) return;
        if (selection.restore) {
            if (!confirmDiscardDrafts()) return;
            reason = changed(model, selection, destination);
            if (reason) { setError(reason); return; }
        }
        try {
            // No await between final validation and the existing synchronous model mutation.
            destination.chain[destination.chain.length - 1].model.moveHere(selection.entry);
            applied.current = true;
            Events.emit('refresh');
            onMoved(destination.id);
        } catch {
            setError(t('The entry could not be moved. Close this dialog and check the database.'));
        }
    };
    if (!supported) return <div role="alert">
        <p>{error}</p>
        <button type="button" class="pill" onClick={onCancel}>{t('Cancel')}</button>
    </div>;
    return <dialog ref={dialog} aria-label={t(selection.restore ? 'Restore entry to group' : 'Move entry to group')} aria-modal="true"
        onCancel={(event) => { event.preventDefault(); onCancel(); }}
        onKeyDown={(event) => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={(event) => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        style={{ width: 'min(440px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)',
            padding: '24px', margin: 'auto', overflow: 'auto', overflowWrap: 'anywhere',
            border: '1px solid var(--kx-line)', borderRadius: 'var(--kx-radius-card)',
            background: 'var(--kx-bg)', color: 'var(--kx-text)' }}>
        <form onSubmit={(event) => { event.preventDefault(); move(); }}>
            <h2 style={{ margin: '0 0 16px' }}>{t(selection.restore ? 'Restore entry to group' : 'Move entry to group')}</h2>
            <p>{t('Choose a destination in {}.', selection.file.name)}</p>
            {selection.restore && <p>{t(selection.originalAvailable
                ? 'The original group is suggested. You can choose another group before restoring.'
                : 'The original group is unavailable or was not recorded. The vault root is suggested; choose a destination before restoring.')}</p>}
            {selection.restore && <p>{t('Unsaved drafts are not included. You will be asked before discarding them.')}</p>}
            {selection.destinations.some(({ chain }) => chain.some(group => group.sameNameCount > 1))
                && <p>{t('Groups with the same name are numbered in their current order.')}</p>}
            <label class="vault-form__field">{t('Destination group')}
                <select ref={select} class="input" style={{ width: '100%', minWidth: 0 }} value={destinationId}
                    onChange={(event) => { setDestinationId(event.currentTarget.value); setError(''); }}>
                    <option value="">{t('Choose a group')}</option>
                    {selection.destinations.map(({ id, path }) => <option key={id} value={id} disabled={id === selection.source.id}>
                        {id === selection.source.id ? t('{} (current group)', path) : path}
                    </option>)}
                </select>
            </label>
            {destination && <p>{t('Destination: {}', destination.path)}</p>}
            {(reason || error) && <p class="error" role="alert">{reason || error}</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '16px' }}>
                <button ref={cancel} type="button" class="pill" onClick={onCancel}>{t('Cancel')}</button>
                <button type="submit" class="pill pill--primary"
                    disabled={!destination || destination.id === selection.source.id || !!reason || !!error}>{t(selection.restore ? 'Restore' : 'Move')}</button>
            </div>
        </form>
    </dialog>;
}
