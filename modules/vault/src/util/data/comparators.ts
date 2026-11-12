// Comparator items are model-like records keyed by string field name.
// We use `Record<string, unknown>` and narrow inside each compare body
// rather than `any` so the comparisons are type-checked.
type Item = Record<string, unknown>;

// Item that knows how to compute its own search rank against the
// active filter. Used by rankComparator to sort search results.
interface RankableItem {
    getRank(filter: unknown): number;
}

const LastChar: string = String.fromCharCode(0xfffd);

const hasCollator: boolean = !!(window.Intl && window.Intl.Collator) && !/Edge/.test(navigator.userAgent); // bugged in Edge: #808
const ciCompare: (x: string, y: string) => number = hasCollator
    ? new Intl.Collator(undefined, { sensitivity: 'base' }).compare
    : (x: string, y: string) => x.toLocaleLowerCase().localeCompare(y.toLocaleLowerCase());

function asStringOrFallback(value: unknown, fallback: string): string {
    // Match the original behaviour: any falsy value (null, undefined,
    // 0, '', false, NaN) substitutes the fallback. Truthy values are
    // coerced to string by Intl.Collator's runtime conversion, which
    // we mirror with String() here.
    if (!value) {
        return fallback;
    }
    return typeof value === 'string' ? value : String(value);
}

function asStringRaw(value: unknown): string {
    // The pre-fix descending branch passed `y[field]` straight into
    // Intl.Collator.compare, which coerces null/undefined to "null"/
    // "undefined". Mirror that exactly so this refactor stays
    // behaviour-preserving — see feedback_tests_must_not_lock_bugs.
    return String(value);
}

function asNumber(value: unknown): number {
    if (typeof value === 'number') {
        return value;
    }
    if (value instanceof Date) {
        return value.getTime();
    }
    return Number(value);
}

const Comparators = {
    stringComparator(field: string, asc: boolean): (x: Item, y: Item) => number {
        if (asc) {
            return function (x: Item, y: Item): number {
                return ciCompare(
                    asStringOrFallback(x[field], LastChar),
                    asStringOrFallback(y[field], LastChar)
                );
            };
        } else {
            return function (x: Item, y: Item): number {
                return ciCompare(asStringRaw(y[field]), asStringRaw(x[field]));
            };
        }
    },

    rankComparator(): (this: { filter: unknown }, x: RankableItem, y: RankableItem) => number {
        return function (this: { filter: unknown }, x: RankableItem, y: RankableItem): number {
            return y.getRank(this.filter) - x.getRank(this.filter);
        };
    },

    dateComparator(field: string, asc: boolean): (x: Item, y: Item) => number {
        if (asc) {
            return function (x: Item, y: Item): number {
                return asNumber(x[field]) - asNumber(y[field]);
            };
        } else {
            return function (x: Item, y: Item): number {
                return asNumber(y[field]) - asNumber(x[field]);
            };
        }
    }
};

export { Comparators };
