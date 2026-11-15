import { t } from './i18n';

/** Browsers intentionally cannot distinguish CORS, TLS and network failures. */
export function webDavError(message: string): string {
    if (/HTTP status 401\b/i.test(message)) return t('WebDAV sign-in failed. Check your username and password, then edit the connection and retry.');
    if (/HTTP status 403\b/i.test(message)) return t('The WebDAV server denied access. Check this account’s permission for the file.');
    if (/HTTP status 404\b|Not found/i.test(message)) return t('The WebDAV file was not found. Check its address and edit the connection to retry.');
    if (/HTTP status 5\d\d\b/i.test(message)) return t('The WebDAV server is unavailable. Retry later; your cached copies are retained.');
    if (/FileCorrupt|InvalidSig|InvalidVersion|Unsupported|RangeError/i.test(message)) return t('This WebDAV file is not a supported or readable KDBX database. Check the file address or choose another file.');
    return t('Could not reach or read the WebDAV file. Check the network, HTTPS certificate and server CORS settings, then retry or edit the connection. Your cached copies are retained.');
}
