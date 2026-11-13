import { expect, mock, test } from 'bun:test';
import { Credentials, Kdbx, ProtectedValue } from 'kdbxweb';

// Keep the real FileModel, GroupModel and EntryModel. Only browser startup services
// are replaced; tree traversal, mutations, dirty tracking and KDBX merge are real.
mock.module('demo.kdbx', () => ({ default: '' }));
mock.module('../src/models/app-settings-model', () => ({ AppSettingsModel: {} }));
mock.module('../src/util/data/ranking', () => ({ Ranking: {} }));
mock.module('../src/util/formatting/icon-url-format', () => ({ IconUrlFormat: {} }));
mock.module('../src/util/locale', () => ({ Locale: {} }));
mock.module('../src/collections/file-info-collection', () => ({ FileInfoCollection: {} }));
const { FileModel } = await import('../src/models/file-model');

function fixture(id = 'groups') {
    const db = Kdbx.create(new Credentials(ProtectedValue.fromString('synthetic')), id);
    const parent = db.createGroup(db.groups[0], 'Parent');
    const child = db.createGroup(parent, 'Child');
    const leaf = db.createGroup(child, 'Leaf');
    const sibling = db.createGroup(db.groups[0], 'Sibling');
    const records = [parent, child, leaf, sibling].map(group => {
        const entry = db.createEntry(group);
        entry.fields.set('Title', group.name!);
        entry.fields.set('Password', ProtectedValue.fromString('retained secret'));
        entry.tags = ['shared'];
        return entry;
    });
    const file = new FileModel({ id }); file.db = db; file.name = id; file.active = true;
    file.readModel();
    return { file, db, parent: file.getGroup(file.subId(parent.uuid.id))!, child: file.getGroup(file.subId(child.uuid.id))!,
        leaf: file.getGroup(file.subId(leaf.uuid.id))!, sibling: file.getGroup(file.subId(sibling.uuid.id))!, records };
}
function titles(file: InstanceType<typeof FileModel>, filter = {}) {
    const result: string[] = [];
    file.forEachEntry(filter, entry => { result.push(entry.title); });
    return result.sort();
}

test('search overrides cross excluded parents without exposing the recycle bin; direct browse remains available', () => {
    const { file, parent, child, leaf } = fixture();
    parent.setEnableSearching(false);
    expect(titles(file)).toEqual(['Sibling']);
    child.setEnableSearching(true);
    expect(titles(file)).toEqual(['Child', 'Leaf', 'Sibling']);
    expect(titles(file, { group: parent.id })).toEqual(['Parent']);
    child.setEnableSearching(null);
    expect(titles(file)).toEqual(['Sibling']);
    parent.moveToTrash();
    leaf.setEnableSearching(true);
    expect(titles(file)).toEqual(['Sibling']);
    expect(titles(file, { trash: true })).toEqual(['Child', 'Leaf', 'Parent']);
});

test('same-vault append and before-peer moves retain subtree identity and reject cycles, roots and other files', () => {
    const { file, parent, child, sibling, records } = fixture();
    const other = fixture('other');
    const seq = file.editSeq;
    child.moveToEnd(parent);
    sibling.moveToEnd(file.groups[0]);
    sibling.moveToEnd(other.parent);
    expect(file.editSeq).toBe(seq);
    sibling.moveToEnd(parent);
    expect(parent.parentGroup).toBe(sibling);
    sibling.moveToTop(parent);
    expect(parent.parentGroup).toBe(file.groups[0]);
    expect(file.groups[0].group.groups.indexOf(parent.group)).toBeLessThan(file.groups[0].group.groups.indexOf(sibling.group));
    file.groups[0].moveToEnd(parent);
    expect(file.groups[0].group.groups.at(-1)).toBe(parent.group);
    expect(child.parentGroup).toBe(parent);
    expect(records.every(entry => file.getEntry(file.subId(entry.uuid.id))?.entry === entry)).toBe(true);
    expect(file.db.deletedObjects).toHaveLength(0);
    expect(other.parent.parentGroup).toBe(other.file.groups[0]);
});

test('purging a group marks it modified and cascade tombstones survive merge with an older peer', async () => {
    const { file, parent, child, records } = fixture();
    parent.moveToTrash();
    const previous = await Kdbx.loadXml(await file.db.saveXml(), file.db.credentials);
    file.modified = false; file.dirty = false;
    child.deleteFromTrash();
    expect(file.modified).toBe(true); expect(file.dirty).toBe(true);
    const deleted = file.db.deletedObjects.map(item => item.uuid.id);
    expect(deleted).toContain(child.uuid);
    expect(deleted).toContain(records[1].uuid.id);
    expect(deleted).toContain(records[2].uuid.id);
    file.db.merge(previous); file.reload();
    expect(file.getGroup(child.id)).toBeUndefined();
    expect(file.getEntry(file.subId(records[1].uuid.id))).toBeUndefined();
    expect(file.getEntry(file.subId(records[0].uuid.id))).toBeDefined();
    expect(file.getEntry(file.subId(records[3].uuid.id))).toBeDefined();
});

