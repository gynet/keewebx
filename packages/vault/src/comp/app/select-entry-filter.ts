import { SearchResultCollection } from 'collections/search-result-collection';
import { Ranking } from 'util/data/ranking';

const urlPartsRegex = /^(\w+:\/\/)?(?:(?:www|wwws|secure)\.)?([^\/]+)\/?(.*)/;

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
            const searchUrlLower = this.url.toLowerCase();
            const searchUrlParts = urlPartsRegex.exec(searchUrlLower);

            for (const url of entry.getAllUrls()) {
                const entryUrlParts = urlPartsRegex.exec(url.toLowerCase());
                if (entryUrlParts && searchUrlParts) {
                    const [, scheme, domain, path] = entryUrlParts;
                    const [, searchScheme, searchDomain, searchPath] = searchUrlParts;
                    if (
                        domain === searchDomain ||
                        (this.subdomains && searchDomain.indexOf('.' + domain) > 0)
                    ) {
                        if (domain === searchDomain) {
                            urlRank += 20;
                        } else {
                            urlRank += 10;
                        }
                        if (path === searchPath) {
                            urlRank += 10;
                        } else if (path && searchPath) {
                            if (path.lastIndexOf(searchPath, 0) === 0) {
                                urlRank += 5;
                            } else if (searchPath.lastIndexOf(path, 0) === 0) {
                                urlRank += 3;
                            }
                        }
                        if (scheme === searchScheme) {
                            urlRank += 1;
                        }
                    }
                }
            }

            if (entry.searchText.includes(searchUrlLower)) {
                // the url is in some field; include it
                urlRank += 5;
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
