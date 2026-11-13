import { Credentials, Kdbx, KdbxEntry, ProtectedValue } from 'kdbxweb';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import { getSessionAccess } from './session-access';
import { createExportSnapshot } from '../../util/kdbxweb/export-snapshot';
import { waitForCredentialChanges } from '../../util/kdbxweb/credential-changes';
import { KdbxToHtml } from '../format/kdbx-to-html';
import { CsvParser } from '../../util/data/csv-parser';

export type PlaintextFormat = 'xml' | 'html';
export type CsvData = { headers: string[]; rows: string[][] };
export const csvFields = ['Title', 'UserName', 'Password', 'URL', 'Notes'];

export function parseCsv(source: string): CsvData {
    const data = new CsvParser().parse(source, { strict: true });
    if (data.rows.some(row => row.length !== data.headers.length)) throw new Error('Every CSV row must have the same number of columns as the header.');
    return data;
}
export function guessCsvMapping(headers: string[]): string[] {
    const patterns = [/title|\bname|account/i, /user|login/i, /pass/i, /url|site/i, /notes|comment|extra/i];
    const used = new Set<string>();
    return headers.map(header => {
        const trimmed = header.trim();
        if (!trimmed || /^(group|grouping)$/i.test(trimmed)) return '';
        const field = csvFields[patterns.findIndex(pattern => pattern.test(trimmed))] || trimmed;
        if (used.has(field)) return '';
        used.add(field);
        return field;
    });
}
export function validateCsvMapping(data: CsvData, mapping: string[]): void {
    const fields = mapping.filter(Boolean);
    if (mapping.length !== data.headers.length || !fields.length || new Set(fields).size !== fields.length) {
        throw new Error('Choose distinct fields for each column, or Ignore.');
    }
    if (data.rows.some(row => row.length !== mapping.length)) throw new Error('Invalid CSV row width.');
}

/** Construct the whole batch before touching a destination, including empty and protected values. */
export function csvEntries(db: Kdbx, group: GroupModel['group'], data: CsvData, mapping: string[]): KdbxEntry[] {
    validateCsvMapping(data, mapping);
    return data.rows.map(row => {
        const entry = KdbxEntry.create(db.meta, group);
        row.forEach((value, column) => {
            const field = mapping[column];
            if (field) entry.fields.set(field, field === 'Password' ? ProtectedValue.fromString(value) : value);
        });
        return entry;
    });
}

export function captureImportTarget(model: AppModel, group: GroupModel) {
    const file = group.file as FileModel;
    const db = file.db;
    const seq = file.editSeq;
    const epoch = getSessionAccess(model).epoch;
    const chain: { group: GroupModel; parent: GroupModel | null; title: string }[] = [];
    for (let node: GroupModel | null = group; node; node = node.parentGroup) {
        if (chain.some(item => item.group === node)) throw new Error('Invalid destination.');
        chain.push({ group: node, parent: node.parentGroup, title: node.title });
    }
    let consumed = false;
    const assert = () => {
        getSessionAccess(model).assertOpen(epoch);
        if (consumed || !model.settings.canImportCsv || !file.active || file.syncing ||
            (file as FileModel & { readOnly?: boolean }).readOnly || model.files.get(file.id) !== file ||
            file.db !== db || file.editSeq !== seq || chain.some(item =>
                file.getGroup(item.group.id) !== item.group || item.group.parentGroup !== item.parent ||
                item.group.title !== item.title || db.meta.recycleBinUuid?.equals(item.group.group.uuid) ||
                !(item.parent ? item.parent.group.groups : db.groups).includes(item.group.group))) {
            throw new Error('The destination changed or is unavailable. Cancel and select it again.');
        }
    };
    assert();
    return { assert, get committed() { return consumed; }, commit(data: CsvData, mapping: string[]) {
        assert();
        const entries = csvEntries(db, group.group, data, mapping);
        assert();
        consumed = true;
        // One synchronous publication; a retry cannot append the same batch twice.
        group.group.entries = group.group.entries.concat(entries);
        file.setModified();
        file.reload();
        model.refresh();
    } };
}

export async function prepareImportedDatabase(format: 'xml' | 'csv', source: string | CsvData,
    mapping: string[], name: string, password: string): Promise<Kdbx> {
    if (!name.trim() || !password) throw new Error('A name and master password are required.');
    const credentials = new Credentials(ProtectedValue.fromString(password));
    await credentials.ready;
    if (format === 'xml') return Kdbx.loadXml(source as string, credentials);
    const db = Kdbx.create(credentials, name.trim());
    const group = db.getDefaultGroup();
    group.entries = csvEntries(db, group, source as CsvData, mapping);
    return db;
}

export async function exportPlaintext(model: AppModel, file: FileModel, format: PlaintextFormat,
    assertCurrent: () => void): Promise<string> {
    const access = getSessionAccess(model);
    const epoch = access.epoch;
    const db = file.db;
    const assert = () => {
        access.assertOpen(epoch);
        assertCurrent();
        if (!model.settings.canSaveTo || !model.settings[format === 'xml' ? 'canExportXml' : 'canExportHtml'] ||
            !file.active || model.files.get(file.id) !== file || file.db !== db) throw new Error('Export is no longer available.');
    };
    assert();
    await waitForCredentialChanges(db.credentials);
    assert();
    const snapshot = createExportSnapshot(db);
    const result = format === 'xml' ? await snapshot.saveXml(true) : KdbxToHtml.convert(snapshot, { name: file.name });
    assert();
    return result;
}
