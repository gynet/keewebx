import * as kdbxweb from 'kdbxweb';
import { ENTRY_ICONS } from 'const/icon-registry';
import { EntryModel } from 'models/entry-model';
import { MenuItemModel } from 'models/menu/menu-item-model';
import { IconUrlFormat } from 'util/formatting/icon-url-format';
import { GroupCollection } from 'collections/group-collection';
import { EntryCollection } from 'collections/entry-collection';

const KdbxIcons = kdbxweb.Consts.Icons;

const DefaultAutoTypeSequence = '{USERNAME}{TAB}{PASSWORD}{ENTER}';

interface GroupFilter {
    includeDisabled?: boolean;
    autoType?: boolean;
}

interface FileModel {
    subId(id: string): string;
    name: string;
    db: kdbxweb.Kdbx;
    getGroup(id: string): GroupModel | undefined;
    getEntry(id: string): EntryModel | undefined;
    setModified(): void;
    reload(): void;
}

class GroupModel extends MenuItemModel {
    declare uuid: string;
    declare iconId: number;
    declare entries: EntryCollection;
    declare filterKey: string;
    declare top: boolean;
    declare drop: boolean;
    declare enableSearching: boolean | null;
    declare enableAutoType: boolean | null;
    declare autoTypeSeq: string | null;
    declare parentGroup: GroupModel | null;
    declare customIconId: string | null;
    declare isJustCreated: boolean;

    group!: kdbxweb.KdbxGroup;
    file!: FileModel;


    setGroup(group: kdbxweb.KdbxGroup, file: FileModel, parentGroup?: GroupModel): void {
        const isRecycleBin = group.uuid.equals(file.db.meta.recycleBinUuid as kdbxweb.KdbxUuid);
        const id = file.subId((group.uuid as unknown as { id: string }).id);
        this.set(
            {
                id,
                uuid: (group.uuid as unknown as { id: string }).id,
                expanded: group.expanded,
                visible: !isRecycleBin,
                items: new GroupCollection(),
                entries: new EntryCollection(),
                filterValue: id,
                enableSearching: group.enableSearching,
                enableAutoType: group.enableAutoType,
                autoTypeSeq: group.defaultAutoTypeSeq,
                top: !parentGroup,
                drag: !!parentGroup,
                collapsible: !!parentGroup
            },
            { silent: true }
        );
        this.group = group;
        this.file = file;
        this.parentGroup = parentGroup ?? null;
        this._fillByGroup(true);
        // `items` is inherited from MenuItemModel as `unknown[] | null`
        // (menu items can be either plain arrays of records or
        // domain-specific collections). setGroup always assigns a
        // GroupCollection here, so narrow locally.
        const items = this.items as unknown as GroupCollection;
        const entries = this.entries;

        const itemsArray = group.groups.map((subGroup) => {
            let g = file.getGroup(file.subId((subGroup.uuid as unknown as { id: string }).id));
            if (g) {
                g.setGroup(subGroup, file, this);
            } else {
                g = GroupModel.fromGroup(subGroup, file, this);
            }
            return g;
        });
        items.push(...itemsArray);

        const entriesArray = group.entries.map((entry) => {
            let e = file.getEntry(file.subId((entry.uuid as unknown as { id: string }).id));
            if (e) {
                e.setEntry(entry, this, file);
            } else {
                e = EntryModel.fromEntry(entry, this, file);
            }
            return e;
        });
        entries.push(...entriesArray);
    }

    _fillByGroup(silent?: boolean): void {
        this.set(
            {
                title: this.parentGroup ? this.group.name : this.file.name,
                iconId: this.group.icon,
                icon: this._iconFromId(this.group.icon as number),
                customIcon: this._buildCustomIcon(),
                customIconId: this.group.customIcon
                    ? this.group.customIcon.toString()
                    : null,
                expanded: this.group.expanded !== false
            },
            { silent: !!silent }
        );
    }

    _iconFromId(id: number): string | undefined {
        if (id === KdbxIcons.Folder || id === KdbxIcons.FolderOpen) {
            return undefined;
        }
        return (ENTRY_ICONS as readonly string[] as Record<number, string>)[id];
    }

    _buildCustomIcon(): string | null {
        this.customIcon = null;
        if (this.group.customIcon) {
            return IconUrlFormat.toDataUrl(
                this.file.db.meta.customIcons.get(
                    (this.group.customIcon as unknown as { id: string }).id
                )?.data
            );
        }
        return null;
    }

