import { StorageCache } from 'storage/impl/storage-cache';
import { StorageWebDav } from 'storage/impl/storage-webdav';
import { getRegisteredStorages } from 'hooks/data-registry';

const Storage: Record<string, unknown> & {
    cache: StorageCache;
    webdav: StorageWebDav;
} = {
    cache: new StorageCache(),
    webdav: new StorageWebDav()
};

function applyRegisteredStorages(): void {
    for (const [name, factory] of getRegisteredStorages()) {
        Storage[name] = factory();
    }
}

export { Storage, applyRegisteredStorages };
