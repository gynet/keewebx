import { defaultConnectPreferences, parseConnectPreferences, type ConnectPreferenceStore } from '../../src/common/connect-preferences';
import { managerCall } from './native-connect';

declare const GM: { getValue(key: string): Promise<unknown>; setValue(key: string, value: unknown): Promise<void> };
const KEY = 'keewebx-userscript-connect-preferences-v1';

/** GM is a host adapter. Components and preference types know nothing about it. */
export const userscriptPreferences: ConnectPreferenceStore = {
    async load() {
        const stored = await managerCall(() => GM.getValue(KEY), 'Connect preferences');
        return parseConnectPreferences(stored ?? defaultConnectPreferences);
    },
    async save(preferences) {
        await managerCall(() => GM.setValue(KEY, parseConnectPreferences(preferences)), 'Saving Connect preferences');
    }
};