    _groupModified(): void {
        if (this.isJustCreated) {
            this.isJustCreated = false;
        }
        this.file.setModified();
        this.group.times.update();
    }

    forEachGroup(callback: (group: GroupModel) => boolean | void, filter?: GroupFilter): boolean {
        let result = true;
        (this.items as GroupModel[]).forEach((group) => {
            if (group.matches(filter)) {
                result =
                    callback(group) !== false &&
                    group.forEachGroup(callback, filter) !== false;
            }
        });
        return result;
    }

    forEachOwnEntry(filter: GroupFilter | null, callback: (entry: EntryModel, group?: GroupModel) => void): void {
        this.entries.forEach((entry: EntryModel) => {
            if (entry.matches(filter as Record<string, unknown>)) {
                callback(entry, this);
            }
        });
    }

    matches(filter?: GroupFilter): boolean {
        return (
            ((filter && filter.includeDisabled) ||
                (this.group.enableSearching !== false &&
                    !this.group.uuid.equals(
                        this.file.db.meta.entryTemplatesGroup as kdbxweb.KdbxUuid
                    ))) &&
            (!filter || !filter.autoType || this.group.enableAutoType !== false)
        );
    }

    getOwnSubGroups(): kdbxweb.KdbxGroup[] {
        return this.group.groups;
    }

    addEntry(entry: EntryModel): void {
        this.entries.push(entry);
    }

    addGroup(group: GroupModel): void {
        (this.items as GroupModel[]).push(group);
    }

    setName(name: string): void {
        this._groupModified();
        this.group.name = name;
        this._fillByGroup();
    }

    setIcon(iconId: number): void {
        this._groupModified();
        this.group.icon = iconId;
        this.group.customIcon = undefined;
        this._fillByGroup();
    }

    setCustomIcon(customIconId: string): void {
        this._groupModified();
        this.group.customIcon = new kdbxweb.KdbxUuid(customIconId);
        this._fillByGroup();
    }

    setExpanded(expanded: boolean): void {
        // this._groupModified(); // it's not good to mark the file as modified when a group is collapsed
        this.group.expanded = expanded;
        this.expanded = expanded;
    }

    setEnableSearching(enabled: boolean | null): void {
        this._groupModified();
        let parentEnableSearching = true;
        let parentGroup = this.parentGroup as GroupModel | null;
        while (parentGroup) {
            if (typeof parentGroup.enableSearching === 'boolean') {
                parentEnableSearching = parentGroup.enableSearching;
                break;
            }
            parentGroup = parentGroup.parentGroup;
        }
        if (enabled === parentEnableSearching) {
            enabled = null;
        }
        this.group.enableSearching = enabled;
        this.enableSearching = this.group.enableSearching;
    }

    getEffectiveEnableSearching(): boolean {
        let grp: GroupModel | null = this;
        while (grp) {
            if (typeof grp.enableSearching === 'boolean') {
                return grp.enableSearching;
            }
            grp = grp.parentGroup;
        }
        return true;
    }

    setEnableAutoType(enabled: boolean | null): void {
        this._groupModified();
        let parentEnableAutoType = true;
        let parentGroup = this.parentGroup as GroupModel | null;
        while (parentGroup) {
            if (typeof parentGroup.enableAutoType === 'boolean') {
                parentEnableAutoType = parentGroup.enableAutoType;
                break;
            }
            parentGroup = parentGroup.parentGroup;
        }
        if (enabled === parentEnableAutoType) {
            enabled = null;
        }
        this.group.enableAutoType = enabled;
        this.enableAutoType = this.group.enableAutoType;
    }

    getEffectiveEnableAutoType(): boolean {
        let grp: GroupModel | null = this;
        while (grp) {
            if (typeof grp.enableAutoType === 'boolean') {
                return grp.enableAutoType;
            }
            grp = grp.parentGroup;
        }
        return true;
    }

    setAutoTypeSeq(seq: string | undefined): void {
        this._groupModified();
        this.group.defaultAutoTypeSeq = seq || undefined;
        this.autoTypeSeq = this.group.defaultAutoTypeSeq ?? null;
    }

    getEffectiveAutoTypeSeq(): string {
        let grp: GroupModel | null = this;
        while (grp) {
            if (grp.autoTypeSeq) {
                return grp.autoTypeSeq;
            }
            grp = grp.parentGroup;
        }
        return DefaultAutoTypeSequence;
    }

