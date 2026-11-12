import { IoBrowserCache, type CacheCallback } from 'storage/io-browser-cache';
import { StorageBase } from 'storage/storage-base';

class StorageCache extends StorageBase {
    name = 'cache';
    enabled = IoBrowserCache.enabled;
    system = true;

    io: IoBrowserCache | null = null;

    init(): this {
        super.init();
        this.io = new IoBrowserCache({
            cacheName: 'FilesCache',
            logger: this.logger!
        });
        return this;
    }

    save(id: string, opts: unknown, data: unknown, callback?: CacheCallback): void {
        this.io!.save(id, data, callback);
    }

    load(id: string, opts: unknown, callback?: CacheCallback): void {
        this.io!.load(id, callback);
    }

    remove(id: string, opts?: unknown, callback?: CacheCallback): void {
        this.io!.remove(id, callback);
    }
}

export { StorageCache };
