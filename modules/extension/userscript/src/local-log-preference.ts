declare const GM: { getValue(key: string): Promise<unknown>; setValue(key: string, value: unknown): Promise<void> };

// Manager-private and independent of autofill preferences. Never store log entries.
const KEY = 'keewebx-userscript-local-log-enabled-v1';
let writes = Promise.resolve();

export const localLogPreference = {
    async load(): Promise<boolean> {
        try {
            await writes;
            return await GM.getValue(KEY) === true;
        } catch { return false; }
    },
    save(enabled: boolean): Promise<void> {
        // Serialize rapid toggles so an older write cannot finish last.
        writes = writes.then(async () => {
            try { await GM.setValue(KEY, enabled); }
            catch { /* Optional logging storage must never interrupt Connect. */ }
        });
        return writes;
    }
};
