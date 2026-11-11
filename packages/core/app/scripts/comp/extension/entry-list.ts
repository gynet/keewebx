/**
 * The entry list the browser extension shows: logins suggested for a page
 * and the rest by recent change or by search. Shared by the vault packaged
 * inside the extension and by the connect protocol used by website tabs.
 * Summaries carry no secrets.
 */
import type { EntryModel } from 'models/entry-model';
import { SelectEntryFilter } from 'comp/app/select-entry-filter';

const RECENT_LIMIT = 30;
const SEARCH_LIMIT = 50;
/** Large custom icons are left out; the list falls back to a letter. */
const MAX_CUSTOM_ICON_CHARS = 24000;

export interface EntrySummary {
    title: string;
    user: string;
    url: string;
    /** Icon font name, when the entry has an icon other than the default key. */
    icon: string | null;
    /** Image data URL of the entry's own icon. */
    customIcon: string | null;
    hasOtp: boolean;
}

interface EntryListModel {
    getEntriesByFilter(filter: Record<string, unknown>, files: unknown): Iterable<unknown>;
}

export function summarizeEntry(entry: EntryModel): EntrySummary {
    const customIcon =
        entry.customIcon && entry.customIcon.length <= MAX_CUSTOM_ICON_CHARS ? entry.customIcon : null;
    return {
        title: entry.title || '',
        user: entry.user || '',
        url: entry.displayUrl || entry.url || '',
        icon: entry.customIcon ? null : entry.iconId ? entry.icon : null,
        customIcon,
        hasOtp: !!entry.otpGenerator || !!entry.fields?.otp || !!entry.fields?.['TOTP Seed']
    };
}

/** Suggestions for `url` (when not searching) and the other entries. */
export function listEntries(
    appModel: EntryListModel,
    files: unknown,
    options: { url?: string; query?: string }
): { suggested: EntryModel[]; items: EntryModel[] } {
    const query = (options.query || '').trim();
    let suggested: EntryModel[] = [];
    if (options.url && !query) {
        const filter = new SelectEntryFilter(
            { url: options.url, title: '' },
            appModel as ConstructorParameters<typeof SelectEntryFilter>[1],
            files,
            {}
        );
        suggested = [...(filter.getEntries() as unknown as EntryModel[])];
    }
    const shown = new Set(suggested.map((e) => e.id));
    const items = ([...appModel.getEntriesByFilter({ text: query }, files)] as EntryModel[])
        .filter((e) => !shown.has(e.id))
        .sort((a, b) =>
            query
                ? (a.title || '').localeCompare(b.title || '')
                : (b.updated?.getTime() ?? 0) - (a.updated?.getTime() ?? 0)
        )
        .slice(0, query ? SEARCH_LIMIT : RECENT_LIMIT);
    return { suggested, items };
}

/** Text of one field, for filling or copying. */
export function entryFieldText(entry: EntryModel, field: unknown): Promise<string> {
    switch (field) {
        case 'user':
            return Promise.resolve(entry.user || '');
        case 'password':
            return Promise.resolve(entry.password?.getText?.() ?? String(entry.password ?? ''));
        case 'url':
            return Promise.resolve(entry.url || '');
        case 'otp': {
            entry.initOtpGenerator();
            const generator = entry.otpGenerator;
            if (!generator) {
                return Promise.resolve('');
            }
            return new Promise((resolve, reject) =>
                generator.next((err, pass) => (err ? reject(err) : resolve(pass || '')))
            );
        }
        default:
            return Promise.reject(new Error('Unknown field'));
    }
}
