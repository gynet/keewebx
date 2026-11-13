import { expect, test } from 'bun:test';
import { Credentials, Kdbx, ProtectedValue } from 'kdbxweb';
import { captureImportTarget, csvEntries, exportPlaintext, guessCsvMapping, parseCsv, prepareImportedDatabase } from '../src/comp/app/vault-formats';
import { getSessionAccess } from '../src/comp/app/session-access';
import type { AppModel } from '../src/models/app-model';
import type { FileModel } from '../src/models/file-model';
import type { GroupModel } from '../src/models/group-model';

async function fixture() {
    const credentials = new Credentials(ProtectedValue.fromString('master'));
    await credentials.ready;
    const db = Kdbx.create(credentials, 'Formats');
    const raw = db.createGroup(db.getDefaultGroup(), 'Nested');
    const root = { id: 'root', group: db.getDefaultGroup(), parentGroup: null, title: 'Formats' } as GroupModel;
    const group = { id: 'nested', group: raw, parentGroup: root, title: 'Nested' } as GroupModel;
    const file = { id: 'vault', db, name: 'Formats', active: true, editSeq: 0,
        getGroup: (id: string) => id === 'nested' ? group : root,
        setModified() { this.editSeq++; }, reload() {} } as unknown as FileModel;
    group.file = root.file = file;
    const model = { files: Object.assign([file], { get: () => file }), refresh() {}, settings: {
        canImportCsv: true, canSaveTo: true, canExportXml: true, canExportHtml: true
    } } as unknown as AppModel;
    return { db, file, model, group };
}

test('strict CSV preserves BOM, Unicode, CRLF inside quotes, spaces, backslashes, empty fields and protects passwords', async () => {
    const data = parseCsv('\uFEFFTitle,Password,Notes,Custom\r\n"雪, one"," \\\\secret ","line 1\r\nline ""2""",\r\nsecond,,tail ,value  \r\n');
    const mapping = guessCsvMapping(data.headers);
    const db = await prepareImportedDatabase('csv', data, mapping, 'Imported', 'new master');
    const [first, second] = db.getDefaultGroup().entries;
    expect(first.fields.get('Title')).toBe('雪, one');
    expect(first.fields.get('Password')).toBeInstanceOf(ProtectedValue);
    expect((first.fields.get('Password') as ProtectedValue).getText()).toBe(' \\\\secret ');
    expect(first.fields.get('Notes')).toBe('line 1\r\nline "2"');
    expect(first.fields.get('Custom')).toBe('');
    expect(second.fields.get('Custom')).toBe('value  ');
    expect((second.fields.get('Password') as ProtectedValue).getText()).toBe('');
    expect(() => parseCsv('a,b\n1')).toThrow('same number');
    expect(() => parseCsv('a,b\n"bad"suffix,x')).toThrow('quoting');
    expect(() => csvEntries(db, db.groups[0], data, ['Title', 'Title', '', ''])).toThrow('distinct');
});

test('destination commits once, rejects changes, read-only, trash, policy and stale sessions without partial rows', async () => {
    const data = parseCsv('Title,Password\none,s1\ntwo,s2');
    for (const reason of ['edit', 'readonly', 'trash', 'policy', 'session', 'reparent', 'rename', 'db', 'removed']) {
        const { model, file, db, group } = await fixture();
        const target = captureImportTarget(model, group);
        if (reason === 'edit') file.editSeq++;
        if (reason === 'readonly') (file as FileModel & { readOnly: boolean }).readOnly = true;
        if (reason === 'trash') db.meta.recycleBinUuid = group.group.uuid;
        if (reason === 'policy') model.settings.canImportCsv = false;
        if (reason === 'session') getSessionAccess(model).beginSecuring();
        if (reason === 'reparent') group.parentGroup = null;
        if (reason === 'rename') group.title = 'Changed';
        if (reason === 'db') file.db = Kdbx.create(db.credentials, 'Replacement');
        if (reason === 'removed') db.groups[0].groups = [];
        expect(() => target.commit(data, ['Title', 'Password'])).toThrow();
        expect(group.group.entries).toHaveLength(0);
    }
    const { model, group } = await fixture();
    const target = captureImportTarget(model, group);
    expect(() => target.commit(data, ['Title', 'Title'])).toThrow();
    expect(group.group.entries).toHaveLength(0);
    target.commit(data, ['Title', 'Password']);
    expect(group.group.entries).toHaveLength(2);
    expect(() => target.commit(data, ['Title', 'Password'])).toThrow();
    expect(group.group.entries).toHaveLength(2);
});

