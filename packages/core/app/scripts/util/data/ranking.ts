// `Searchable` describes the small surface this module reads from
// either a plain string or a kdbxweb.ProtectedValue (with the
// extension methods declared in app/scripts/kdbxweb.d.ts).
// Both `length` and the index methods are optional because:
//   - kdbxweb.ProtectedValue exposes textLength but not raw `length`
//     until the protected-value-ex prototype patch lands.
//   - Plain strings expose `indexOf` but not `indexOfLower`.
//   - Field values arrive here as `string | ProtectedValue` from
//     entry-model and we narrow inside `indexOf` below.
interface Searchable {
    isProtected?: boolean;
    length?: number;
    indexOf?(s: unknown): number;
    indexOfLower?(s: unknown): number;
    indexOfSelfInLower?(s: unknown): number;
}

type SearchTerm = Searchable | string;

const Ranking = {
    getStringRank(s1: SearchTerm, s2: SearchTerm): number {
        if (!s1 || !s2) {
            return 0;
        }
        let ix = indexOf(s1, s2);
        if (ix === 0 && getLength(s1) === getLength(s2)) {
            return 10;
        } else if (ix === 0) {
            return 5;
        } else if (ix > 0) {
            return 3;
        }
        ix = indexOf(s2, s1);
        if (ix === 0) {
            return 5;
        } else if (ix > 0) {
            return 3;
        }
        return 0;
    }
};

function getLength(s: SearchTerm): number | undefined {
    return typeof s === 'string' ? s.length : s.length;
}

function indexOf(target: SearchTerm, search: SearchTerm): number {
    // ProtectedValue carries the `isProtected: true` discriminator;
    // plain strings do not. Type-narrow via the flag, then call the
    // appropriate primitive (kdbxweb.ProtectedValue's prototype-patched
    // `indexOfLower` / `indexOfSelfInLower` from protected-value-ex,
    // or String.prototype.indexOf for raw strings).
    if (typeof target !== 'string' && target.isProtected && target.indexOfLower) {
        return target.indexOfLower(search);
    }
    if (typeof search !== 'string' && search.isProtected && search.indexOfSelfInLower) {
        return search.indexOfSelfInLower(target);
    }
    if (typeof target === 'string') {
        return target.indexOf(typeof search === 'string' ? search : String(search));
    }
    // Should not happen at runtime — both branches above are taken
    // for the only two real types (string + ProtectedValue). Mirror
    // the original code path which called `target.indexOf(search)`.
    return target.indexOf ? target.indexOf(search) : -1;
}

// Expose Ranking on the global window for ad-hoc debugging via the
// browser console (legacy KeeWeb behaviour, not used in production).
interface WindowWithRanking {
    Ranking?: typeof Ranking;
}
(window as Window & WindowWithRanking).Ranking = Ranking;

export { Ranking };
