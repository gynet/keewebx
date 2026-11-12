declare const __KW_STORAGE_NAMESPACE__: string;

export function getStorageNamespace(): string {
    return typeof __KW_STORAGE_NAMESPACE__ === 'undefined' ? '' : __KW_STORAGE_NAMESPACE__;
}

export function storageKey(key: string): string {
    const namespace = getStorageNamespace();
    return namespace ? `${namespace}:${key}` : key;
}
