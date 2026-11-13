import { Logger } from 'util/logger';
import { storageKey } from 'comp/settings/storage-namespace';

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
    private opening: CacheCallback[] | null = null;

    static readonly enabled: boolean = !!idb;

    constructor(config: IoBrowserCacheConfig) {
        this.cacheName = storageKey(config.cacheName);
        this.logger = config.logger;
    }

    initDb(callback?: CacheCallback): void {
        if (this.db) {
            return callback?.();
        }
        // All callers share one connection and enqueue transactions in call order.
        // Separate open requests can otherwise let an older import overwrite a save.
        if (this.opening) { this.opening.push(callback ?? (() => {})); return; }
        this.opening = [callback ?? (() => {})];
        const finish = (error?: unknown) => {
            const callbacks = this.opening;
            this.opening = null;
            for (const done of callbacks ?? []) done(error);
        };
        try {
            const req = idb!.open(this.cacheName);
            req.onerror = () => finish(req.error || new Error('Cannot open browser storage'));
            req.onsuccess = () => {
                const db = req.result;
                this.db = db;
                const closed = () => { if (this.db === db) this.db = null; };
                db.onversionchange = () => { db.close(); closed(); };
                db.onclose = closed;
                finish();
            };
            req.onupgradeneeded = () => {
                req.result.createObjectStore('files');
            };
        } catch (error) {
            this.logger.error('Error opening indexed db', error);
            finish(error);
        }
    }

    save(id: string, data: unknown, callback?: CacheCallback, canWrite?: () => boolean): void {
        this.logger.debug('Save', id);
        this.write(id, (store) => store.put(data, id), callback, canWrite);
    }

    /** A request may succeed and still roll back. Only the transaction commits bytes. */
    private write(id: string, operation: (store: IDBObjectStore) => IDBRequest, callback?: CacheCallback, canWrite?: () => boolean): void {
        let completed = false;
        const finish = (error?: unknown) => {
            if (completed) return;
            completed = true;
            if (error) this.logger.error('Cache transaction failed', id, error);
            callback?.(error);
        };
        this.initDb((error) => {
            if (error) return finish(error);
            try {
                // Recheck at transaction creation, after any asynchronous database open.
                if (canWrite && !canWrite()) return finish();
                const tx = this.db!.transaction(['files'], 'readwrite', { durability: 'strict' });
                let failure: unknown;
                tx.oncomplete = () => finish(failure);
                tx.onabort = () => finish(tx.error || failure || new Error('Cache transaction aborted'));
                tx.onerror = () => { failure = tx.error || failure || new Error('Cache transaction failed'); };
                const request = operation(tx.objectStore('files'));
                request.onerror = () => { failure = request.error || new Error('Cache request failed'); };
            } catch (error) { finish(error); }
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

    remove(id: string, callback?: CacheCallback, canRemove?: () => boolean): void {
        this.logger.debug('Remove', id);
        this.write(id, (store) => store.delete(id), callback, canRemove);
    }
}

export { IoBrowserCache };
export type { IoBrowserCacheConfig, CacheCallback };
