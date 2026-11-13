import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';

/** Check the entire live ancestry: a cached group model can survive removal from its database. */
export function writableCreationGroup(model: AppModel, group: GroupModel | undefined): group is GroupModel {
    if (!group) return false;
    const file = group.file as FileModel;
    if (!file?.active || model.files.get(file.id) !== file || (file as FileModel & { readOnly?: boolean }).readOnly) return false;
    const visited = new Set<GroupModel>();
    for (let current: GroupModel | null = group; current; current = current.parentGroup) {
        if (visited.has(current) || current.file !== file || file.getGroup(current.id) !== current ||
            file.db.meta.recycleBinUuid?.equals(current.group.uuid) ||
            !(current.parentGroup ? current.parentGroup.group.groups : file.db.groups).includes(current.group)) return false;
        visited.add(current);
    }
    return true;
}
