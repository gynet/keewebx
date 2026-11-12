/**
 * Interface text. Strings are written in English at the call site and
 * looked up here, so a translation is a map from the English text. `{}`
 * marks a value to fill in.
 */
let translations: Record<string, string> = {};

export function setTranslations(map: Record<string, string>): void {
    translations = map;
}

export function t(text: string, ...values: string[]): string {
    let out = translations[text] ?? text;
    for (const v of values) {
        out = out.replace('{}', v);
    }
    return out;
}
