declare const __KW_STORAGE_NAMESPACE__: string;

export function storageKey(key: string): string {
    const namespace = typeof __KW_STORAGE_NAMESPACE__ === 'undefined' ? '' : __KW_STORAGE_NAMESPACE__;
    return namespace ? `${namespace}:${key}` : key;
}