    getParentEffectiveAutoTypeSeq(): string {
        return this.parentGroup
            ? this.parentGroup.getEffectiveAutoTypeSeq()
            : DefaultAutoTypeSequence;
    }

    isEntryTemplatesGroup(): boolean {
        return this.group.uuid.equals(
            this.file.db.meta.entryTemplatesGroup as kdbxweb.KdbxUuid
        );
    }

    moveToTrash(): void {
        this.file.setModified();
        this.file.db.remove(this.group);
        if (
            this.group.uuid.equals(
                this.file.db.meta.entryTemplatesGroup as kdbxweb.KdbxUuid
            )
        ) {
            this.file.db.meta.entryTemplatesGroup = undefined;
        }
        this.file.reload();
    }

    deleteFromTrash(): void {
        this.file.db.move(this.group, null);
        this.file.reload();
    }

    removeWithoutHistory(): void {
        const ix = this.parentGroup!.group.groups.indexOf(this.group);
        if (ix >= 0) {
            this.parentGroup!.group.groups.splice(ix, 1);
        }
        this.file.reload();
    }

    moveHere(object: GroupModel | EntryModel | null): void {
        if (!object || (object as { id: string }).id === this.id) {
            return;
        }
        if ((object as { file: unknown }).file === this.file) {
            this.file.setModified();
            if (object instanceof GroupModel) {
                for (
                    let parent: GroupModel | null = this;
                    parent;
                    parent = parent.parentGroup
                ) {
                    if (object === parent) {
                        return;
                    }
                }
                if (this.group.groups.indexOf(object.group) >= 0) {
                    return;
                }
                this.file.db.move(object.group, this.group);
                this.file.reload();
            } else if (object instanceof EntryModel) {
                if (this.group.entries.indexOf(object.entry) >= 0) {
                    return;
                }
                this.file.db.move(object.entry, this.group);
                this.file.reload();
            }
        } else {
            if (object instanceof EntryModel) {
                this.file.setModified();
                const detachedEntry = object.detach();
                this.file.db.importEntry(
                    detachedEntry,
                    this.group,
                    (object as unknown as { file: { db: kdbxweb.Kdbx } }).file.db
                );
                this.file.reload();
            }
            // moving groups between files is not supported for now
        }
    }

    moveToTop(object: GroupModel | null): void {
        if (
            !object ||
            (object as { id: string }).id === this.id ||
            (object as { file: unknown }).file !== this.file ||
            !(object instanceof GroupModel)
        ) {
            return;
        }
        this.file.setModified();
        for (
            let parent: GroupModel | null = this;
            parent;
            parent = parent.parentGroup
        ) {
            if (object === parent) {
                return;
            }
        }
        let atIndex = this.parentGroup!.group.groups.indexOf(this.group);
        const selfIndex = this.parentGroup!.group.groups.indexOf(object.group);
        if (selfIndex >= 0 && selfIndex < atIndex) {
            atIndex--;
        }
        if (atIndex >= 0) {
            this.file.db.move(object.group, this.parentGroup!.group, atIndex);
        }
        this.file.reload();
    }

    static fromGroup(
        group: kdbxweb.KdbxGroup,
        file: FileModel,
        parentGroup?: GroupModel
    ): GroupModel {
        const model = new GroupModel();
        model.setGroup(group, file, parentGroup);
        return model;
    }

    static newGroup(group: GroupModel, file: FileModel): GroupModel {
        const model = new GroupModel();
        // kdbxweb.Kdbx.createGroup requires an initial name; callers
        // typically overwrite it immediately via setName(). Pass an
        // empty string so the group exists in the db tree and then
        // wait for the UI to commit a final name on first edit.
        const grp = file.db.createGroup(group.group, '');
        model.setGroup(grp, file, group);
        model.group.times.update();
        model.isJustCreated = true;
        group.addGroup(model);
        file.setModified();
        file.reload();
        return model;
    }
}

GroupModel.defineModelProperties({
    id: '',
    uuid: '',
    iconId: 0,
    entries: null,
    filterKey: 'group',
    editable: true,
    top: false,
    drag: true,
    drop: true,
    enableSearching: true,
    enableAutoType: null,
    autoTypeSeq: null,
    group: null,
    file: null,
    parentGroup: null,
    customIconId: null,
    isJustCreated: false
});

export { GroupModel };
export type { GroupFilter };
