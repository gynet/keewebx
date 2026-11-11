import { Collection } from 'framework/collection';
import { Model } from 'framework/model';
import { Comparators } from 'util/data/comparators';

// Comparators store an arbitrary 2-arg sort function from the
// Comparators namespace alongside one local closure that reads
// `attachments` off the entry. The members are too heterogeneous to
// share a single concrete parameter type, so we widen to `unknown` and
// rely on each comparator's body to narrow as needed (the upstream
// helpers in util/data/comparators.ts already do this).
type ComparatorFn = ((x: unknown, y: unknown) => number) | null;

// Local view of the entry shape the -attachments comparator reads.
interface AttachmentEntry {
    attachments: { title?: string }[];
}

class SearchResultCollection extends Collection {
    static override model = Model;

    comparators: Record<string, ComparatorFn> = {
        'none': null,
        'title': Comparators.stringComparator('title', true) as ComparatorFn,
        '-title': Comparators.stringComparator('title', false) as ComparatorFn,
        'website': Comparators.stringComparator('url', true) as ComparatorFn,
        '-website': Comparators.stringComparator('url', false) as ComparatorFn,
        'user': Comparators.stringComparator('user', true) as ComparatorFn,
        '-user': Comparators.stringComparator('user', false) as ComparatorFn,
        'created': Comparators.dateComparator('created', true) as ComparatorFn,
        '-created': Comparators.dateComparator('created', false) as ComparatorFn,
        'updated': Comparators.dateComparator('updated', true) as ComparatorFn,
        '-updated': Comparators.dateComparator('updated', false) as ComparatorFn,
        '-attachments': (x: unknown, y: unknown): number => {
            return this.attachmentSortVal(x as AttachmentEntry).localeCompare(
                this.attachmentSortVal(y as AttachmentEntry)
            );
        },
        '-rank': Comparators.rankComparator().bind(this) as ComparatorFn
    };

    defaultComparator = 'title';

    entryFilter: unknown = null;

    constructor(models?: unknown[], options?: { comparator?: string }) {
        super(models);
        const comparatorName: string = (options?.comparator) || this.defaultComparator;
        this.comparator = this.comparators[comparatorName];
    }

    sortEntries(comparator: string, filter: unknown): void {
        this.entryFilter = filter;
        this.comparator = this.comparators[comparator] || this.comparators[this.defaultComparator];
        this.sort();
    }

    attachmentSortVal(entry: AttachmentEntry): string {
        const att = entry.attachments;
        let str: string = att.length ? String.fromCharCode(64 + att.length) : 'Z';
        if (att[0]) {
            str += att[0].title ?? '';
        }
        return str;
    }
}

export { SearchResultCollection };
