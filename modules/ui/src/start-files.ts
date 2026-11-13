export type StartFiles = { kind: 'database'; file: File; key?: File } | { kind: 'import'; file: File };

/** Reject ambiguous drops rather than silently ignoring extra databases or keys. */
export function classifyStartFiles(files: readonly File[], settings: {
    canOpen: boolean; canImportCsv: boolean; canImportXml: boolean;
}): StartFiles {
    if (!settings.canOpen) throw new Error('Opening new files is disabled.');
    if (!files.length || files.length > 2) throw new Error('Choose one database, optionally with one key file.');
    if (files.length === 1 && /\.(csv|xml)$/i.test(files[0].name)) {
        const allowed = /\.csv$/i.test(files[0].name) ? settings.canImportCsv : settings.canImportXml;
        if (!allowed) throw new Error('This import format is disabled.');
        return { kind: 'import', file: files[0] };
    }
    if (files.length === 1) return { kind: 'database', file: files[0] };
    const databases = files.filter(file => /\.kdbx$/i.test(file.name));
    if (databases.length !== 1) throw new Error('Drop exactly one .kdbx database and one key file.');
    const key = files.find(file => file !== databases[0])!;
    if (/\.(kdb|csv|xml)$/i.test(key.name)) throw new Error('The second file must be a key file.');
    return { kind: 'database', file: databases[0], key };
}
