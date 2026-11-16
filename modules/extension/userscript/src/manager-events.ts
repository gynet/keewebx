declare const GM: { info?: { scriptHandler?: string; script?: { filename?: string } } };

type StorageListener = (changes: Record<string, unknown>, area: string) => void;
type StorageEvents = { addListener(listener: StorageListener): void; removeListener(listener: StorageListener): void };

/** Userscripts injects content code in its extension world. Notifications only
 * wake the existing GM reader; no event payload is trusted or read here. */
export function watchManagerStorage(keys: string[], changed: () => void, prefix = false): () => void {
    const filename = GM.info?.script?.filename;
    if (GM.info?.scriptHandler !== 'Userscripts' || !filename) return () => {};
    const environment = globalThis as typeof globalThis & {
        browser?: { storage?: { onChanged?: StorageEvents } };
        chrome?: { storage?: { onChanged?: StorageEvents } };
    };
    const events = environment.browser?.storage?.onChanged ?? environment.chrome?.storage?.onChanged;
    if (!events?.addListener || !events.removeListener) return () => {};
    // Match the manager's per-filename namespace, never another script's keys.
    const names = keys.map(key => `${filename}---${key}`);
    const listener: StorageListener = (changes, area) => {
        if (area === 'local' && Object.keys(changes).some(key => names.some(name => prefix ? key.startsWith(name) : key === name))) changed();
    };
    try { events.addListener(listener); } catch { return () => {}; }
    return () => { try { events.removeListener(listener); } catch {} };
}
