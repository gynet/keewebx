import { ByteUtils, Kdbx, KdbxEntry, KdbxGroup, ProtectedValue } from 'kdbxweb';

// Database-controlled strings are always text, including URLs and attachment names.
const escape = (value: string) => value.replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const text = (value: string | ProtectedValue | undefined) => value instanceof ProtectedValue ? value.getText() : value || '';

function entryHtml(db: Kdbx, entry: KdbxEntry, path: string): string {
    const row = (key: string, value: string) => `<tr><th>${escape(key)}</th><td>${escape(value)}</td></tr>`;
    const fields = [...entry.fields].filter(([key]) => key !== 'Title').map(([key, value]) => row(key, text(value))).join('');
    const attachments = [...entry.binaries].map(([name, binary]) => {
        const value = 'hash' in binary ? binary.value : binary;
        const bytes = value instanceof ProtectedValue ? value.getBinary() : value;
        return `<li><a download="${escape(name)}" href="data:application/octet-stream;base64,${ByteUtils.bytesToBase64(bytes)}">${escape(name)}</a></li>`;
    }).join('');
    return `<article><p>${escape(path)}</p><h2>${escape(text(entry.fields.get('Title')))}</h2><table>${fields}${row('Tags', entry.tags.join(', '))}${row('Created', entry.times.creationTime?.toISOString() || '')}${row('Modified', entry.times.lastModTime?.toISOString() || '')}${entry.times.expires ? row('Expires', entry.times.expiryTime?.toISOString() || '') : ''}</table>${attachments ? `<h3>Attachments</h3><ul>${attachments}</ul>` : ''}</article>`;
}

export const KdbxToHtml = {
    convert(db: Kdbx, options: { name: string }): string {
        const walk = (group: KdbxGroup, parents: string[]): string => {
            if (db.meta.recycleBinUuid?.equals(group.uuid) || db.meta.entryTemplatesGroup?.equals(group.uuid)) return '';
            const path = [...parents, group.name || ''];
            return group.entries.map(entry => entryHtml(db, entry, path.join(' / '))).join('') +
                group.groups.map(child => walk(child, path)).join('');
        };
        return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(options.name)}</title><style>body{font:16px system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#202124;background:white;overflow-wrap:anywhere}article{border-top:1px solid #ccc;margin-top:2rem}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{text-align:left;vertical-align:top;padding:.5rem;white-space:pre-wrap;border-bottom:1px solid #eee}th{width:25%}@media print{article{break-inside:avoid}}</style></head><body><h1>${escape(options.name)}</h1><p>Unencrypted export. Contains passwords and other secrets. Entry history and trash are not included.</p>${db.groups.map(group => walk(group, [])).join('')}</body></html>`;
    },
    entryToHtml(db: Kdbx, entry: KdbxEntry): string { return entryHtml(db, entry, ''); }
};
