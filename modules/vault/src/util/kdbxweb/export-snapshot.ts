import {
    Kdbx, Credentials, KdbxHeader, KdbxMeta, KdbxGroup, KdbxEntry, KdbxTimes,
    KdbxUuid, KdbxBinaries, KdbxDeletedObject, ProtectedValue, VarDictionary, Int64
} from 'kdbxweb';

const dataPrototypes = new Set([
    Object.prototype, null, Kdbx.prototype, Credentials.prototype, KdbxHeader.prototype,
    KdbxMeta.prototype, KdbxGroup.prototype, KdbxEntry.prototype, KdbxTimes.prototype,
    KdbxUuid.prototype, KdbxBinaries.prototype, KdbxDeletedObject.prototype,
    ProtectedValue.prototype, VarDictionary.prototype, Int64.prototype
]);

/**
 * Copy the KDBX data graph synchronously after credential hashing has settled.
 * A serializer owns its header, salts, XML, binaries and protected-value buffers.
 * Neither exporting nor a concurrent live save may mutate the other's graph.
 * This is deliberately limited to the data types in our KDBX implementation;
 * an unfamiliar type fails closed instead of silently sharing mutable state.
 */
export function createExportSnapshot(db: Kdbx): Kdbx {
    const copies = new Map<object, unknown>();
    copies.set(db.credentials.ready, Promise.resolve());
    const copy = (value: unknown): unknown => {
        if (!value || typeof value !== 'object') return value;
        if (copies.has(value)) return copies.get(value);
        let result: unknown;
        if (value instanceof ArrayBuffer) {
            result = value.slice(0);
        } else if (value instanceof Uint8Array) {
            result = new Uint8Array(copy(value.buffer) as ArrayBuffer, value.byteOffset, value.length);
        } else if (value instanceof Date) {
            result = new Date(value.getTime());
        } else if (value instanceof Map) {
            const map = new Map();
            copies.set(value, map);
            for (const [key, item] of value) map.set(copy(key), copy(item));
            return map;
        } else if (Array.isArray(value)) {
            const array: unknown[] = [];
            copies.set(value, array);
            for (const item of value) array.push(copy(item));
            return array;
        } else {
            const prototype = Object.getPrototypeOf(value);
            if (!dataPrototypes.has(prototype)) throw new Error('Unsupported database value in export.');
            result = Object.create(prototype);
            copies.set(value, result);
            for (const key of Object.keys(value)) {
                // XML is transient serializer state, rebuilt from the copied data.
                if (value === db && key === 'xml') continue;
                Object.defineProperty(result, key, {
                    value: copy((value as Record<string, unknown>)[key]),
                    writable: true, enumerable: true, configurable: true
                });
            }
            return result;
        }
        copies.set(value, result);
        return result;
    };
    return copy(db) as Kdbx;
}
