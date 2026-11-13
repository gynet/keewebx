import { test, expect, mock } from 'bun:test';
import { Credentials, Kdbx, KdbxUuid, ProtectedValue } from 'kdbxweb';
import type { AppModel } from '../src/models/app-model';
mock.module('demo.kdbx', () => ({ default: '' }));
mock.module('../src/models/app-settings-model', () => ({ AppSettingsModel: {} }));
mock.module('../src/util/data/ranking', () => ({ Ranking: {} }));
mock.module('../src/util/formatting/icon-url-format', () => ({ IconUrlFormat: { toDataUrl: () => null } }));
mock.module('../src/util/locale', () => ({ Locale: {} }));
mock.module('../src/collections/file-info-collection', () => ({ FileInfoCollection: {} }));
const { FileModel } = await import('../src/models/file-model');
const { prepareEntryTransfer } = await import('../src/comp/app/entry-transfer');
const { getSessionAccess } = await import('../src/comp/app/session-access');

async function fixture() {
    const files = ['Source', 'Target'].map(id => {
        const file = new FileModel({ id });
        file.db = Kdbx.create(new Credentials(ProtectedValue.fromString(id)), id);
        file.name = id; file.active = true; file.readModel(); return file;
    });
    const [source, target] = files, raw = source.db.createEntry(source.db.groups[0]);
    raw.fields.set('Title', 'Same title allowed');
    raw.fields.set('Password', ProtectedValue.fromString('protected original'));
    raw.binaries.set('history.bin', await source.db.createBinary(new Uint8Array([0, 255, 2]).buffer));
    raw.pushHistory(); raw.binaries.clear();
    raw.history[0].customData = new Map([['historical', { value: 'retained revision metadata' }]]);
    raw.fields.set('Password', ProtectedValue.fromString('protected current'));
    raw.binaries.set('current.bin', await source.db.createBinary(new Uint8Array([128, 0, 9]).buffer));
    raw.customData = new Map([['portable', { value: 'custom metadata' }]]);
    raw.qualityCheck = false; raw.autoType.defaultSequence = '{USERNAME}{TAB}{PASSWORD}';
    raw.customIcon = KdbxUuid.random();
    source.db.meta.customIcons.set(raw.customIcon.id, { data: new Uint8Array([4, 5, 6]).buffer, name: 'portable icon' });
    source.reload();
    const entry = source.getEntry(source.subId(raw.uuid.id))!;
    Object.assign(files, { get: (id: string) => files.find(file => file.id === id) });
    const writes: string[] = [];
    const model = { files, syncFile(file: InstanceType<typeof FileModel>, options: { canContinue(): boolean }, callback: (error?: unknown) => void) {
        writes.push(file.id);
        expect(options.canContinue()).toBe(true);
        file.db.cleanup({ historyRules: true, customIcons: true, binaries: true });
        file.modified = false; file.dirty = false;
        callback();
    } } as unknown as AppModel;
    return { model, files, source, target, entry, raw, writes };
}
const signal = () => new AbortController().signal;

test('destination saves before source deletion; UUID, protected history, binaries and metadata stay independent', async () => {
    const { model, source, target, entry, raw, writes } = await fixture();
    const request = prepareEntryTransfer(model, entry), destination = request.destinations[0];
    const result = await request.move(destination, signal());
    expect(result.state).toBe('moved'); expect(writes).toEqual(['Target', 'Source']);
    expect(source.getEntry(entry.id)).toBeUndefined();
    expect(source.db.deletedObjects.some(item => item.uuid.equals(raw.uuid))).toBe(true);
    const copy = target.getEntry(target.subId(raw.uuid.id))!.entry;
    expect(copy.uuid.equals(raw.uuid)).toBe(true);
    expect(copy).not.toBe(raw);
    expect((copy.fields.get('Password') as ProtectedValue).getText()).toBe('protected current');
    expect(copy.fields.get('Password')).not.toBe(raw.fields.get('Password'));
    expect(copy.history).toHaveLength(1);
    expect(copy.history[0].uuid.equals(raw.uuid)).toBe(true);
    expect((copy.history[0].fields.get('Password') as ProtectedValue).getText()).toBe('protected original');
    expect(copy.history[0].customData?.get('historical')?.value).toBe('retained revision metadata');
    expect(copy.customData?.get('portable')?.value).toBe('custom metadata');
    expect(copy.qualityCheck).toBe(false);
    expect(copy.autoType.defaultSequence).toBe(raw.autoType.defaultSequence);
    expect(target.db.binaries.getAllWithHashes()).toHaveLength(2);
    expect(source.db.binaries.getAllWithHashes()).toHaveLength(0);
    expect(target.db.meta.customIcons.get(copy.customIcon!.id)?.data).toEqual(new Uint8Array([4, 5, 6]).buffer);
});

