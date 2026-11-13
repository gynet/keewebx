import { test, expect, mock } from 'bun:test';
import { Credentials, Kdbx, KdbxUuid, ProtectedValue } from 'kdbxweb';
mock.module('demo.kdbx', () => ({ default: '' }));
mock.module('../src/models/app-settings-model', () => ({ AppSettingsModel: {} }));
mock.module('../src/util/data/ranking', () => ({ Ranking: {} }));
mock.module('../src/util/formatting/icon-url-format', () => ({ IconUrlFormat: { toDataUrl: () => null } }));
mock.module('../src/util/locale', () => ({ Locale: {} }));
mock.module('../src/collections/file-info-collection', () => ({ FileInfoCollection: {} }));
await import('../src/util/kdbxweb/protected-value-ex');
const { FileModel } = await import('../src/models/file-model');
const { EntryModel } = await import('../src/models/entry-model');
async function fixture(limit = 10) {
    const file = new FileModel({ id: 'discard' });
    file.db = Kdbx.create(new Credentials(ProtectedValue.fromString('pass')), 'Discard');
    file.db.meta.historyMaxItems = limit;
    file.name = 'Discard'; file.active = true; file.readModel();
    const raw = file.db.createEntry(file.db.groups[0]);
    raw.fields.set('Title', 'Saved'); raw.fields.set('Notes', ProtectedValue.fromString('secret\nmultiline'));
    raw.fields.set('Empty secret', ProtectedValue.fromString(''));
    raw.binaries.set('proof.bin', await file.db.createBinary(new Uint8Array([0, 255, 128]).buffer));
    raw.customData = new Map([['opaque', { value: 'metadata' }]]); raw.qualityCheck = false;
    if (limit) { raw.pushHistory(); raw.fields.set('Title', 'Current saved'); }
    file.reload();
    const entry = file.getEntry(file.subId(raw.uuid.id))!;
    return { file, raw, entry };
}
for (const limit of [0, 10]) test(`discard owns saved protected bytes across repeated edits and binary cleanup, history limit ${limit}`, async () => {
    const { file, raw, entry } = await fixture(limit);
    const title = entry.title, history = raw.history.length;
    entry.setField('Title', 'First edit'); entry.setField('Notes', ProtectedValue.fromString('changed'));
    entry.removeAttachment('proof.bin');
    file.db.cleanup({ historyRules: true, binaries: true });
    entry.setField('Title', 'Second edit');
    const seq = file.editSeq;
    entry.discardUnsaved();
    expect(entry.title).toBe(title); expect(entry.notes).toBe('secret\nmultiline');
    expect(raw.fields.get('Notes')).toBeInstanceOf(ProtectedValue);
    expect((raw.fields.get('Empty secret') as ProtectedValue).getText()).toBe('');
    expect(raw.history).toHaveLength(history);
    const binary = raw.binaries.get('proof.bin');
    expect(binary && 'hash' in binary ? file.db.binaries.getAllWithHashes().find(item => item.hash === binary.hash)?.value : null)
        .toEqual(new Uint8Array([0, 255, 128]).buffer);
    expect(raw.customData?.get('opaque')?.value).toBe('metadata'); expect(raw.qualityCheck).toBe(false);
    expect(file.editSeq).toBeGreaterThan(seq); expect(file.modified).toBe(true); expect(entry.canDiscardUnsaved).toBe(false);
});
test('restore and history deletion discard to the saved baseline; sibling edits and group move survive', async () => {
    const { file, raw, entry } = await fixture();
    const sibling = EntryModel.newEntry(file.groups[0] as any, file);
    sibling.setField('Title', 'Sibling dirty');
    entry.setField('Title', 'Unsaved intermediate'); entry.revertToHistoryState(raw.history[0]);
    entry.deleteHistory(raw.history[0]);
    const target = file.db.createGroup(file.db.groups[0], 'Moved'); file.db.move(raw, target); file.reload();
    entry.discardUnsaved();
    expect(entry.title).toBe('Current saved'); expect(raw.history).toHaveLength(1);
    expect(raw.parentGroup).toBe(target); expect(sibling.title).toBe('Sibling dirty'); expect(sibling.canDiscardUnsaved).toBe(true);
});
test('new-entry discard retains deletion tombstone; save establishes a fresh baseline', async () => {
    const { file, entry } = await fixture();
    const fresh = EntryModel.newEntry(file.groups[0] as any, file); fresh.setField('Title', 'Never saved');
    fresh.discardUnsaved();
    expect(file.getEntry(fresh.id)).toBeUndefined(); expect(file.db.deletedObjects.some(item => item.uuid.equals(fresh.entry.uuid))).toBe(true);
    entry.setField('Title', 'Durable'); entry.setSaved(); expect(entry.canDiscardUnsaved).toBe(false);
    entry.setField('Title', 'Later edit'); entry.discardUnsaved(); expect(entry.title).toBe('Durable');
});
test('read-only, syncing, replaced database, and missing saved icon fail closed', async () => {
    const { file, raw, entry } = await fixture();
    raw.customIcon = KdbxUuid.random(); file.db.meta.customIcons.set(raw.customIcon.id, { data: new Uint8Array([1]).buffer });
    entry.setField('Title', 'Changed');
    file.syncing = true; expect(() => entry.discardUnsaved()).toThrow(); file.syncing = false;
    Object.defineProperty(file, 'readOnly', { value: true, configurable: true }); expect(() => entry.discardUnsaved()).toThrow();
    Object.defineProperty(file, 'readOnly', { value: false });
    file.db.meta.customIcons.delete(raw.customIcon.id); expect(() => entry.discardUnsaved()).toThrow('icon'); expect(entry.title).toBe('Changed');
    file.db = Kdbx.create(new Credentials(ProtectedValue.fromString('other')), 'Other'); expect(entry.canDiscardUnsaved).toBe(false);
});
test('URL names avoid imported case variants and unsaved draft reservations', () => {
    expect(EntryModel.getNextUrlFieldName(['kp2a_url', 'KP2A_URL_1', 'KP2A_URL_3'])).toBe('KP2A_URL_2');
});

test('save completion with a later edit preserves the original baseline and dirty state', async () => {
    const { file, entry } = await fixture(0);
    entry.setField('Title', 'First save payload');
    file.setSyncProgress();
    // This edit is newer than syncStartEditSeq and is absent from the written payload.
    entry.setField('Title', 'Later unsaved edit');
    expect(file.setSyncComplete(null, null, null)).toBe(true);
    expect(file.modified).toBe(true); expect(file.dirty).toBe(true);
    expect(entry.canDiscardUnsaved).toBe(true); expect(entry.title).toBe('Later unsaved edit');
    entry.discardUnsaved();
    expect(entry.title).toBe('Saved'); expect(file.modified).toBe(true);
    entry.setField('Title', 'Later durable content');
    file.setSyncProgress(); expect(file.setSyncComplete(null, null, null)).toBe(true);
    expect(entry.canDiscardUnsaved).toBe(false); expect(file.modified).toBe(false);
    entry.setField('Title', 'Newest unsaved'); entry.discardUnsaved();
    expect(entry.title).toBe('Later durable content');
});
