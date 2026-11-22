import { SearchResultCollection } from 'collections/search-result-collection';
import { Ranking } from 'util/data/ranking';

import { storedWebsiteUrl } from 'comp/extension/website-matching';

interface WindowInfo {
    title?: string;
    url?: string;
}

interface FilterOptions {
    [key: string]: unknown;
}

interface EntryLike {
    title: string;
    searchText: string;
    getAllUrls(): string[];
}

interface AppModelLike {
    getEntriesByFilter(filter: Record<string, unknown>, files: unknown): EntryLike[];
}

class SelectEntryFilter {
    title: string | undefined;
    useTitle: boolean;
    url: string | undefined;
    useUrl: boolean;
    subdomains: boolean;
    text: string;
    appModel: AppModelLike;
    files: unknown;
    filterOptions: FilterOptions;

    constructor(windowInfo: WindowInfo, appModel: AppModelLike, files: unknown, filterOptions: FilterOptions) {
        this.title = windowInfo.title;
        this.useTitle = !!windowInfo.title && !windowInfo.url;
        this.url = windowInfo.url;
        this.useUrl = !!windowInfo.url;
        this.subdomains = true;
        this.text = '';
        this.appModel = appModel;
        this.files = files;
        this.filterOptions = filterOptions;
    }

    getEntries(): SearchResultCollection {
        const filter: Record<string, unknown> = {
            text: this.text,
            ...this.filterOptions
        };
        let entries: [EntryLike, number][] = this.appModel
            .getEntriesByFilter(filter, this.files)
            .map((e): [EntryLike, number] => [e, this._getEntryRank(e)]);
        if (this.useUrl || this.useTitle) {
            entries = entries.filter((e) => e[1]);
        }
        entries = entries.sort((x, y) =>
            x[1] === y[1] ? x[0].title.localeCompare(y[0].title) : y[1] - x[1]
        );
        const sorted = entries.map((p) => p[0]);
        return new SearchResultCollection(sorted, { comparator: 'none' });
    }

    _getEntryRank(entry: EntryLike): number {
        let titleRank = 0;
        let urlRank = 0;

        if (this.useTitle && this.title && entry.title) {
            titleRank = Ranking.getStringRank(entry.title.toLowerCase(), this.title.toLowerCase());
            if (!titleRank) {
                return 0;
            }
        }

        if (this.useUrl && this.url) {
            const destination = storedWebsiteUrl(this.url);
            if (!destination) return 0;
            for (const value of entry.getAllUrls()) {
                const stored = storedWebsiteUrl(value);
                if (!stored || stored.port !== destination.port) continue;
                const exact = stored.hostname === destination.hostname;
                const subdomain = this.subdomains && destination.hostname.endsWith('.' + stored.hostname);
                if (!exact && !subdomain) continue;

                urlRank += exact ? 20 : 10;
                const path = stored.pathname;
                const searchPath = destination.pathname;
                if (path === searchPath) {
                    urlRank += 10;
                } else if (path.startsWith(searchPath)) {
                    urlRank += 5;
                } else if (searchPath.startsWith(path)) {
                    urlRank += 3;
                }
                if (stored.protocol === destination.protocol) urlRank += 1;
            }
        }

        if (this.useTitle && !titleRank) {
            return 0;
        }
        if (this.useUrl && !urlRank) {
            return 0;
        }

        return titleRank + urlRank;
    }
}

export { SelectEntryFilter };
