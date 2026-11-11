/**
 * SettingsStore — persists small JSON blobs (fileInfos, appSettings,
 * runtimeData, updateInfo) to `window.localStorage`.
 *
 * History: this file was stubbed in commit `a436c401` when the Electron
 * `Launcher` module was stripped, because the previous implementation
 * branched on `Launcher.loadConfig` / `Launcher.saveConfig` (desktop) vs
 * `localStorage` (web). Stubbing the whole module silently destroyed all
 * metadata persistence: recent files list, theme, language, per-extension
 * client permissions, update check cache. This restores the web-only
 * implementation from upstream KeeWeb (commit 2cafd5a9), adapted for
 * TypeScript strict mode and simplified to web-only (no Launcher).
 *
 * Keys are camelCased to match upstream's on-disk layout, so a user who
 * previously loaded a pre-regression build will see their stored state
 * seamlessly (e.g. `save('file-info', ...)` -> `localStorage.fileInfo`).
 */

import { StringFormat } from 'util/formatting/string-format';
import { Logger } from 'util/logger';

const logger = new Logger('settings-store');

function getStorage(): Storage | null {
    try {
        if (typeof localStorage !== 'undefined') {
            return localStorage;
        }
    } catch (err) {
        // Accessing localStorage can throw in some sandboxed contexts
        // (e.g. cross-origin iframe, Safari private mode on old builds).
        // Log once and degrade to an in-memory no-op.
        logger.error('localStorage unavailable', err);
    }
    return null;
}

const SettingsStore = {
    /**
     * Load a previously-saved blob for `key`. Returns the parsed JSON
     * value, or `null` if nothing was stored (or the stored value is
     * unparsable — a corrupted entry must NOT crash the app).
     */
    async load(key: string): Promise<unknown> {
        try {
            const storage = getStorage();
            if (!storage) {
                return null;
            }
            const raw = storage[StringFormat.camelCase(key)];
            if (raw == null || raw === '') {
                return null;
            }
            return JSON.parse(raw);
        } catch (err) {
            logger.error(`Error loading ${key}`, err);
            return null;
        }
    },

    /**
     * Serialize `data` as JSON and store it under `key`. Errors are
     * logged but never thrown — persistence failure must not take down
     * the caller (upstream behavior, critical for the `change`-event
     * driven auto-save path in AppSettingsModel / RuntimeDataModel).
     */
    async save(key: string, data: unknown): Promise<void> {
        try {
            const storage = getStorage();
            if (!storage) {
                return;
            }
            storage[StringFormat.camelCase(key)] = JSON.stringify(data);
        } catch (err) {
            logger.error(`Error saving ${key}`, err);
        }
    }
};

export { SettingsStore };
