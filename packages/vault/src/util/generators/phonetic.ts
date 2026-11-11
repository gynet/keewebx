/*
 * Phonetic
 * Copyright 2013 Tom Frost
 */

// removed node.js deps, making it available to load in browser

interface PhoneticOptions {
    length?: number;
    seed?: string | number;
    phoneticSimplicity?: number;
    compoundSimplicity?: number;
}

interface ResolvedOptions {
    length: number;
    seed: string | number;
    phoneticSimplicity: number;
    compoundSimplicity: number;
}

interface WordObj {
    word: string;
    numeric: number;
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
    const deriv = getDerivative(wordObj.numeric);
    const compound = deriv % wordObj.opts.compoundSimplicity === 0;
    const first = wordObj.word === '';
    const preOnFirst = deriv % 6 > 0;
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

/**
 * Gets a derivative of a number by repeatedly dividing it by 7 and adding the
 * remainders together.
 */
function getDerivative(num: number): number {
    let derivative = 1;
    while (num) {
        derivative += num % 7;
        num = Math.floor(num / 7);
    }
    return derivative;
}

/**
 * Combines the option defaults with the provided overrides.
 */
function getOptions(overrides?: PhoneticOptions): ResolvedOptions {
    overrides = overrides || {};
    const options: ResolvedOptions = {
        length: overrides.length || 16,
        seed: overrides.seed || Math.random(),
        phoneticSimplicity: overrides.phoneticSimplicity
            ? Math.max(overrides.phoneticSimplicity, 1)
            : 5,
        compoundSimplicity: overrides.compoundSimplicity
            ? Math.max(overrides.compoundSimplicity, 1)
            : 5
    };
    return options;
}

/**
 * Gets the next pseudo-random phonetic from a given phonetic set.
 */
function getNextPhonetic(
    phoneticSet: readonly string[],
    simpleCap: number,
    wordObj: WordObj,
    forceSimple?: boolean
): string {
    const deriv = getDerivative(wordObj.numeric);
    const simple = (wordObj.numeric + deriv) % wordObj.opts.phoneticSimplicity > 0;
    const cap = simple || forceSimple ? simpleCap : phoneticSet.length;
    const phonetic = phoneticSet[wordObj.numeric % cap];
    wordObj.numeric = getNumericHash(wordObj.numeric + wordObj.word);
    return phonetic;
}

/**
 * Generates a numeric hash based on the input data.
 */
function getNumericHash(data: string | number): number {
    let numeric = 0;
    const str = data + '-Phonetic';
    for (let i = 0, len = str.length; i < len; i++) {
        const chr = str.charCodeAt(i);
        numeric = (numeric << 5) - numeric + chr;
        numeric >>>= 0;
    }
    return numeric;
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
function generate(options?: PhoneticOptions): string {
    const resolved = getOptions(options);
    const length = resolved.length;
    const wordObj: WordObj = {
        numeric: getNumericHash(resolved.seed),
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
