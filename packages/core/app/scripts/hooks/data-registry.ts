const settings = new Map<string, unknown>();
const fileInfoFields = new Map<string, unknown>();
const storageFactories = new Map<string, () => unknown>();

export function registerDefaultSetting(key: string, value: unknown): void {
    settings.set(key, value);
}

export function registerFileInfoField(name: string, defaultValue: unknown): void {
    fileInfoFields.set(name, defaultValue);
}

export function registerStorage(name: string, factory: () => unknown): void {
    storageFactories.set(name, factory);
}

export function getRegisteredSettings(): ReadonlyMap<string, unknown> {
    return settings;
}

export function getRegisteredFileInfoFields(): ReadonlyMap<string, unknown> {
    return fileInfoFields;
}

export function getRegisteredStorages(): ReadonlyMap<string, () => unknown> {
    return storageFactories;
}
