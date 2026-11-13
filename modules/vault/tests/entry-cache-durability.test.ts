import { expect, mock, test } from 'bun:test';
import { Credentials, Kdbx, ProtectedValue } from 'kdbxweb';
import '../src/util/kdbxweb/protected-value-ex';

mock.module('../src/models/app-settings-model', () => ({ AppSettingsModel: {} }));
mock.module('../src/util/data/ranking', () => ({ Ranking: {} }));
const { EntryModel } = await import('../src/models/entry-model');

async function fixture() {
    const credentials = new Credentials(ProtectedValue.fromString('disposable-entry-cache-test'));
    await credentials.ready;
    const db = Kdbx.create(credentials, 'Cache');
    const raw = db.createEntry(db.getDefaultGroup()); raw.fields.set('Title', 'Original');
    const file = {
        name: 'Cache', db, historyMaxItems: 10, dirty: false, modified: false, editSeq: 0,
        subId: (id: string) => id,
        setModified() { this.dirty = this.modified = true; ++this.editSeq; }
    };
    return { raw, file, entry: EntryModel.fromEntry(raw, { title: 'Group' }, file) };
}

test('editing an unsynchronized but cached entry invalidates the previous durable snapshot', async () => {
    const { raw, file, entry } = await fixture();
    entry.setField('Title', 'Cached offline edit');
    const cachedSeq = file.editSeq;
    file.dirty = false; // Cache committed, remote upload failed; entry.unsaved stays true.
    expect(entry.unsaved).toBe(true);
    entry.setField('Title', 'Latest uncached edit');
    expect(file.dirty).toBe(true); expect(file.modified).toBe(true);
    expect(file.editSeq).toBeGreaterThan(cachedSeq);
    expect(raw.fields.get('Title')).toBe('Latest uncached edit');
    expect(raw.history).toHaveLength(1); expect(raw.history[0].fields.get('Title')).toBe('Original');
});

test('a second mutation during a save advances the version without duplicating grouped history', async () => {
    const { raw, file, entry } = await fixture();
    entry.setField('Title', 'First edit');
    const savingSeq = file.editSeq;
    entry.setField('Notes', ProtectedValue.fromString('Later protected notes'));
    expect(file.editSeq).toBeGreaterThan(savingSeq); expect(file.dirty).toBe(true);
    expect(raw.history).toHaveLength(1);
    entry.setSaved();
    entry.setField('Title', 'Next edit after synchronization');
    expect(raw.history).toHaveLength(2);
    expect(raw.history[1].fields.get('Title')).toBe('First edit');
});