for (const collision of ['entry', 'deleted', 'group'] as const) test(`${collision} UUID collisions reject without mutating either vault`, async () => {
    const { model, source, target, entry, raw, writes } = await fixture();
    if (collision === 'entry') target.db.createEntry(target.db.groups[0]).uuid = raw.uuid;
    if (collision === 'group') target.db.createGroup(target.db.groups[0], 'collision').uuid = raw.uuid;
    if (collision === 'deleted') target.db.addDeletedObject(raw.uuid, new Date());
    target.reload();
    const request = prepareEntryTransfer(model, entry);
    await expect(request.move(request.destinations[0], signal())).rejects.toThrow('UUID');
    expect(writes).toEqual([]); expect(source.getEntry(entry.id)).toBe(entry);
    expect(target.modified).toBe(false);
});

test('history and icon conflicts fail before publishing a destination copy', async () => {
    for (const kind of ['history', 'icon']) {
        const { model, source, target, entry, raw } = await fixture();
        if (kind === 'history') target.db.meta.historyMaxItems = 0;
        else target.db.meta.customIcons.set(raw.customIcon!.id, { data: new Uint8Array([9]).buffer });
        const request = prepareEntryTransfer(model, entry);
        await expect(request.move(request.destinations[0], signal())).rejects.toThrow(kind);
        expect(target.getEntry(target.subId(raw.uuid.id))).toBeUndefined();
        expect(source.getEntry(entry.id)).toBe(entry);
    }
});

test('read-only targets are excluded and read-only sources cannot start a move', async () => {
    const { model, source, target, entry } = await fixture();
    Object.defineProperty(target, 'readOnly', { value: true });
    expect(prepareEntryTransfer(model, entry).destinations).toHaveLength(0);
    Object.defineProperty(source, 'readOnly', { value: true });
    expect(() => prepareEntryTransfer(model, entry)).toThrow('read-only');
});

test('older destination formats cannot silently drop persisted entry metadata', async () => {
    const { model, source, target, entry } = await fixture();
    source.db.header.versionMinor = 1;
    const request = prepareEntryTransfer(model, entry);
    await expect(request.move(request.destinations[0], signal())).rejects.toThrow('older database format');
    expect(source.getEntry(entry.id)).toBe(entry);
    expect([...target.db.groups[0].allEntries()]).toHaveLength(0);
});

for (const change of ['cancel', 'session', 'target', 'source', 'credentials', 'membership', 'target-readonly', 'target-credentials', 'target-content'] as const) test(`${change} during destination save never deletes source`, async () => {
    const { model, source, target, entry, raw } = await fixture();
    const controller = new AbortController();
    model.syncFile = (_file, _options, callback) => {
        if (change === 'cancel') controller.abort();
        if (change === 'session') getSessionAccess(model).beginSecuring();
        if (change === 'target') target.groups[0].setName('Changed');
        if (change === 'source') entry.setField('Title', 'New source');
        if (change === 'credentials') source.db.credentials = new Credentials(ProtectedValue.fromString('changed'));
        if (change === 'membership') model.files.pop();
        if (change === 'target-readonly') Object.defineProperty(target, 'readOnly', { value: true });
        if (change === 'target-credentials') target.db.credentials = new Credentials(ProtectedValue.fromString('changed'));
        if (change === 'target-content') target.getEntry(target.subId(raw.uuid.id))!.entry.fields.set('Password', ProtectedValue.fromString('remote conflict'));
        target.modified = false; target.dirty = false;
        callback?.();
    };
    const request = prepareEntryTransfer(model, entry);
    const result = await request.move(request.destinations[0], controller.signal);
    expect(result.state).toBe('source-retained'); expect(result.message).toContain('copy');
    expect(source.getEntry(entry.id)).toBe(entry);
    expect(target.getEntry(target.subId(raw.uuid.id))).toBeDefined();
    expect(source.db.deletedObjects).toHaveLength(0);
});

test('destination save failure retains the source; source save failure reports pending removal, never success', async () => {
    for (const failing of ['Source', 'Target']) {
        const { model, source, target, entry, raw } = await fixture();
        const save = model.syncFile.bind(model);
        model.syncFile = (file, options, callback) => {
            if (file.id === failing) callback?.('save failed'); else save(file, options, callback);
        };
        const request = prepareEntryTransfer(model, entry);
        const result = await request.move(request.destinations[0], signal());
        expect(result.state).toBe(failing === 'Target' ? 'source-retained' : 'source-save-pending');
        expect(!!source.getEntry(entry.id)).toBe(failing === 'Target');
        expect(target.getEntry(target.subId(raw.uuid.id))).toBeDefined();
        expect(failing === 'Target' ? target.dirty : source.dirty).toBe(true);
    }
});

test('cancel and stale destination before application do not create a copy', async () => {
    const { model, target, entry } = await fixture();
    let request = prepareEntryTransfer(model, entry);
    const controller = new AbortController(); controller.abort();
    await expect(request.move(request.destinations[0], controller.signal)).rejects.toThrow('canceled');
    request = prepareEntryTransfer(model, entry);
    target.groups[0].setName('Renamed');
    await expect(request.move(request.destinations[0], signal())).rejects.toThrow('destination changed');
    expect([...target.db.groups[0].allEntries()]).toHaveLength(0);
});
