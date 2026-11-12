/**
 * Every piece of UI text goes through here. Strings live in
 * _locales/<locale>/messages.json under "ui…" keys; English is the default
 * locale, so a missing translation falls back to it. tests/ui-messages.test.ts
 * checks that each key used in the source exists.
 */
export function t(key: string, ...substitutions: string[]): string {
    return chrome.i18n.getMessage(key, substitutions) || key;
}
