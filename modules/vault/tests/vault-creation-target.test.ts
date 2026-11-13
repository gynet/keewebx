import { expect, test } from 'bun:test';
import type { AppModel } from '../src/models/app-model';
import type { GroupModel } from '../src/models/group-model';
import { writableCreationGroup } from '../../ui/src/creation-target';

function fixture() {
    const root = { id: 'A:root', group: { groups: [], uuid: 'root' }, parentGroup: null } as any;
    const child = { id: 'A:child', group: { groups: [], uuid: 'child' }, parentGroup: root } as any;
    root.group.groups.push(child.group);
    const file = { id: 'A', active: true, readOnly: false, db: { groups: [root.group], meta: {} },
        getGroup: (id: string) => id === root.id ? root : id === child.id ? child : undefined };
    root.file = child.file = file;
    const files = new Map([[file.id, file]]);
    return { root, child: child as GroupModel, file, files, model: { files } as unknown as AppModel };
}

test('a cached group removed from its parent cannot receive a new draft entry', () => {
    const { model, root, child } = fixture();
    expect(writableCreationGroup(model, child)).toBe(true);
    root.group.groups.length = 0;
    expect(writableCreationGroup(model, child)).toBe(false);
});

test('closing or replacing the target vault revokes a pending creation target', () => {
    const { model, child, file, files } = fixture();
    file.active = false; expect(writableCreationGroup(model, child)).toBe(false);
    file.active = true; files.set('A', { ...file }); expect(writableCreationGroup(model, child)).toBe(false);
});

test('database replacement, read-only state and trash ancestry reject creation', () => {
    const { model, child, file } = fixture();
    file.readOnly = true; expect(writableCreationGroup(model, child)).toBe(false);
    file.readOnly = false;
    file.db.meta = { recycleBinUuid: { equals: (uuid: string) => uuid === 'root' } };
    expect(writableCreationGroup(model, child)).toBe(false);
    file.db.meta = {}; file.db.groups = [];
    expect(writableCreationGroup(model, child)).toBe(false);
});
