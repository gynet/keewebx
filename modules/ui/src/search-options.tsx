import type { GroupModel } from 'models/group-model';
import type { AppModel } from 'models/app-model';
import type { AdvancedFilter } from 'util/entry-search';
import { Colors } from 'const/colors';
import { t } from './i18n';
import './search-options.css';

export type SearchOptions = AdvancedFilter & { exact?: boolean };
export interface SearchScope { file?: string; group?: string; tag?: string; trash?: boolean; color?: string | boolean }
export const searchDefaults: SearchOptions = {
    title: true, user: true, url: true, notes: true, other: true, metadata: true,
    pass: false, protect: false, history: false, cs: false, regex: false, exact: false
};
const fields = [
    ['title', 'Title'], ['user', 'Username'], ['url', 'Website'], ['notes', 'Notes'],
    ['other', 'Other unprotected fields'], ['metadata', 'Tags and attachment names'], ['pass', 'Passwords'], ['protect', 'Protected fields and OTP'],
    ['cs', 'Case sensitive'], ['regex', 'Regular expression'], ['exact', 'Exact phrase'], ['history', 'Search history']
] as const;

export function SearchControls({ model, options, scope, change, reset }: {
    model: AppModel; options: SearchOptions; scope: SearchScope;
    change: (options: SearchOptions, scope: SearchScope) => boolean; reset: () => void;
}) {
    const groups = model.files.filter(file => file.active && (!scope.file || scope.file === file.id)).flatMap(file => {
        const result: { id: string; title: string }[] = [];
        const visit = (group: typeof file.groups[0], prefix: string) => {
            if (group.visible === false) return;
            const title = `${prefix}${group.title}`;
            result.push({ id: group.id, title });
            (group.items as GroupModel[] | null)?.forEach(child => visit(child, `${title} / `));
        };
        file.groups.forEach(root => visit(root, `${file.name} / `));
        return result;
    });
    return <details class="search-options">
        <summary>{t('Search options')}{Object.entries(options).some(([key, value]) => value !== searchDefaults[key as keyof SearchOptions])
            || Object.values(scope).some(Boolean) ? ` — ${t('Filters active')}` : ''}</summary>
        <div class="search-options__body">
            <fieldset><legend>{t('Search fields and matching')}</legend>
                {fields.map(([key, label]) => <label class="search-options__check" key={key}>
                    <input type="checkbox" checked={!!options[key]} onChange={event => {
                        if (!change({ ...options, [key]: event.currentTarget.checked }, scope)) event.currentTarget.checked = !!options[key];
                    }} />{t(label)}
                </label>)}
            </fieldset>
            <p class="muted">{t('Exact phrase finds a contiguous phrase, not whole-field equality. Regular expression takes precedence. Secrets are excluded unless their options are enabled.')}</p>
            <label class="vault-form__field">{t('Search vault')}
                <select class="input" value={scope.file ?? ''} onChange={event => {
                    if (!change(options, { ...scope, file: event.currentTarget.value || undefined, group: undefined })) event.currentTarget.value = scope.file ?? '';
                }}><option value="">{t('All vaults')}</option>{model.files.filter(file => file.active).map(file => <option value={file.id}>{file.name}</option>)}</select>
            </label>
            <label class="vault-form__field">{t('Search group')}
                <select class="input" disabled={scope.trash} value={scope.group ?? ''} onChange={event => {
                    if (!change(options, { ...scope, group: event.currentTarget.value || undefined })) event.currentTarget.value = scope.group ?? '';
                }}><option value="">{t('All groups')}</option>{groups.map(group => <option value={group.id}>{group.title}</option>)}</select>
            </label>
            <label class="vault-form__field">{t('Search tag')}
                <select class="input" value={scope.tag ?? ''} onChange={event => {
                    if (!change(options, { ...scope, tag: event.currentTarget.value || undefined })) event.currentTarget.value = scope.tag ?? '';
                }}><option value="">{t('All tags')}</option>{model.tags.map(tag => <option value={tag}>{tag}</option>)}</select>
            </label>
            <label class="vault-form__field">{t('Search color')}
                <select class="input" value={scope.color === true ? 'any' : scope.color || ''} onChange={event => {
                    const value = event.currentTarget.value;
                    if (!change(options, { ...scope, color: value === 'any' ? true : value || undefined })) event.currentTarget.value = scope.color === true ? 'any' : scope.color || '';
                }}><option value="">{t('All colors')}</option><option value="any">{t('Any color')}</option>{Colors.AllColors.map(color => <option value={color}>{t(color)}</option>)}</select>
            </label>
            <label class="search-options__check"><input type="checkbox" checked={!!scope.trash} onChange={event => {
                if (!change(options, { ...scope, trash: event.currentTarget.checked, group: undefined })) event.currentTarget.checked = !!scope.trash;
            }} />{t('Search trash')}</label>
            <button type="button" class="pill" onClick={reset}>{t('Reset search and filters')}</button>
            <details><summary>{t('Keyboard shortcuts')}</summary>
                <p>{t('Ctrl (Command on Mac): F search, O open, S save, L lock, G generator, comma settings. Outside text fields: C copy password, B username, U website with Ctrl/Command; Alt+2 copies the current code. Alt+N creates an entry. Arrow keys navigate entries; Escape clears search or cancels an editor with confirmation. Alt+A shows all items, Alt+C colored items, Alt+D trash. Ctrl/Command+Delete removes the focused attachment with confirmation.')}</p>
            </details>
        </div>
    </details>;
}
