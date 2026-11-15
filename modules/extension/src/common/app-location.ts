/** Public app route; the origin root serves the marketing site. */
export const HOSTED_APP_URL = 'https://keewebx.app/app';

declare const __KW_EMBEDDED_VAULT__: boolean | undefined;

export function defaultAppUrl(): string {
    return typeof __KW_EMBEDDED_VAULT__ !== 'undefined' && __KW_EMBEDDED_VAULT__
        ? chrome.runtime.getURL('app/index.html') : HOSTED_APP_URL;
}

/** Only the exact former default is migrated; explicit routes/selectors stay intact. */
export function migrateAppUrl(value: string | undefined): string | undefined {
    return value === 'https://keewebx.app/' ? HOSTED_APP_URL : value;
}