test('XML roundtrip keeps identities, protected fields, history and binary bytes without changing the source', async () => {
    const { model, file, db, group } = await fixture();
    const entry = db.createEntry(group.group);
    entry.fields.set('Title', '<script>bad()</script>');
    entry.fields.set('Password', ProtectedValue.fromString('earlier'));
    entry.pushHistory();
    entry.fields.set('Password', ProtectedValue.fromString('current'));
    entry.fields.set('Custom', ProtectedValue.fromString('hidden'));
    entry.binaries.set('proof.bin', await db.createBinary(new Uint8Array([0, 128, 255])));
    const xml = await exportPlaintext(model, file, 'xml', () => {});
    const loaded = await prepareImportedDatabase('xml', xml, [], 'Imported', 'new password');
    const restored = [...loaded.groups[0].allEntries()].find(item => item.uuid.equals(entry.uuid))!;
    expect(restored.parentGroup?.uuid.id).toBe(group.group.uuid.id);
    expect((restored.fields.get('Custom') as ProtectedValue).getText()).toBe('hidden');
    expect((restored.history[0].fields.get('Password') as ProtectedValue).getText()).toBe('earlier');
    expect((restored.binaries.get('proof.bin') as { value: ArrayBuffer }).value).toEqual(new Uint8Array([0, 128, 255]).buffer);
    expect(db.xml).toBeUndefined();
    expect(file.editSeq).toBe(0);
    expect(entry.history).toHaveLength(1);
    await expect(prepareImportedDatabase('xml', '<not-keepass/>', [], 'Bad', 'password')).rejects.toThrow();
});

test('a refresh error after publication cannot append the same batch again', async () => {
    const { model, file, group } = await fixture();
    const data = parseCsv('Title,Password\none,secret');
    file.reload = () => { throw new Error('Refresh failed'); };
    const target = captureImportTarget(model, group);
    expect(() => target.commit(data, ['Title', 'Password'])).toThrow('Refresh failed');
    expect(target.committed).toBe(true);
    expect(group.group.entries).toHaveLength(1);
    expect(() => target.commit(data, ['Title', 'Password'])).toThrow('destination changed');
    expect(group.group.entries).toHaveLength(1);
});

test('HTML escapes all text and names, keeps attachment bytes, never activates stored URLs', async () => {
    const { model, file, db, group } = await fixture();
    const attack = '<img src=x onerror="alert(1)">&\'"';
    file.name = attack; group.group.name = attack;
    const entry = db.createEntry(group.group);
    entry.fields.set('Title', attack);
    entry.fields.set(attack, ProtectedValue.fromString(attack));
    entry.fields.set('URL', 'javascript:alert(1)');
    entry.binaries.set(attack, await db.createBinary(new Uint8Array([0, 128, 255])));
    const html = await exportPlaintext(model, file, 'html', () => {});
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;img');
    expect(html).toContain('base64,AID/');
    expect(html).toContain("default-src 'none'");
});

test('export rechecks policy, cancellation and the session after asynchronous work', async () => {
    for (const reason of ['policy', 'cancel', 'session', 'closed', 'replaced']) {
        const { model, file, db } = await fixture();
        let canceled = false;
        const pending = exportPlaintext(model, file, 'xml', () => { if (canceled) throw new Error('Canceled'); });
        if (reason === 'policy') model.settings.canExportXml = false;
        if (reason === 'cancel') canceled = true;
        if (reason === 'session') getSessionAccess(model).beginSecuring();
        if (reason === 'closed') file.active = false;
        if (reason === 'replaced') file.db = Kdbx.create(db.credentials, 'Replacement');
        await expect(pending).rejects.toThrow();
    }
});
