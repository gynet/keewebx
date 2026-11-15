import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import { GroupActions } from './group-actions';
import { GroupLifecycle } from './group-lifecycle';
import { GroupIcon } from './group-appearance';
import { groupChain, inTrash } from './lifecycle-guard';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { getSessionAccess } from 'comp/app/session-access';
import { t } from './i18n';
import './phone-groups.css';

export function PhoneGroups({ model, files, initial, initialActions = false, onClose, onSelect }: {
    model: AppModel; files: FileModel[]; initial?: string; initialActions?: boolean;
    onClose: () => void; onSelect: (group: GroupModel) => void;
}) {
    const epoch = getSessionAccess(model).epoch;
    const [current, setCurrent] = useState(initial ?? '');
    const [actions, setActions] = useState(initialActions);
    const [message, setMessage] = useState('');
    const dialog = useRef<HTMLDialogElement>(null);
    const scroll = useRef<HTMLDivElement>(null);
    const heading = useRef<HTMLHeadingElement>(null);
    const more = useRef<HTMLButtonElement>(null);
    // Closing a vault clears its collections. Never dereference a stale target.
    const available = files.filter(file => file.active && model.files.get(file.id) === file);
    const roots = available.flatMap(file => Array.from(file.groups));
    const group = available.map(file => file.getGroup(current)).find(item => item && !inTrash(item.file as FileModel, item));
    const file = group?.file as FileModel | undefined;
    const path = group && file ? groupChain(file, group)?.map(item => item.title).join(' / ') : '';
    const children = group ? (Array.from(group.items ?? []) as GroupModel[]).filter(item => item.visible !== false && !inTrash(item.file as FileModel, item)) : roots;
    const currentSession = () => getSessionAccess(model).state === 'open' && getSessionAccess(model).isCurrent(epoch);
    const navigate = (next?: GroupModel) => { if (!currentSession()) return; setCurrent(next?.id ?? ''); setActions(false); setMessage(''); };
    useLayoutEffect(() => {
        const element = dialog.current!;
        element.showModal(); heading.current?.focus();
        return () => element.close();
    }, []);
    useLayoutEffect(() => { scroll.current?.scrollTo(0, 0); heading.current?.focus(); }, [current]);
    return <dialog ref={dialog} class="phone-groups" aria-label={t('Groups')} aria-modal="true"
        onCancel={event => { event.preventDefault(); onClose(); }}
        onKeyDown={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={event => { IdleTracker.regUserAction(); event.stopPropagation(); }}>
        <header class="phone-groups__header">
            <h2>{t('Groups')}</h2>
            <button type="button" class="phone-groups__icon" aria-label={t('Close groups')} onClick={onClose}>×</button>
        </header>
        <div class="phone-groups__location">
            <div class="phone-groups__title">
                <button type="button" class="phone-groups__icon" aria-label={t('Parent group')} disabled={!group}
                    onClick={() => navigate(group?.parentGroup ?? undefined)}>‹</button>
                <h3 ref={heading} tabIndex={-1}>{group ? <><GroupIcon group={group} /><span class="phone-groups__name">{group.title}</span></> : t('Open vaults')}</h3>
                {group && <button ref={more} type="button" class="phone-groups__icon" aria-label={t('Group actions')}
                    aria-expanded={actions} aria-controls="phone-group-actions" onClick={() => setActions(!actions)}>⋯</button>}
            </div>
            {group && <p class="phone-groups__path">{file!.name} · {path}</p>}
        </div>
        <div ref={scroll} class="phone-groups__scroll">
            {group && file && <div id="phone-group-actions" class="phone-groups__actions" hidden={!actions}>
                <GroupActions key={group.id} model={model} file={file} group={group} getReturnFocus={() => more.current}
                    onComplete={result => {
                        if (result.action === 'create') navigate(file.getGroup(result.groupId));
                        else if (result.action === 'delete') navigate(file.getGroup(result.parentId));
                        setMessage(t('Group changes applied. Check the database sync status.'));
                    }} />
                <GroupLifecycle key={`lifecycle-${group.id}`} model={model} file={file} group={group} onChanged={next => {
                    if (next) setCurrent(next.id);
                    setMessage(t('Group changes applied. Check the database sync status.'));
                }} />
            </div>}
            <div hidden={actions && !!group}>
                <p class="phone-groups__caption">{t(group ? 'Subgroups' : 'Choose a vault root')}</p>
                {children.map(child => <button key={child.id} type="button" class="phone-groups__row" onClick={() => navigate(child)}>
                    <GroupIcon group={child} /><span>{child.title}{!group && <small>{(child.file as FileModel).name}</small>}</span>
                    <span aria-hidden="true">›</span>
                </button>)}
                {group && !children.length && <p class="phone-groups__empty">{t('No subgroups')}</p>}
            </div>
            {message && <p class="phone-groups__message" role="status">{message}</p>}
        </div>
        <footer class="phone-groups__footer">
            <button type="button" disabled={!group} onClick={() => currentSession() && group && file?.active && file.getGroup(group.id) === group && onSelect(group)}>{t('Show entries')}</button>
        </footer>
    </dialog>;
}
