export interface SafeLog { level: 'debug' | 'info' | 'warn' | 'error'; time: string; source: string; message: string }
const sources = new Set(['app', 'file', 'sync', 'open', 'storage-cache', 'storage-webdav', 'browser-extension-connector', 'argon2', 'settings-manager', 'service-worker']);
const messages: readonly [RegExp, string][] = [
    [/^Sync started(?: |$)/, 'Synchronization started'], [/^Sync finished(?: |$)/, 'Synchronization finished'],
    [/^Sync error(?: |$)/, 'Synchronization failed'], [/^Saved to cache(?: |$)/, 'Encrypted cache write finished'],
    [/^Local, save to cache$/, 'Saving to encrypted browser storage'], [/^File open request$/, 'Vault unlock requested'],
    [/^Open file from supplied content$/, 'Opening supplied vault'], [/^Opened file(?: |$)/, 'Vault opened'],
    [/^Hash computed(?: |$)/, 'Key derivation finished'], [/^Started$/, 'Service started'],
    [/^New client key created(?: |$)/, 'Extension connection established']
];
/** Logs can contain arbitrary entry values, URLs, tokens and object getters.
 * Summarize only known operation prefixes; never inspect or stringify arguments. */
export function safeLogs(entries: readonly { level: string; args: unknown[] }[]): SafeLog[] {
    return entries.slice(-100).map(entry => {
        const first = typeof entry.args[0] === 'string' ? entry.args[0] : '';
        const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) \[([^\]]+)\] ([\s\S]*)$/.exec(first);
        const source = match?.[2].split(':')[0] ?? '';
        const message = messages.find(([pattern]) => pattern.test(match?.[3] ?? ''))?.[1];
        return { level: ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level as SafeLog['level'] : 'info',
            time: match?.[1] ?? '', source: sources.has(source) ? source : 'Application',
            message: message ?? 'Event details omitted for privacy' };
    });
}
export function diagnosticsText(info: { version: string; buildDate: string; commit: string }, userAgent: string): string {
    const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500);
    return [`KeeWebX ${clean(info.version)}`, `Build: ${clean(info.buildDate)}`,
        `Commit: ${clean(info.commit) || 'unavailable'}`, 'Environment: web', `Browser: ${clean(userAgent)}`].join('\n');
}
