export const DEFAULT_ENDPOINT = 'https://keewebx.app/app';
export const WINDOW_NAME = 'KeeWebXUserscriptConnect';
declare const GM: { getValue(key: string): Promise<any>; setValue(key: string, value: any): Promise<void> };
const KEY = 'keewebx-userscript-connect-settings-v1';
export function endpoint(value: string): URL {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Enter a valid HTTPS address for KeeWebX.');
    url.hash = '';
    return url;
}
export async function loadEndpoint(): Promise<URL> {
    const stored = await GM.getValue(KEY);
    return endpoint(typeof stored?.endpoint === 'string' ? stored.endpoint : DEFAULT_ENDPOINT);
}
export async function saveEndpoint(value: string): Promise<URL> {
    const url = endpoint(value);
    await GM.setValue(KEY, { endpoint: url.href });
    return url;
}

/** Call synchronously in a trusted tap. Navigate only a newly created blank window. */
export function findOrOpenApp(url: URL, known?: Window): Window {
    if (known && !known.closed) { known.focus(); return known; }
    const target = window.open('', WINDOW_NAME);
    if (!target) throw new Error('Safari blocked the window. Allow pop-ups and try again.');
    try {
        if (target.location.href === 'about:blank') {
            const setup = new URL('connect.html', url);
            setup.searchParams.set('kwx-connect-relay', '1');
            target.location.href = setup.href;
        }
    } catch {
        // Cross-origin access failing means an existing named app was found.
        // Preserve that document and its in-memory unlock state.
    }
    target.focus();
    return target;
}
