import type { AppModel } from 'models/app-model';
import type { SearchResultCollection } from 'collections/search-result-collection';
import { Comparators } from 'util/data/comparators';
import { t } from './i18n';

const options = [
    ['title', 'Title: A to Z'], ['-title', 'Title: Z to A'],
    ['website', 'Website: A to Z'], ['-website', 'Website: Z to A'],
    ['user', 'Username: A to Z'], ['-user', 'Username: Z to A'],
    ['created', 'Created: oldest first'], ['-created', 'Created: newest first'],
    ['updated', 'Modified: oldest first'], ['-updated', 'Modified: newest first'],
    ['-attachments', 'Attachments'], ['-rank', 'Search relevance']
] as const;

export function sortEntries(result: SearchResultCollection, sort: string, filter: ReturnType<AppModel['prepareFilter']>): void {
    if (sort === '-rank') {
        // The shared rank factory reads this.filter, while SearchResultCollection stores entryFilter.
        // Bind the prepared active query locally, without changing the Classic collection/prototype.
        result.comparators['-rank'] = Comparators.rankComparator().bind({ filter }) as (x: unknown, y: unknown) => number;
    }
    result.sortEntries(sort, filter);
}

export function EntrySort({ value, onChange }: { value: string; onChange: (sort: string) => boolean }) {
    return <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '0 14px 8px', minWidth: 0 }}>
        <span>{t('Sort')}</span>
        <select aria-label={t('Sort entries')} class="input" value={value} style={{ flex: 1, minWidth: 0 }}
            onChange={event => {
                const next = event.currentTarget.value;
                if (!options.some(([key]) => key === next) || !onChange(next)) event.currentTarget.value = value;
            }}>
            {options.map(([key, label]) => <option value={key} key={key}>{t(label)}</option>)}
        </select>
    </label>;
}
