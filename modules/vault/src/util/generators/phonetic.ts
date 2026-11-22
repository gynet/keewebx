/*
 * Phonetic
 * Copyright 2013 Tom Frost
 */

interface PhoneticOptions {
    length?: number;
    phoneticSimplicity?: number;
    compoundSimplicity?: number;
}

interface ResolvedOptions {
    length: number;
    phoneticSimplicity: number;
    compoundSimplicity: number;
}

interface WordObj {
    word: string;
    lastSkippedPre: boolean;
    lastSkippedPost: boolean;
    opts: ResolvedOptions;
}

/**
 * Phonetics that sound best before a vowel.
 */
const PHONETIC_PRE: readonly string[] = [
    // Simple phonetics
    'b',
    'c',
    'd',
    'f',
    'g',
    'h',
    'j',
    'k',
    'l',
    'm',
    'n',
    'p',
    'qu',
    'r',
    's',
    't',
    // Complex phonetics
    'bl',
    'ch',
    'cl',
    'cr',
    'dr',
    'fl',
    'fr',
    'gl',
    'gr',
    'kl',
    'kr',
    'ph',
    'pr',
    'pl',
    'sc',
    'sh',
    'sl',
    'sn',
    'sr',
    'st',
    'str',
    'sw',
    'th',
    'tr',
    'br',
    'v',
    'w',
    'y',
    'z'
];

/**
 * The number of simple phonetics within the 'pre' set.
 */
const PHONETIC_PRE_SIMPLE_LENGTH = 16;

/**
 * Vowel sound phonetics.
 */
const PHONETIC_MID: readonly string[] = [
    // Simple phonetics
    'a',
    'e',
    'i',
    'o',
    'u',
    // Complex phonetics
    'ee',
    'ie',
    'oo',
    'ou',
    'ue'
];

/**
 * The number of simple phonetics within the 'mid' set.
 */
const PHONETIC_MID_SIMPLE_LENGTH = 5;

/**
 * Phonetics that sound best after a vowel.
 */
const PHONETIC_POST: readonly string[] = [
    // Simple phonetics
    'b',
    'd',
    'f',
    'g',
    'k',
    'l',
    'm',
    'n',
    'p',
    'r',
    's',
    't',
    'y',
    // Complex phonetics
    'ch',
    'ck',
    'ln',
    'nk',
    'ng',
    'rn',
    'sh',
    'sk',
    'st',
    'th',
    'x',
    'z'
];

/**
 * The number of simple phonetics within the 'post' set.
 */
const PHONETIC_POST_SIMPLE_LENGTH = 13;

/**
 * A mapping of regular expressions to replacements, which will be run on the
 * resulting word before it gets returned.  The purpose of replacements is to
 * address language subtleties that the phonetic builder is incapable of
 * understanding, such as 've' more pronounceable than just 'v' at the end of
 * a word, 'ey' more pronounceable than 'iy', etc.
 */
const REPLACEMENTS: Record<string, string> = {
    'quu': 'que',
    'qu([aeiou]){2}': 'qu$1',
    '[iu]y': 'ey',
    'eye': 'ye',
    '(.)ye$': '$1y',
    '(^|e)cie(?!$)': '$1cei',
    '([vz])$': '$1e',
    '[iu]w': 'ow'
};

/**
 * Adds a single syllable to the word contained in the wordObj.
 */
function addSyllable(wordObj: WordObj): void {
    const compound = randomBelow(wordObj.opts.compoundSimplicity) === 0;
    const first = wordObj.word === '';
    const preOnFirst = first && randomBelow(6) > 0;
    if ((first && preOnFirst) || wordObj.lastSkippedPost || compound) {
        wordObj.word += getNextPhonetic(PHONETIC_PRE, PHONETIC_PRE_SIMPLE_LENGTH, wordObj);
        wordObj.lastSkippedPre = false;
    } else {
        wordObj.lastSkippedPre = true;
    }
    wordObj.word += getNextPhonetic(
        PHONETIC_MID,
        PHONETIC_MID_SIMPLE_LENGTH,
        wordObj,
        first && wordObj.lastSkippedPre
    );
    if (wordObj.lastSkippedPre || compound) {
        wordObj.word += getNextPhonetic(PHONETIC_POST, PHONETIC_POST_SIMPLE_LENGTH, wordObj);
        wordObj.lastSkippedPost = false;
    } else {
        wordObj.lastSkippedPost = true;
    }
}

/** Draw a uniform index by rejecting the tail of the 32-bit range. */
export function randomBelow(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2 ** 32) {
        throw new RangeError('Invalid random index limit');
    }
    const bound = 2 ** 32 - (2 ** 32 % limit);
    const sample = new Uint32Array(1);
    do {
        crypto.getRandomValues(sample);
    } while (sample[0] >= bound);
    return sample[0] % limit;
}

function getOptions(options: PhoneticOptions): ResolvedOptions {
    return {
        length: options.length ?? 16,
        phoneticSimplicity: Math.max(1, Math.trunc(options.phoneticSimplicity ?? 5)),
        compoundSimplicity: Math.max(1, Math.trunc(options.compoundSimplicity ?? 5))
    };
}

/** Draw a new independent phonetic for each component of the syllable. */
function getNextPhonetic(
    phoneticSet: readonly string[],
    simpleCap: number,
    wordObj: WordObj,
    forceSimple?: boolean
): string {
    const simple = forceSimple || randomBelow(wordObj.opts.phoneticSimplicity) > 0;
    return phoneticSet[randomBelow(simple ? simpleCap : phoneticSet.length)];
}

/**
 * Applies post-processing to a word after it has already been generated.
 */
function postProcess(wordObj: WordObj): string {
    for (const pattern in REPLACEMENTS) {
        if (Object.prototype.hasOwnProperty.call(REPLACEMENTS, pattern)) {
            const regex = new RegExp(pattern);
            wordObj.word = wordObj.word.replace(regex, REPLACEMENTS[pattern]);
        }
    }
    return wordObj.word;
}

/**
 * Generates a new word based on the given options.
 */
function generate(options: PhoneticOptions = {}): string {
    const resolved = getOptions(options);
    const length = Math.trunc(resolved.length);
    if (!Number.isFinite(length) || length <= 0) return '';
    const wordObj: WordObj = {
        lastSkippedPost: false,
        lastSkippedPre: false,
        word: '',
        opts: resolved
    };
    const safeMaxLength = length + 5;
    while (wordObj.word.length < safeMaxLength) {
        addSyllable(wordObj);
    }
    return postProcess(wordObj).substr(0, length);
}

const phonetic = { generate };

export { phonetic };
