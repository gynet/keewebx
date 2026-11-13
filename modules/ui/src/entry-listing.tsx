import { toChildArray, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import type { EntryModel } from 'models/entry-model';
import { summarizeEntry } from 'comp/extension/entry-list';
import { usePreferences, PreferenceCheck } from './app-preferences';
import { EntryFlag } from './entry-appearance';
import { PreferenceTile } from './preference-tile';
import { tableColumns, visibleColumns, ENTRY_PAGE_SIZE, entryPage, type TableColumn } from './entry-table-data';
import { t } from './i18n';
import './entry-listing.css';

export function TablePreference() {
    const settings = usePreferences();
    const columns = visibleColumns(settings.tableViewColumns);
    return <div class="cardlist app-preferences">
        <PreferenceCheck name="tableView" label="Show entries as a table on desktop" />
        <p class="general-preferences__help">{t('Narrow screens use the list view without changing your desktop preference.')}</p>
        <details class="preference-help"><summary>{t('Table columns')}</summary>
            <p>{t('Title stays visible so every row can be selected. Protected fields stay masked.')}</p>
            {tableColumns.map(([key, label]) => <label class="cardlist__row" key={key}><span>{t(label)}</span>
                <input type="checkbox" checked={columns.includes(key)} disabled={key === 'title'} onChange={event => {
                    const enabled = event.currentTarget.checked;
                    // Keep unknown imported column names so another interface can still use them.
                    const previous = Array.isArray(settings.tableViewColumns) ? settings.tableViewColumns.filter(value => typeof value === 'string') : columns;
                    settings.tableViewColumns = [...new Set(enabled ? [...previous, key, 'title'] : previous.filter(value => value !== key).concat('title'))];
                }} /></label>)}
        </details>
    </div>;
}
function protectedField(entry: EntryModel, name: string): boolean {
    const value = entry.entry.fields.get(name);
    return !!value && typeof value === 'object' && 'isProtected' in value && value.isProtected === true;
}
function cell(entry: EntryModel, key: TableColumn): string {
    const field = key === 'user' ? 'UserName' : key === 'website' ? 'URL' : key === 'notes' ? 'Notes' : '';
    if (field && protectedField(entry, field)) return '••••••';
    return key === 'user' ? entry.user : key === 'website' ? entry.displayUrl || entry.url : key === 'notes' ? entry.notes
        : key === 'tags' ? entry.tags.join(', ') : key === 'group' ? entry.groupName : key === 'file' ? entry.fileName : entry.title;
}
export function EntryListing({ entries, selected, choose, historyMatch, children }: {
    entries: readonly EntryModel[]; selected?: string; choose(id: string): void;
    historyMatch(entry: EntryModel): boolean; children: ComponentChildren;
}) {
    const settings = usePreferences();
    const [wide, setWide] = useState(() => matchMedia('(min-width: 901px)').matches);
    const [page, setPage] = useState(0);
    const currentPage = entryPage(page, entries.length);
    const ids = entries.map(entry => entry.id).join('\0');
    useLayoutEffect(() => {
        const index = entries.findIndex(entry => entry.id === selected);
        setPage(current => index >= 0 ? Math.floor(index / ENTRY_PAGE_SIZE) : entryPage(current, entries.length));
    }, [selected, ids]);
    useEffect(() => {
        const media = matchMedia('(min-width: 901px)');
        const changed = () => setWide(media.matches);
        media.addEventListener('change', changed); return () => media.removeEventListener('change', changed);
    }, []);
    const start = currentPage * ENTRY_PAGE_SIZE;
    const shown = entries.slice(start, start + ENTRY_PAGE_SIZE);
    const columns = visibleColumns(settings.tableViewColumns);
    return <>
        {entries.length > ENTRY_PAGE_SIZE && <nav class="entry-pages" aria-label={t('Entry pages')}>
            <button type="button" class="pill" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>{t('Previous page')}</button>
            <span role="status">{t('Entries {}–{} of {}', String(start + 1), String(Math.min(start + ENTRY_PAGE_SIZE, entries.length)), String(entries.length))}</span>
            <button type="button" class="pill" disabled={start + ENTRY_PAGE_SIZE >= entries.length} onClick={() => setPage(currentPage + 1)}>{t('Next page')}</button>
        </nav>}
        {!settings.tableView || !wide ? <div class="list__items">{toChildArray(children).slice(start, start + ENTRY_PAGE_SIZE)}</div>
            : <div class="list__items entry-table-scroll"><table class="entry-table" style={{ minWidth: columns.length * 120 + 30 }} aria-label={t('Entries table')}>
                <thead><tr>{columns.map(key => <th scope="col" key={key}>{t(tableColumns.find(column => column[0] === key)![1])}</th>)}</tr></thead>
                <tbody>{shown.map(entry => {
                    const summary = summarizeEntry(entry);
                    const title = protectedField(entry, 'Title') ? '••••••' : summary.title;
                    return <tr key={entry.id} data-selected={entry.id === selected ? 'true' : undefined}>
                        <th scope="row"><button type="button" class="entry-row" data-entry={title} data-entry-id={entry.id}
                            aria-current={entry.id === selected ? 'true' : undefined} onClick={() => choose(entry.id)}>
                            <PreferenceTile title={title} icon={summary.icon} customIcon={entry.customIcon} url={protectedField(entry, 'URL') ? '' : summary.url} />
                            <span><EntryFlag color={entry.color} />{title || t('(no title)')}{historyMatch(entry) && <small>{t('Match in history — open History')}</small>}</span>
                        </button></th>
                        {columns.filter(key => key !== 'title').map(key => <td key={key}>{cell(entry, key) || t('(empty)')}</td>)}
                    </tr>;
                })}</tbody>
            </table></div>}
    </>;
}
