import { useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import { Events } from 'framework/events';
import { LifecycleDialog } from './lifecycle-dialog';
import { allGroups, groupChain, groupLabel, inTrash, lifecycleSnapshot, writable } from './lifecycle-guard';
import { t } from './i18n';

type Action = 'move' | 'restore' | 'purge' | 'search';
const labels: Record<Action, string> = { move: 'Move group', restore: 'Restore group', purge: 'Permanently delete group', search: 'Group search settings' };
interface Request {
    action: Action; check: () => string; choices: GroupModel[];
    labels: Map<string, string>; original: boolean; suggested: string;
}

export function GroupLifecycle({ model, file, group, onChanged }: {
    model: AppModel; file: FileModel; group: GroupModel; onChanged: (group?: GroupModel) => void;
}) {
    const [request, setRequest] = useState<Request | null>(null);
    const trash = inTrash(file, group);
    const bin = file.db.meta.recycleBinUuid;
    const containsBin = allGroups(file).some(item => bin?.equals(item.group.uuid) && groupChain(file, item)?.includes(group));
    const reason = writable(model, file);
    const protectedGroup = !group.parentGroup || group.top || containsBin || !groupChain(file, group);
    const begin = (action: Action) => {
        if (request || protectedGroup || writable(model, file)) return;
        const choices = allGroups(file).filter(item => !inTrash(file, item) && !groupChain(file, item)?.includes(group));
        const original = choices.find(item => item.group.uuid.equals(group.group.previousParentGroup!));
        setRequest({ action, check: lifecycleSnapshot(model, [file]), choices,
            labels: new Map(choices.map(item => [item.id, groupLabel(file, item)])), original: !!original,
            suggested: action === 'restore' ? (original ?? choices.find(item => !item.parentGroup))?.id ?? '' : group.parentGroup?.id ?? '' });
    };
    return <div role="group" aria-label={t('Organize group: {}', group.title)} style={{ marginTop: '8px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {(trash ? ['restore', 'purge'] as const : ['move', 'search'] as const).map(action => <button type="button"
                class={`pill pill--tinted${action === 'purge' ? ' pill--danger' : ''}`}
                disabled={!!request || !!reason || protectedGroup} title={reason || undefined}
                onClick={() => begin(action)}>{t(labels[action])}</button>)}
        </div>
        {request && <GroupDialog model={model} file={file} group={group} request={request}
            onClose={() => setRequest(null)} onChanged={onChanged} />}
    </div>;
}

function GroupDialog({ model, file, group, request, onClose, onChanged }: {
    model: AppModel; file: FileModel; group: GroupModel; request: Request;
    onClose: () => void; onChanged: (group?: GroupModel) => void;
}) {
    const [destinationId, setDestinationId] = useState(request.suggested);
    const [beforeId, setBeforeId] = useState('');
    const [search, setSearch] = useState(group.group.enableSearching == null ? 'inherit' : String(group.group.enableSearching));
    const destination = request.choices.find(item => item.id === destinationId);
    const peers = destination ? request.choices.filter(item => item !== group && item.parentGroup === destination) : [];
    const before = peers.find(item => item.id === beforeId);
    const moving = request.action === 'move' || request.action === 'restore';
    const descendants = allGroups(file).filter(item => groupChain(file, item)?.includes(group));
    const check = () => {
        const reason = request.check();
        if (reason) return reason;
        if (moving && (!destination || !groupChain(file, destination) || inTrash(file, destination)
            || groupChain(file, destination)?.includes(group) || (beforeId && !before))) return t('Choose a valid destination and position.');
        return '';
    };
    return <LifecycleDialog title={t(labels[request.action])}
        confirm={t(request.action === 'purge' ? 'Delete permanently' : request.action === 'search' ? 'Save search settings' : request.action === 'restore' ? 'Restore' : 'Move')}
        destructive={request.action === 'purge'} check={check} onClose={onClose} apply={() => {
            if (request.action === 'purge') group.deleteFromTrash();
            else if (request.action === 'search') group.setEnableSearching(search === 'inherit' ? null : search === 'true', false);
            else if (before) before.moveToTop(group);
            else {
                // moveHere intentionally does nothing for an existing child; moveToEnd also reorders siblings.
                destination!.moveToEnd(group);
            }
            model.updateTags(); Events.emit('refresh');
            onChanged(request.action === 'purge' ? undefined : group);
        }}>
        <p>{t('Database: {}', file.name)}</p>
        <p>{groupLabel(file, group)}</p>
        <p>{t('{} subgroups, {} entries', String(descendants.length - 1), String(descendants.reduce((sum, item) => sum + item.group.entries.length, 0)))}</p>
        {request.action === 'purge' && <p>{t('Permanently delete this group and all its subgroups, entries, history and attachments?')}</p>}
        {moving && <>
            {request.action === 'restore' && <p>{t(request.original
                ? 'The original group is suggested. You can choose another group before restoring.'
                : 'The original group is unavailable or was not recorded. The vault root is suggested; choose a destination before restoring.')}</p>}
            <label class="vault-form__field">{t('Destination group')}
                <select class="input" style={{ width: '100%', minWidth: 0 }} value={destinationId}
                    onChange={event => { setDestinationId(event.currentTarget.value); setBeforeId(''); }}>
                    <option value="">{t('Choose a group')}</option>
                    {request.choices.map(item => <option value={item.id}>{request.labels.get(item.id)}</option>)}
                </select>
            </label>
            <label class="vault-form__field">{t('Position')}
                <select class="input" style={{ width: '100%', minWidth: 0 }} value={beforeId} onChange={event => setBeforeId(event.currentTarget.value)}>
                    <option value="">{t('Last in group')}</option>
                    {peers.map(item => <option value={item.id}>{t('Before {}', request.labels.get(item.id)!)}</option>)}
                </select>
            </label>
        </>}
        {request.action === 'search' && <>
            <label class="vault-form__field">{t('Global search')}
                <select class="input" value={search} onChange={event => setSearch(event.currentTarget.value)}>
                    <option value="inherit">{t('Inherit from parent')}</option>
                    <option value="true">{t('Include')}</option>
                    <option value="false">{t('Exclude')}</option>
                </select>
            </label>
            <p>{t('Subgroups inherit this setting unless they override it. You can still browse an excluded group directly.')}</p>
        </>}
    </LifecycleDialog>;
}

export function TrashGroups({ model, onChanged }: { model: AppModel; onChanged: (group?: GroupModel) => void }) {
    const [selected, setSelected] = useState('');
    const [request, setRequest] = useState<{ check: () => string; files: FileModel[]; summary: string[] } | null>(null);
    const files = [...model.files].filter(file => file.active);
    const groups = files.flatMap(file => allGroups(file).filter(group => group.parentGroup && inTrash(file, group)
        && !file.db.meta.recycleBinUuid?.equals(group.group.uuid)).map(group => ({ file, group })));
    const target = groups.find(({ group }) => group.id === selected);
    const bins = files.map(file => ({ file, bin: file.getTrashGroup() })).filter(({ bin }) => bin && (bin.group.groups.length || bin.group.entries.length));
    const begin = () => {
        if (!bins.length || bins.some(({ file }) => writable(model, file))) return;
        const targets = bins.map(({ file }) => file);
        setRequest({ check: lifecycleSnapshot(model, targets, true), files: targets, summary: bins.map(({ file, bin }) => {
            const descendants = allGroups(file).filter(group => groupChain(file, group)?.includes(bin!));
            return t('{}: {} groups, {} entries', file.name, String(descendants.length - 1), String(descendants.reduce((sum, group) => sum + group.group.entries.length, 0)));
        }) });
    };
    return <details style={{ margin: '0 14px 6px', flex: '0 0 auto' }}>
        <summary style={{ cursor: 'pointer', padding: '10px 0', fontWeight: 600 }}>{t('Manage trash')}</summary>
        <div style={{ maxHeight: '40dvh', overflow: 'auto', overflowWrap: 'anywhere' }}>
            <label class="vault-form__field">{t('Trashed group')}
                <select class="input" style={{ width: '100%', minWidth: 0 }} value={target?.group.id ?? ''} onChange={event => setSelected(event.currentTarget.value)}>
                    <option value="">{t('Choose a trashed group')}</option>
                    {groups.map(({ file, group }) => <option value={group.id}>{t('Vault {}: {}', String(files.indexOf(file) + 1), groupLabel(file, group))}</option>)}
                </select>
            </label>
            {target && <GroupLifecycle key={target.group.id} model={model} {...target} onChanged={onChanged} />}
            <button type="button" class="pill pill--danger" style={{ marginTop: '12px' }}
                disabled={!!request || !bins.length || bins.some(({ file }) => !!writable(model, file))} onClick={begin}>{t('Empty trash…')}</button>
        </div>
        {request && <LifecycleDialog title={t('Empty trash')} confirm={t('Empty trash')} destructive check={request.check}
            onClose={() => setRequest(null)} apply={() => {
                for (const file of request.files) { file.emptyTrash(); file.reload(); }
                model.updateTags(); Events.emit('refresh'); onChanged();
            }}>
            <p>{t('Permanently remove all trashed groups and entries from these open databases, including their history and attachments?')}</p>
            <ul>{request.summary.map(line => <li>{line}</li>)}</ul>
        </LifecycleDialog>}
    </details>;
}