test('empty trash retains live siblings and bin identity, and tombstones prevent resurrection', async () => {
    const { file, parent, records } = fixture();
    parent.moveToTrash();
    const binId = file.db.meta.recycleBinUuid!.id;
    const previous = await Kdbx.loadXml(await file.db.saveXml(), file.db.credentials);
    file.emptyTrash(); file.reload();
    file.db.merge(previous); file.reload();
    expect(file.db.getGroup(binId)?.groups).toHaveLength(0);
    expect(file.getGroup(parent.id)).toBeUndefined();
    expect(file.getEntry(file.subId(records[0].uuid.id))).toBeUndefined();
    expect(file.getEntry(file.subId(records[3].uuid.id))).toBeDefined();
});

test('global tag operations reach excluded groups and trash in separate files without deleting entries', () => {
    const first = fixture('first'); const second = fixture('second');
    first.parent.setEnableSearching(false); second.parent.moveToTrash();
    for (const { file } of [first, second]) file.renameTag('shared', 'renamed');
    expect([...first.records, ...second.records].every(entry => entry.tags.join() === 'renamed')).toBe(true);
    for (const { file } of [first, second]) file.renameTag('renamed', '');
    expect([...first.records, ...second.records].every(entry => entry.tags.length === 0)).toBe(true);
    expect([...first.records, ...second.records].every(entry => entry.fields.get('Password') instanceof ProtectedValue)).toBe(true);
    expect(first.db.deletedObjects).toHaveLength(0); expect(second.db.deletedObjects).toHaveLength(0);
});

test('confirmation guard binds every target file and the open-file set before any multi-vault mutation', async () => {
    const { lifecycleSnapshot } = await import('../../ui/src/lifecycle-guard');
    const first = fixture('first'); const second = fixture('second');
    const files = Object.assign([first.file, second.file], {
        get(id: string) { return this.find(file => file.id === id); }
    });
    const model = { files } as unknown as import('../src/models/app-model').AppModel;
    let check = lifecycleSnapshot(model, files, true);
    expect(check()).toBe('');
    second.file.syncing = true;
    expect(check()).toContain('save is in progress');
    second.file.syncing = false;
    Object.defineProperty(second.file, 'readOnly', { value: true, writable: true, configurable: true });
    expect(check()).toContain('read-only');
    (second.file as typeof second.file & { readOnly: boolean }).readOnly = false;
    files.push(fixture('third').file);
    expect(check()).toContain('changed');
    files.pop();
    check = lifecycleSnapshot(model, files, true);
    second.parent.setName('Changed elsewhere');
    expect(check()).toContain('changed');
    check = lifecycleSnapshot(model, files, true);
    second.file.syncDate = new Date();
    expect(check()).toContain('changed');
    check = lifecycleSnapshot(model, files, true);
    const { getSessionAccess } = await import('../src/comp/app/session-access');
    getSessionAccess(model).beginSecuring();
    expect(check()).toContain('session changed');
});

test('explicit search choice survives an ancestor change; Classic normalization remains the default', () => {
    const { parent, child } = fixture();
    child.setEnableSearching(true);
    expect(child.group.enableSearching).toBeNull();
    child.setEnableSearching(true, false);
    expect(child.group.enableSearching).toBe(true);
    parent.setEnableSearching(false);
    expect(child.getEffectiveEnableSearching()).toBe(true);
    child.setEnableSearching(null, false);
    expect(child.getEffectiveEnableSearching()).toBe(false);
});

test('destination labels disambiguate visible root names as well as sibling names', async () => {
    const { groupLabel } = await import('../../ui/src/lifecycle-guard');
    const { file, db } = fixture();
    const second = db.createGroup(db.groups[0], 'Different stored root name');
    db.groups[0].groups.splice(db.groups[0].groups.indexOf(second), 1);
    second.parentGroup = undefined; db.groups.push(second); file.reload();
    expect(file.groups[0].title).toBe(file.groups[1].title);
    expect(groupLabel(file, file.groups[0])).toBe('groups (1)');
    expect(groupLabel(file, file.groups[1])).toBe('groups (2)');
});


test('global tag removal and rename handle imported case-insensitive duplicate labels', () => {
    const { file, records } = fixture();
    records[0].tags = ['shared', 'SHARED', 'keep']; file.reload();
    file.renameTag('shared', 'renamed');
    expect(records[0].tags).toEqual(['keep', 'renamed']);
    records[0].tags = ['renamed', 'RENAMED', 'keep']; file.reload();
    file.renameTag('renamed', '');
    expect(records[0].tags).toEqual(['keep']);
});
