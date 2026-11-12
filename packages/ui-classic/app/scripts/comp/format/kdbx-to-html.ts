/* eslint-disable import/no-commonjs */
import * as kdbxweb from 'kdbxweb';
import { RuntimeInfo } from 'const/runtime-info';
import { Links } from 'const/links';
import { DateFormat } from 'comp/i18n/date-format';
import { StringFormat } from 'util/formatting/string-format';
import { Locale } from 'util/locale';

type HbsTemplate = (data: Record<string, unknown>) => string;

// webpack commonjs require for handlebars templates
declare const require: (id: string) => HbsTemplate;

const Templates: { db: HbsTemplate; entry: HbsTemplate } = {
    db: require('templates/export/db.hbs'),
    entry: require('templates/export/entry.hbs')
};

interface FieldMappingEntry {
    name: string;
    locStr: string;
    protect?: boolean;
}

const FieldMapping: FieldMappingEntry[] = [
    { name: 'UserName', locStr: 'user' },
    { name: 'Password', locStr: 'password', protect: true },
    { name: 'URL', locStr: 'website' },
    { name: 'Notes', locStr: 'notes' }
];

const KnownFields: Record<string, boolean> = { 'Title': true };
for (const { name } of FieldMapping) {
    KnownFields[name] = true;
}

interface ConvertOptions {
    name: string;
}

function walkGroup(
    db: kdbxweb.Kdbx,
    group: kdbxweb.KdbxGroup,
    parents: kdbxweb.KdbxGroup[]
): string {
    parents = [...parents, group];
    if (
        (db.meta.recycleBinUuid && group.uuid.equals(db.meta.recycleBinUuid)) ||
        (db.meta.entryTemplatesGroup && group.uuid.equals(db.meta.entryTemplatesGroup))
    ) {
        return '';
    }
    const self = group.entries.map((entry) => walkEntry(db, entry, parents)).join('\n');
    const children = group.groups
        .map((childGroup) => walkGroup(db, childGroup, parents))
        .join('\n');
    return self + children;
}

function walkEntry(
    db: kdbxweb.Kdbx,
    entry: kdbxweb.KdbxEntry,
    parents: kdbxweb.KdbxGroup[]
): string {
    const path = parents.map((group) => group.name).join(' / ');
    const fields: Array<{ title: string; value: string; protect?: boolean }> = [];
    for (const field of FieldMapping) {
        const value = entryField(entry, field.name);
        if (value) {
            fields.push({
                title: StringFormat.capFirst(
                    (Locale as unknown as Record<string, string>)[field.locStr]
                ),
                value,
                protect: field.protect
            });
        }
    }
    for (const [fieldName, fieldValue] of entry.fields) {
        if (!KnownFields[fieldName]) {
            const value = entryField(entry, fieldName);
            if (value) {
                fields.push({
                    title: fieldName,
                    value,
                    protect: fieldValue instanceof kdbxweb.ProtectedValue
                });
            }
        }
    }
    const title = entryField(entry, 'Title');
    let expires: string | undefined;
    if (entry.times.expires && entry.times.expiryTime) {
        expires = DateFormat.dtStr(entry.times.expiryTime);
    }

    const created = entry.times.creationTime;
    const modified = entry.times.lastModTime;

    const attachments = [...entry.binaries]
        .map(([name, data]) => {
            let bytes: ArrayBuffer | Uint8Array | undefined;
            if (data && typeof data === 'object' && 'ref' in data) {
                const refData = (data as kdbxweb.KdbxBinaryRefWithValue).value;
                bytes = refData as ArrayBuffer | Uint8Array | undefined;
            } else {
                bytes = data as ArrayBuffer | Uint8Array | undefined;
            }
            let dataUrl: string | undefined;
            if (bytes) {
                const base64 = kdbxweb.ByteUtils.bytesToBase64(bytes);
                dataUrl = 'data:application/octet-stream;base64,' + base64;
            }
            return { name, data: dataUrl };
        })
        .filter((att) => att.name && att.data);

    return Templates.entry({
        path,
        title,
        fields,
        tags: entry.tags.join(', '),
        created: created ? DateFormat.dtStr(created) : '',
        modified: modified ? DateFormat.dtStr(modified) : '',
        expires,
        attachments
    });
}

function entryField(entry: kdbxweb.KdbxEntry, fieldName: string): string {
    const value = entry.fields.get(fieldName);
    if (value instanceof kdbxweb.ProtectedValue) {
        return value.getText() || '';
    }
    return (value as string) || '';
}

const KdbxToHtml = {
    convert(db: kdbxweb.Kdbx, options: ConvertOptions): string {
        const content = db.groups.map((group) => walkGroup(db, group, [])).join('\n');
        return Templates.db({
            name: options.name,
            date: DateFormat.dtStr(Date.now()),
            appLink: Links.Homepage,
            appVersion: RuntimeInfo.version,
            contentHtml: content
        });
    },

    entryToHtml(db: kdbxweb.Kdbx, entry: kdbxweb.KdbxEntry): string {
        return walkEntry(db, entry, []);
    }
};

export { KdbxToHtml };
