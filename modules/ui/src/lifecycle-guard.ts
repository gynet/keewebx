import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import { getSessionAccess } from 'comp/app/session-access';
import { t } from './i18n';

export function groupChain(file: FileModel, group: GroupModel): GroupModel[] | null {
    const chain: GroupModel[] = [];
    for (let current: GroupModel | null = group; current; current = current.parentGroup) {
        if (chain.includes(current) || current.file !== file || file.getGroup(current.id) !== current
            || current.group.parentGroup !== (current.parentGroup?.group ?? undefined)
            || !(current.parentGroup ? current.parentGroup.group.groups : file.db.groups).includes(current.group)) return null;
        chain.unshift(current);
    }
    return chain;
}
export function inTrash(file: FileModel, group: GroupModel): boolean {
    return !!groupChain(file, group)?.some(item => file.db.meta.recycleBinUuid?.equals(item.group.uuid));
}
export function allGroups(file: FileModel): GroupModel[] {
    const result: GroupModel[] = [];
    const visit = (group: GroupModel) => {
        if (result.includes(group)) return;
        result.push(group);
        for (const child of group.group.groups) {
            const item = file.getGroup(file.subId(child.uuid.id));
            if (item) visit(item);
        }
    };
    for (const root of file.groups) visit(root);
    return result;
}
export function groupLabel(file: FileModel, group: GroupModel): string {
    return (groupChain(file, group) ?? []).map(item => {
        const siblings = item.parentGroup ? item.parentGroup.group.groups : file.db.groups;
        const same = siblings.filter(other => file.getGroup(file.subId(other.uuid.id))?.title === item.title);
        const name = !item.title || /[\/"\\()\u0000-\u001f]/.test(item.title) ? JSON.stringify(item.title) : item.title;
        return same.length > 1 ? `${name} (${same.indexOf(item.group) + 1})` : name;
    }).join(' / ');
}
export function writable(model: AppModel, file: FileModel): string {
    if (getSessionAccess(model).state !== 'open') return t('Unlock the database before making changes.');
    if (!file.active || model.files.get(file.id) !== file) return t('This database is no longer available.');
    if ((file as FileModel & { readOnly?: boolean }).readOnly) return t('This database is read-only.');
    if (file.syncing) return t('A save is in progress. Wait for it to finish, then try again.');
    return '';
}

/** Bind a confirmation to the session, database objects, membership and displayed hierarchy. */
export function lifecycleSnapshot(model: AppModel, files: FileModel[], bindOpenFiles = false) {
    const epoch = getSessionAccess(model).epoch;
    const openFiles = [...model.files];
    const snapshots = files.map(file => ({ file, db: file.db, editSeq: file.editSeq, syncDate: file.syncDate?.getTime(),
        bin: file.db.meta.recycleBinUuid?.id, enabled: file.db.meta.recycleBinEnabled,
        groups: allGroups(file).map(group => ({ group, object: group.group,
            parent: group.parentGroup, title: group.title, searching: group.group.enableSearching,
            children: [...group.group.groups], entries: [...group.group.entries] })) }));
    return () => {
        const access = getSessionAccess(model);
        if (access.state !== 'open' || !access.isCurrent(epoch)) return t('The session changed. Cancel and open the action again.');
        const changed = t('The database or group changed. Cancel and open the action again.');
        if (bindOpenFiles && (openFiles.length !== model.files.length || openFiles.some((file, i) => model.files[i] !== file))) return changed;
        for (const snapshot of snapshots) {
            const { file } = snapshot;
            const reason = writable(model, file);
            if (reason) return reason;
            if (file.db !== snapshot.db || file.editSeq !== snapshot.editSeq || file.syncDate?.getTime() !== snapshot.syncDate
                || file.db.meta.recycleBinUuid?.id !== snapshot.bin || file.db.meta.recycleBinEnabled !== snapshot.enabled
                || allGroups(file).length !== snapshot.groups.length) return changed;
            for (const item of snapshot.groups) {
                const { group } = item;
                if (!groupChain(file, group) || group.group !== item.object || group.parentGroup !== item.parent
                    || group.title !== item.title || group.group.enableSearching !== item.searching
                    || group.group.groups.length !== item.children.length || group.group.entries.length !== item.entries.length
                    || item.children.some((child, i) => group.group.groups[i] !== child)
                    || item.entries.some((entry, i) => group.group.entries[i] !== entry)) return changed;
            }
        }
        return '';
    };
}
