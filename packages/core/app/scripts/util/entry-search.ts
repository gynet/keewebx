import { BuiltInFields } from 'const/entry-fields';

/** A string-like value that may be a kdbxweb ProtectedValue */
interface ProtectedStringValue {
    isProtected?: boolean;
    includes(s: string): boolean;
    includesLower?(s: string): boolean;
    getText?(): string;
    indexOf?(s: string): number;
    toLowerCase?(): string;
}

type FieldValue = string | ProtectedStringValue;

interface EntryFields {
    Title?: FieldValue;
    UserName?: FieldValue;
    Password?: FieldValue;
    URL?: FieldValue;
    Notes?: FieldValue;
    otp?: FieldValue;
    'TOTP Seed'?: FieldValue;
    [key: string]: FieldValue | undefined;
}

interface HistoryEntry {
    fields: EntryFields;
}

interface EntryModel {
    searchTags?: string[];
    searchText: string;
    searchColor?: string | boolean;
    autoTypeEnabled?: boolean;
    fields: EntryFields;
    backend?: string;
    getAllFields(): EntryFields;
    getHistoryEntriesForSearch?(): HistoryEntry[];
}

interface SearchFilter {
    tagLower?: string;
    textLower?: string;
    // Nullable because app-model.prepareFilter() resets these to `null`
    // when clearing a previous search. Every consumer here tests them
    // as falsy before using, so null and undefined behave the same.
    textLowerParts?: string[] | null;
    text?: string;
    textParts?: string[] | null;
    color?: string | boolean;
    autoType?: boolean;
    otp?: boolean;
    advanced?: AdvancedFilter;
}

interface AdvancedFilter {
    regex?: boolean;
    cs?: boolean;
    history?: boolean;
    user?: boolean;
    url?: boolean;
    notes?: boolean;
    pass?: boolean;
    title?: boolean;
    other?: boolean;
    protect?: boolean;
}

interface MatchContext {
    matches?: string[];
}

type MatchFn = (
    str: FieldValue,
    search: unknown,
    context: MatchContext,
    lower?: boolean
) => boolean;

class EntrySearch {
    model: EntryModel;

    constructor(model: EntryModel) {
        this.model = model;
    }

    matches(filter: SearchFilter | null | undefined): boolean {
        if (!filter) {
            return true;
        }
        if (filter.tagLower) {
            if (this.model.searchTags && this.model.searchTags.indexOf(filter.tagLower) < 0) {
                return false;
            }
        }
        if (filter.textLower) {
            if (filter.advanced) {
                if (!this.matchesAdv(filter)) {
                    return false;
                }
            } else if (filter.textLowerParts) {
                const parts = filter.textLowerParts;
                for (let i = 0; i < parts.length; i++) {
                    if (this.model.searchText.indexOf(parts[i]) < 0) {
                        return false;
                    }
                }
            } else {
                if (this.model.searchText.indexOf(filter.textLower) < 0) {
                    return false;
                }
            }
        }
        if (filter.color) {
            if (filter.color === true) {
                if (!this.model.searchColor) {
                    return false;
                }
            } else {
                if (this.model.searchColor !== filter.color) {
                    return false;
                }
            }
        }
        if (filter.autoType) {
            if (!this.model.autoTypeEnabled) {
                return false;
            }
        }
        if (filter.otp) {
            if (!this.model.fields.otp && !this.model.fields['TOTP Seed']) {
                return false;
            }
        }
        return true;
    }

    matchesAdv(filter: SearchFilter): boolean {
        const adv = filter.advanced!;
        let search: unknown;
        let match: MatchFn | undefined;
        if (adv.regex) {
            try {
                search = new RegExp(filter.text!, adv.cs ? '' : 'i');
            } catch (e) {
                return false;
            }
            match = EntrySearch.matchRegex;
        } else if (adv.cs) {
            if (filter.textParts) {
                search = filter.textParts;
                match = EntrySearch.matchStringMulti;
            } else {
                search = filter.text;
                match = EntrySearch.matchString;
            }
        } else {
            if (filter.textLowerParts) {
                search = filter.textLowerParts;
                match = EntrySearch.matchStringMultiLower;
            } else {
                search = filter.textLower;
                match = EntrySearch.matchStringLower;
            }
        }
        if (EntrySearch.matchFields(this.model.getAllFields(), adv, match!, search)) {
            return true;
        }
        if (adv.history && this.model.getHistoryEntriesForSearch) {
            for (const historyEntry of this.model.getHistoryEntriesForSearch()) {
                if (EntrySearch.matchFields(historyEntry.fields, adv, match!, search)) {
                    return true;
                }
            }
        }
        return false;
    }

