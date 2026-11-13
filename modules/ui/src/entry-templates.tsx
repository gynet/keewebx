import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import type { EntryModel } from 'models/entry-model';
import type { GroupModel } from 'models/group-model';
import { Events } from 'framework/events';
import { getSessionAccess } from 'comp/app/session-access';
import { EntryEditor, applyEntryDraft, makeDraft, type EntryDraft } from './entry-editor';
import { confirmDiscardDrafts } from './pending-drafts';
import { t } from './i18n';
import './entry-templates.css';

interface Target {
    file: FileModel; db: FileModel['db']; epoch: number; editSeq: number;
    source?: EntryModel; raw?: EntryModel['entry']; baseline?: string;
    mode: 'new' | 'edit' | 'use'; groups: GroupModel[];
}
const writable = (file: FileModel) => file.active && !(file as FileModel & { readOnly?: boolean }).readOnly;
function destinationGroups(file: FileModel): GroupModel[] {
    const groups: GroupModel[] = [];
    const visit = (group: GroupModel) => {
        if (group.visible === false || file.db.meta.recycleBinUuid?.equals(group.group.uuid)
            || file.db.meta.entryTemplatesGroup?.equals(group.group.uuid)) return;
        groups.push(group); for (const child of group.items ?? []) visit(child as GroupModel);
    };
    for (const root of file.groups) visit(root as GroupModel);
    return groups;
}
function path(group: GroupModel): string {
    const parts: string[] = [];
    const file = group.file as FileModel;
    for (let current: GroupModel | null = group; current; current = current.parentGroup) {
        const siblings = current.parentGroup?.group.groups ?? file.db.groups;
        const sameName = siblings.filter(sibling => file.getGroup(file.subId(sibling.uuid.id))?.title === current!.title);
        const title = !current.title || /[\/"\\()\u0000-\u001f]/.test(current.title) ? JSON.stringify(current.title) : current.title;
        parts.unshift(sameName.length > 1 ? t('{} ({})', title, String(sameName.indexOf(current.group) + 1)) : title);
    }
    return parts.join(' / ');
}

export function EntryTemplates({ model, groupId, onCreated }: {
    model: AppModel; groupId?: string; onCreated(entry: EntryModel): void;
}) {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    return <>
        <button ref={trigger} type="button" class="pill entry-list__create" disabled={!model.canCreateEntries()}
            onClick={() => { if (getSessionAccess(model).state === 'open' && confirmDiscardDrafts()) setOpen(true); }}>{t('Entry templates…')}</button>
        {open && <TemplatesDialog model={model} groupId={groupId} close={() => setOpen(false)} onCreated={onCreated} trigger={trigger} />}
    </>;
}
function TemplatesDialog({ model, groupId, close, onCreated, trigger }: {
    model: AppModel; groupId?: string; close(): void; onCreated(entry: EntryModel): void;
    trigger: { current: HTMLButtonElement | null };
}) {
    const files = [...model.files].filter(writable);
    const [fileId, setFileId] = useState(files.find(file => groupId && file.getGroup(groupId))?.id ?? files[0]?.id ?? '');
    const [target, setTarget] = useState<Target | null>(null);
    const [destination, setDestination] = useState('');
    const [message, setMessage] = useState('');
    const dialog = useRef<HTMLDialogElement>(null);
    const applied = useRef(false);
    useLayoutEffect(() => {
        const element = dialog.current!; element.showModal();
        return () => { element.close(); requestAnimationFrame(() => {
            if (getSessionAccess(model).state === 'open' && trigger.current?.isConnected && trigger.current.getClientRects().length) trigger.current.focus();
        }); };
    }, []);
    const choose = (mode: Target['mode'], file: FileModel, source?: EntryModel) => {
        if (getSessionAccess(model).state !== 'open' || !writable(file) || model.files.get(file.id) !== file || file.syncing) {
            setMessage(t('Wait for saving to finish, then reopen templates.')); return;
        }
        const groups = destinationGroups(file);
        const selected = groups.find(group => group.id === groupId) ?? groups[0];
        setDestination(selected?.id ?? ''); applied.current = false; setMessage('');
        setTarget({ mode, file, db: file.db, epoch: getSessionAccess(model).epoch, editSeq: file.editSeq, source, raw: source?.entry,
            baseline: source ? JSON.stringify(makeDraft(source, [])) : undefined, groups });
    };
    const save = (draft: EntryDraft) => {
        if (!target || applied.current) throw new Error('Template editor closed');
        const { file, source, mode } = target;
        const access = getSessionAccess(model);
        const allowed = (access.state === 'open' && access.epoch === target.epoch)
            || (access.state === 'securing' && access.epoch === target.epoch + 1);
        const group = target.groups.find(group => group.id === destination);
        if (!allowed || !writable(file) || model.files.get(file.id) !== file || file.db !== target.db || file.editSeq !== target.editSeq || file.syncing
            || (source && (file.getEntry(source.id) !== source || source.entry !== target.raw
                || source.group !== file.getEntryTemplatesGroup() || JSON.stringify(makeDraft(source, [])) !== target.baseline))
            || (mode === 'use' && (!group || file.getGroup(group.id) !== group || !destinationGroups(file).includes(group)))) {
            setMessage(t('This template or destination changed. Cancel and reopen templates after saving finishes.'));
            throw new Error('Template or destination changed');
        }
        let entry: EntryModel;
        if (mode === 'edit') entry = source!;
        else {
            const destinationGroup = mode === 'new' ? file.getEntryTemplatesGroup() ?? file.createEntryTemplatesGroup() : group!;
            entry = model.createNewEntryWithFields(destinationGroup, {});
            if (source) entry.copyFromTemplate(source);
        }
        applyEntryDraft(entry, draft);
        applied.current = true;
        model.updateTags(); Events.emit('entry-updated', { entry }); Events.emit('refresh');
        if (mode === 'use') { close(); onCreated(entry); }
        else { setTarget(null); setMessage(t('Template saved.')); }
    };
    const templates = model.getEntryTemplates().filter(({ file }) => writable(file));
    return <dialog ref={dialog} class="entry-templates" aria-label={t('Entry templates')}
        onCancel={event => { event.preventDefault(); if (confirmDiscardDrafts()) close(); }}>
        <div class="entry-templates__head"><h2>{t('Entry templates')}</h2>
            {!target && <button type="button" class="pill" onClick={close}>{t('Close')}</button>}</div>
        {target ? <>
            <p>{t(target.mode === 'use' ? 'Create an entry from this template in {}.' : target.mode === 'edit' ? 'Edit this template in {}.' : 'Create a template in {}.', target.file.name)}</p>
            {target.mode === 'use' && <label class="vault-form__field">{t('Destination group')}
                <select class="input" value={destination} onChange={event => setDestination(event.currentTarget.value)}>
                    {target.groups.map(group => <option key={group.id} value={group.id}>{path(group)}</option>)}
                </select></label>}
            {message && <p role="alert">{message}</p>}
            <EntryEditor key={`${target.mode}:${target.source?.id ?? target.file.id}`} model={model}
                entry={target.mode === 'edit' ? target.source! : null} draftSource={target.mode === 'use' ? target.source : undefined}
                onSave={save} onCancel={() => { setTarget(null); setMessage(''); }} />
        </> : <>
            <p>{t('Templates keep reusable fields, including empty and protected fields. Creating an entry leaves the template unchanged.')}</p>
            <label class="vault-form__field">{t('Template vault')}<select class="input" value={fileId} onChange={event => setFileId(event.currentTarget.value)}>
                {files.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}
            </select></label>
            <button type="button" class="pill" disabled={!files.some(file => file.id === fileId) || !!model.files.get(fileId)?.syncing}
                onClick={() => { const file = model.files.get(fileId); if (file) choose('new', file); }}>{t('New template')}</button>
            <ul class="entry-templates__list">{templates.map(({ file, entry }) => <li key={entry.id}>
                <div><strong>{entry.title || t('Untitled')}</strong><small>{file.name}</small></div>
                <button type="button" class="pill" disabled={file.syncing} onClick={() => choose('use', file, entry)}>{t('Use template')}</button>
                <button type="button" class="pill" disabled={file.syncing} onClick={() => choose('edit', file, entry)}>{t('Edit template')}</button>
            </li>)}</ul>
            {!templates.length && <p>{t('No entry templates yet.')}</p>}
            {message && <p role="status">{message}</p>}
        </>}
    </dialog>;
}
