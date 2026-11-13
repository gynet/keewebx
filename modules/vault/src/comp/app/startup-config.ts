import type { AppModel } from 'models/app-model';
import { DefaultAppSettings } from 'const/default-app-settings';

export function validateStartupConfig(value: unknown): Parameters<AppModel['applyUserConfig']>[0] {
    const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
    if (!object(value) || !object(value.settings)) throw new Error('Invalid startup configuration.');
    for (const [key, setting] of Object.entries(value.settings)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor'
            || (typeof DefaultAppSettings[key] === 'boolean' && typeof setting !== 'boolean')) throw new Error('Invalid startup setting.');
    }
    if (value.files !== undefined && (!Array.isArray(value.files) || !value.files.every(file => object(file)
        && typeof file.storage === 'string' && !!file.storage && typeof file.name === 'string' && !!file.name
        && typeof file.path === 'string' && !!file.path && (file.options === undefined || object(file.options))))) {
        throw new Error('Invalid configured database list.');
    }
    if (value.showOnlyFilesFromConfig !== undefined && typeof value.showOnlyFilesFromConfig !== 'boolean') throw new Error('Invalid configured database list.');
    if (value.advancedSearch !== undefined && (!object(value.advancedSearch)
        || Object.values(value.advancedSearch).some(flag => typeof flag !== 'boolean'))) throw new Error('Invalid configured search options.');
    return value as Parameters<AppModel['applyUserConfig']>[0];
}

/** Load the same self-hosted configuration used by Classic before exposing UI. */
export async function loadStartupConfig(model: AppModel): Promise<void> {
    const embedded = document.querySelector<HTMLMetaElement>('meta[name=kw-config]')?.content;
    const configured = embedded && !embedded.startsWith('(') ? embedded : new URLSearchParams(location.search).get('config');
    if (!configured) return;
    const url = new URL(configured, location.href);
    if (!/^https?:$/.test(url.protocol) || url.origin !== location.origin || url.username || url.password || url.hash) {
        throw new Error('The startup configuration address is not allowed.');
    }
    model.ensureCanLoadConfig(url.href);
    const allowCached = model.settings.cacheConfigSettings;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let config: Parameters<AppModel['applyUserConfig']>[0];
    try {
        const response = await fetch(url.href, { credentials: 'same-origin', redirect: 'error', signal: controller.signal });
        if (!response.ok) throw new Error('Configuration request failed');
        config = validateStartupConfig(await response.json());
    } catch {
        if (!allowCached) throw new Error('The startup configuration could not be loaded.');
        return;
    } finally { clearTimeout(timeout); }
    model.applyUserConfig(config);
}
