import base from '../../vault/src/locales/base.json';
import german from '../../vault/src/locales/de-DE.json';
import french from '../../vault/src/locales/fr-FR.json';
import newGerman from './locales/de-DE.json';
import newFrench from './locales/fr-FR.json';
export type UiLocale = 'en-US' | 'de-DE' | 'fr-FR';
export function resolveUiLocale(value: string | null | undefined, browser: readonly string[]): UiLocale {
    const preferred = value ? [value] : browser;
    for (const language of preferred) {
        if (/^de(?:-|$)/i.test(language)) return 'de-DE';
        if (/^fr(?:-|$)/i.test(language)) return 'fr-FR';
        if (/^en(?:-|$)/i.test(language)) return 'en-US';
    }
    return 'en-US';
}
function byText(dictionary: Record<string, unknown>): Record<string, string> {
    const translated: Record<string, string> = Object.create(null);
    for (const [key, text] of Object.entries(base)) if (typeof text === 'string' && typeof dictionary[key] === 'string') translated[text] = dictionary[key] as string;
    return translated;
}
export const uiDictionaries: Record<UiLocale, Readonly<Record<string, string>>> = {
    'en-US': {}, 'de-DE': { ...byText(german), ...newGerman }, 'fr-FR': { ...byText(french), ...newFrench }
};

/** Values are inserted once, literally; dollar patterns and braces stay data. */
export function interpolate(text: string, values: readonly string[]): string {
    let index = 0;
    return text.replace(/\{\}/g, () => index < values.length ? values[index++] : '{}');
}