    static matchString(str: FieldValue, find: unknown): boolean {
        if (typeof str !== 'string' && (str as ProtectedStringValue).isProtected) {
            return (str as ProtectedStringValue).includes(find as string);
        }
        return (str as string).indexOf(find as string) >= 0;
    }

    static matchStringLower(str: FieldValue, findLower: unknown): boolean {
        if (typeof str !== 'string' && (str as ProtectedStringValue).isProtected) {
            return (str as ProtectedStringValue).includesLower!(findLower as string);
        }
        return (str as string).toLowerCase().indexOf(findLower as string) >= 0;
    }

    static matchStringMulti(
        str: FieldValue,
        find: unknown,
        context: MatchContext,
        lower?: boolean
    ): boolean {
        const items = find as string[];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            let strMatches: boolean;
            if (lower) {
                strMatches =
                    typeof str !== 'string' && (str as ProtectedStringValue).isProtected
                        ? (str as ProtectedStringValue).includesLower!(item)
                        : (str as string).includes(item);
            } else {
                strMatches =
                    typeof str !== 'string' && (str as ProtectedStringValue).isProtected
                        ? (str as ProtectedStringValue).includes(item)
                        : (str as string).includes(item);
            }
            if (strMatches) {
                if (context.matches) {
                    if (!context.matches.includes(item)) {
                        context.matches.push(item);
                    }
                } else {
                    context.matches = [item];
                }
            }
        }
        return !!(context.matches && context.matches.length === items.length);
    }

    static matchStringMultiLower(
        str: FieldValue,
        find: unknown,
        context: MatchContext
    ): boolean {
        return EntrySearch.matchStringMulti(str, find, context, true);
    }

    static matchRegex(str: FieldValue, regex: unknown): boolean {
        let text: string;
        if (typeof str !== 'string' && (str as ProtectedStringValue).isProtected) {
            text = (str as ProtectedStringValue).getText!();
        } else {
            text = str as string;
        }
        return (regex as RegExp).test(text);
    }

    static matchFields(
        fields: EntryFields,
        adv: AdvancedFilter,
        compare: MatchFn,
        search: unknown
    ): boolean {
        const context: MatchContext = {};
        const matchField = EntrySearch.matchField;
        if (adv.user && matchField(fields.UserName, compare, search, context)) {
            return true;
        }
        if (adv.url && matchField(fields.URL, compare, search, context)) {
            return true;
        }
        if (adv.notes && matchField(fields.Notes, compare, search, context)) {
            return true;
        }
        if (adv.pass && matchField(fields.Password, compare, search, context)) {
            return true;
        }
        if (adv.title && matchField(fields.Title, compare, search, context)) {
            return true;
        }
        let matches = false;
        if (adv.other || adv.protect) {
            const fieldNames = Object.keys(fields);
            matches = fieldNames.some((field) => {
                if (BuiltInFields.indexOf(field) >= 0) {
                    return false;
                }
                if (typeof fields[field] === 'string') {
                    return adv.other && matchField(fields[field]!, compare, search, context);
                } else {
                    return adv.protect && matchField(fields[field]!, compare, search, context);
                }
            });
        }
        return matches;
    }

    static matchField(
        val: FieldValue | undefined,
        compare: MatchFn,
        search: unknown,
        context: MatchContext
    ): boolean {
        return val ? compare(val, search, context) : false;
    }
}

export { EntrySearch };
export type { EntryModel, SearchFilter, AdvancedFilter, EntryFields, FieldValue };
