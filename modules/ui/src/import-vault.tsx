import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import { IdGenerator } from 'util/generators/id-generator';
import { getSessionAccess } from 'comp/app/session-access';
import { captureImportTarget, csvFields, guessCsvMapping, parseCsv, prepareImportedDatabase, validateCsvMapping, type CsvData } from 'comp/app/vault-formats';
import { hasPendingDrafts } from './pending-drafts';
import { t } from './i18n';

type Source = { format: 'csv'; data: CsvData } | { format: 'xml'; data: string };
export function ImportVault({ model, onDone, canImport }: { model: AppModel; onDone?: () => void; canImport?: () => boolean }) {
    const [source, setSource] = useState<Source>();
    const [mapping, setMapping] = useState<string[]>([]);
    const [name, setName] = useState('');
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [destination, setDestination] = useState('');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [showPreview, setShowPreview] = useState(false);
    const target = useRef<ReturnType<typeof captureImportTarget>>();
    const generation = useRef(0);
    const working = useRef(false);
    const input = useRef<HTMLInputElement>(null);
    const epoch = useRef(getSessionAccess(model).epoch);
    useEffect(() => () => { ++generation.current; }, []);
    const cancel = () => {
        ++generation.current; setSource(undefined); setMapping([]); setPassword(''); setConfirmation('');
        setDestination(''); target.current = undefined; working.current = false; setBusy(false); setShowPreview(false); setMessage('');
    };
    const assert = (version: number) => {
        getSessionAccess(model).assertOpen(epoch.current);
        if (version !== generation.current || canImport?.() === false) throw new Error('Import canceled.');
        if (hasPendingDrafts()) throw new Error('Apply or discard unsaved edits before importing.');
    };
    const read = async (file: File) => {
        cancel();
        const version = generation.current;
        epoch.current = getSessionAccess(model).epoch;
        working.current = true; setBusy(true);
        try {
            assert(version);
            const format = /\.csv$/i.test(file.name) ? 'csv' : /\.xml$/i.test(file.name) ? 'xml' : undefined;
            if (!format || !model.settings[format === 'csv' ? 'canImportCsv' : 'canImportXml']) throw new Error('This import format is unavailable.');
            const value = await file.text();
            assert(version);
            if (format === 'csv') {
                const data = parseCsv(value);
                setMapping(guessCsvMapping(data.headers)); setSource({ format, data });
            } else setSource({ format, data: value });
            setName(file.name.replace(/\.(csv|xml)$/i, ''));
        } catch (error) { if (version === generation.current) setMessage((error as Error).message); }
        finally { if (version === generation.current) { working.current = false; setBusy(false); } }
    };
    const groups: { group: GroupModel; label: string }[] = [];
    for (const file of model.files) {
        if (!file.active || (file as FileModel & { readOnly?: boolean }).readOnly) continue;
        const namesakes = model.files.filter(candidate => candidate.name === file.name);
        const fileLabel = namesakes.length > 1 ? `${file.name} (${namesakes.indexOf(file) + 1})` : file.name;
        const walk = (group: GroupModel, path: string[]) => {
            if (file.db.meta.recycleBinUuid?.equals(group.group.uuid)) return;
            const siblings = group.parentGroup ? group.parentGroup.group.groups : file.db.groups;
            const sameName = siblings.filter(sibling => file.getGroup(file.subId(sibling.uuid.id))?.title === group.title);
            const title = !group.title || /[\/"\\()\u0000-\u001f]/.test(group.title) ? JSON.stringify(group.title) : group.title;
            const label = sameName.length > 1 ? `${title} (${sameName.indexOf(group.group) + 1})` : title;
            const labels = [...path, label];
            groups.push({ group, label: `${fileLabel}: ${labels.join(' / ')}` });
            for (const child of group.group.groups) {
                const childModel = file.getGroup(file.subId(child.uuid.id));
                if (childModel) walk(childModel, labels);
            }
        };
        for (const group of file.groups) walk(group, []);
    }
    const commit = async (event: Event) => {
        event.preventDefault();
        if (!source || working.current) return;
        const version = generation.current;
        working.current = true; setBusy(true); setMessage('');
        let published: FileModel | undefined;
        try {
            assert(version);
            if (!model.settings[source.format === 'csv' ? 'canImportCsv' : 'canImportXml']) throw new Error('Import is disabled.');
            if (source.format === 'csv') validateCsvMapping(source.data, mapping);
            if (destination) {
                if (source.format !== 'csv' || !target.current) throw new Error('Choose a destination again.');
                target.current.commit(source.data, mapping);
            } else {
                if (!model.settings.canCreate) throw new Error('Creating vaults is disabled.');
                if (password !== confirmation) throw new Error('Passwords do not match.');
                const db = await prepareImportedDatabase(source.format, source.data, mapping, name, password);
                assert(version);
                if (!model.settings.canCreate || !model.settings[source.format === 'csv' ? 'canImportCsv' : 'canImportXml']) throw new Error('Import is disabled.');
                const file = new FileModel({ id: IdGenerator.uuid(), name: name.trim() });
                file.db = db;
                file.readModel();
                file.set({ active: true, created: true, name: name.trim() });
                file.setModified();
                published = file;
                if (!model.addFile(file)) throw new Error('Could not add the imported vault.');
            }
            cancel(); setMessage(t('Import complete. Save or download KDBX to keep an encrypted copy.')); onDone?.();
        } catch (error) {
            if (version === generation.current) {
                if (target.current?.committed || (published && model.files.get(published.id) === published)) {
                    cancel(); setMessage(t('Data was imported, but the view could not refresh. Do not import it again. Save or download the vault.'));
                } else setMessage((error as Error).message);
            }
        }
        finally { if (version === generation.current) { working.current = false; setBusy(false); } }
    };
    if (!model.settings.canImportXml && !model.settings.canImportCsv) return null;
    return <section class="database-settings cardlist" aria-label={t('Import data')} style={{ minWidth: 0, maxWidth: '100%' }}>
        <h3>{t('Import data')}</h3>
        <p>{t('Import KeePass XML into a new vault, or map CSV columns into a new vault or an existing group. Source files are unencrypted.')}</p>
        <input ref={input} type="file" hidden accept={[model.settings.canImportXml && '.xml', model.settings.canImportCsv && '.csv'].filter(Boolean).join(',')}
            onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void read(file); }} />
        {!source && <button type="button" class="pill" disabled={busy} onClick={() => input.current?.click()}>{t('Choose XML or CSV')}</button>}
        {source && <form onSubmit={commit} aria-label={t('Import preview')}>
            <fieldset disabled={busy} style={{ minWidth: 0 }}>
                {source.format === 'csv' && <>
                    <p>{t('{} rows to import.', String(source.data.rows.length))}</p>
                    {source.data.headers.map((header, column) => <label class="vault-form__field" key={column}>
                        {t('Column {}: {}', String(column + 1), header)}
                        <select class="input" value={mapping[column]} onChange={event => setMapping(mapping.map((value, index) => index === column ? event.currentTarget.value : value))}>
                            <option value="">{t('Ignore')}</option>
                            {[...new Set([...csvFields, ...source.data.headers.map(value => value.trim()).filter(Boolean)])].map(field => <option value={field}>{field}</option>)}
                        </select>
                    </label>)}
                    <label><input type="checkbox" checked={showPreview} onChange={event => setShowPreview(event.currentTarget.checked)} /> {t('Show preview values (includes secrets)')}</label>
                    {showPreview && <div tabIndex={0} role="region" aria-label={t('CSV rows')} style={{ overflow: 'auto', maxHeight: '280px' }}>
                        <table><thead><tr>{source.data.headers.map(header => <th>{header}</th>)}</tr></thead>
                            <tbody>{source.data.rows.map(row => <tr>{row.map(value => <td style={{ whiteSpace: 'pre-wrap', minWidth: '100px', maxWidth: '240px', overflowWrap: 'anywhere' }}>{value}</td>)}</tr>)}</tbody></table>
                    </div>}
                    <label class="vault-form__field">{t('Import destination')}
                        <select class="input" value={destination} onChange={event => {
                            const id = event.currentTarget.value; setDestination(id); target.current = undefined; setMessage('');
                            const selected = groups.find(item => item.group.id === id);
                            if (selected) try { target.current = captureImportTarget(model, selected.group); } catch (error) { setMessage((error as Error).message); }
                        }}>
                            <option value="" disabled={!model.settings.canCreate}>{t('New encrypted vault')}</option>
                            {groups.map(({ group, label }) => <option value={group.id}>{label}</option>)}
                        </select>
                    </label>
                    {destination && <p style={{ overflowWrap: 'anywhere' }}>{t('Destination: {}',
                        groups.find(item => item.group.id === destination)?.label || t('Unavailable. Cancel and select it again.'))}</p>}
                </>}
                {!destination && <>
                    <label class="vault-form__field">{t('Imported vault name')}<input class="input" required value={name} onInput={event => setName(event.currentTarget.value)} /></label>
                    <label class="vault-form__field">{t('Import master password')}<input class="input" type="password" autoComplete="new-password" required value={password} onInput={event => setPassword(event.currentTarget.value)} /></label>
                    <label class="vault-form__field">{t('Confirm import password')}<input class="input" type="password" autoComplete="new-password" required value={confirmation} onInput={event => setConfirmation(event.currentTarget.value)} /></label>
                </>}
                <button type="submit" class="pill pill--primary">{t('Import')}</button>
            </fieldset>
        </form>}
        {(source || busy) && <button type="button" class="pill" onClick={cancel}>{t('Cancel import')}</button>}
        {busy && <p role="status">{t('Preparing import…')}</p>}
        {message && <p role="status">{message}</p>}
    </section>;
}
