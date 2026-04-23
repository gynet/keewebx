import { Logger } from 'util/logger';

const idb: IDBFactory | undefined =
    typeof window !== 'undefined'
        ? (window as unknown as Record<string, IDBFactory | undefined>).indexedDB ||
          (window as unknown as Record<string, IDBFactory | undefined>).mozIndexedDB ||
          (window as unknown as Record<string, IDBFactory | undefined>).webkitIndexedDB ||
          (window as unknown as Record<string, IDBFactory | undefined>).msIndexedDB
        : undefined;

interface IoBrowserCacheConfig {
    cacheName: string;
    logger: Logger;
}

type CacheCallback = (err?: unknown, data?: unknown) => void;

class IoBrowserCache {
    db: IDBDatabase | null = null;
    cacheName: string;
    logger: Logger;

    static readonly enabled: boolean = !!idb;

    constructor(config: IoBrowserCacheConfig) {
        this.cacheName = config.cacheName;
        this.logger = config.logger;
    }

    initDb(callback?: CacheCallback): void {
        if (this.db) {
            return callback?.();
        }
        try {
            const req = idb!.open(this.cacheName);
            req.onerror = (e) => {
                this.logger.error('Error opening indexed db', e);
                callback?.(e);
            };
            req.onsuccess = (e) => {
                this.db = (e.target as IDBOpenDBRequest).result;
                callback?.();
            };
            req.onupgradeneeded = (e) => {
                const db = (e.target as IDBOpenDBRequest).result;
                db.createObjectStore('files');
            };
        } catch (e) {
            this.logger.error('Error opening indexed db', e);
            callback?.(e);
        }
    }

    save(id: string, data: unknown, callback?: CacheCallback): void {
        this.logger.debug('Save', id);
        this.initDb((err) => {
            if (err) {
                return callback?.(err);
            }
            try {
                const ts = this.logger.ts();
                const req = this.db!
                    .transaction(['files'], 'readwrite')
                    .objectStore('files')
                    .put(data, id);
                req.onsuccess = () => {
                    this.logger.debug('Saved', id, this.logger.ts(ts));
                    callback?.();
                };
                req.onerror = () => {
                    this.logger.error('Error saving to cache', id, req.error);
                    callback?.(req.error);
                };
            } catch (e) {
                this.logger.error('Error saving to cache', id, e);
                callback?.(e);
            }
        });
    }

    load(id: string, callback?: CacheCallback): void {
        this.logger.debug('Load', id);
        this.initDb((err) => {
            if (err) {
                return callback?.(err, null);
            }
            try {
                const ts = this.logger.ts();
                const req = this.db!
                    .transaction(['files'], 'readonly')
                    .objectStore('files')
                    .get(id);
                req.onsuccess = () => {
                    this.logger.debug('Loaded', id, this.logger.ts(ts));
                    callback?.(null, req.result);
                };
                req.onerror = () => {
                    this.logger.error('Error loading from cache', id, req.error);
                    callback?.(req.error);
                };
            } catch (e) {
                this.logger.error('Error loading from cache', id, e);
                callback?.(e, null);
            }
        });
    }

    remove(id: string, callback?: CacheCallback): void {
        this.logger.debug('Remove', id);
        this.initDb((err) => {
            if (err) {
                return callback?.(err);
            }
            try {
                const ts = this.logger.ts();
                const req = this.db!
                    .transaction(['files'], 'readwrite')
                    .objectStore('files')
                    .delete(id);
                req.onsuccess = () => {
                    this.logger.debug('Removed', id, this.logger.ts(ts));
                    callback?.();
                };
                req.onerror = () => {
                    this.logger.error('Error removing from cache', id, req.error);
                    callback?.(req.error);
                };
            } catch (e) {
                this.logger.error('Error removing from cache', id, e);
                callback?.(e);
            }
        });
    }
}

export { IoBrowserCache };
export type { IoBrowserCacheConfig, CacheCallback };
