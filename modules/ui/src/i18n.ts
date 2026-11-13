/** English call-site strings are stable translation keys. Vault values are never translated. */
import { AppSettingsModel } from 'models/app-settings-model';
import { resolveUiLocale, uiDictionaries, interpolate } from './locale-data';
let overrides: Record<string, string> = {};
export function setTranslations(map: Record<string, string>): void { overrides = map; }
export function currentLocale() {
    return resolveUiLocale(AppSettingsModel.locale, typeof navigator === 'undefined' ? ['en-US'] : navigator.languages);
}
export function t(text: string, ...values: string[]): string {
    const dictionary = uiDictionaries[currentLocale()];
    const out = Object.prototype.hasOwnProperty.call(overrides, text) ? overrides[text]
        : Object.prototype.hasOwnProperty.call(dictionary, text) ? dictionary[text] : text;
    return interpolate(out, values);
}
