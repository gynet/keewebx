import { StorageCache } from 'storage/impl/storage-cache';
import { StorageWebDav } from 'storage/impl/storage-webdav';
import { getRegisteredStorages } from 'hooks/data-registry';
import { isLocalHtml } from 'comp/browser/local-html';

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
        if (isLocalHtml() && name !== 'cache') (Storage[name] as { enabled: boolean }).enabled = false;
    }
}

export { Storage, applyRegisteredStorages };
