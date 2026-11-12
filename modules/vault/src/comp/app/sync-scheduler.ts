/**
 * Saves open files shortly after each change and keeps retrying while the
 * storage is unreachable. Active when the "on every change" save interval is
 * selected. The sync itself stays AppModel.syncFile: local cache first, then
 * the storage with a revision check and a KDBX merge on conflict.
 *
 * It also publishes a summary of every open file's sync state with
 * window.postMessage({ kwSyncState }), which the browser extension shows.
 */
import type { FileModel } from 'models/file-model';

export type SyncState = 'saved' | 'pending' | 'syncing' | 'offline' | 'error';

export interface SyncStateSummary {
    state: SyncState;
    files: { name: string; state: SyncState; error: string | null }[];
}

type SyncFn = (file: FileModel, callback: (err?: unknown) => void) => void;

const DEBOUNCE_MS = 1500;
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];
const PRIORITY: SyncState[] = ['saved', 'pending', 'syncing', 'offline', 'error'];

/**
 * Errors that a retry cannot fix: wrong credentials or a changed master key.
 * A CORS error is retried, because an unreachable server reports the same.
 */
function needsUser(error: string): boolean {
    return /HTTP status 40[13]\b|InvalidKey|Invalid key/i.test(error);
}

export function fileSyncState(file: FileModel): SyncState {
    if (file.syncing) {
        return 'syncing';
    }
    if (!file.modified) {
        return 'saved';
    }
    if (file.syncError) {
        return needsUser(file.syncError) ? 'error' : 'offline';
    }
    return 'pending';
}

interface Tracked {
    file: FileModel;
    timer?: ReturnType<typeof setTimeout>;
    failures: number;
}

class SyncScheduler {
    private readonly tracked = new Map<string, Tracked>();
    private lastPublished = '';

    constructor(
        private readonly sync: SyncFn,
        private readonly enabled: () => boolean,
        private readonly publish: (summary: SyncStateSummary) => void = postToWindow,
        private readonly delays = { debounce: DEBOUNCE_MS, retry: RETRY_MS }
    ) {
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('online', () => this.retryAll());
        }
    }

    watch(file: FileModel): void {
        const entry: Tracked = { file, failures: 0 };
        this.tracked.set(file.id, entry);
        file.on('change:editSeq', () => {
            if (this.enabled()) {
                this.schedule(entry, this.delays.debounce);
            }
        });
        file.on('change:syncing', (_f: FileModel, syncing: boolean) => {
            if (!syncing) {
                // The rest of the sync result is set in the same call.
                queueMicrotask(() => this.afterSync(entry));
            }
        });
        file.on('change', () => this.publishState());
        file.on('change:active', (_f: FileModel, active: boolean) => {
            if (!active) {
                clearTimeout(entry.timer);
                this.tracked.delete(file.id);
                this.publishState();
            }
        });
        this.publishState();
    }

    /** Sync every file with unsaved changes now, e.g. when the network is back. */
    retryAll(): void {
        if (!this.enabled()) {
            return;
        }
        for (const entry of this.tracked.values()) {
            if (entry.file.modified) {
                entry.failures = 0;
                this.schedule(entry, 0);
            }
        }
    }

    summary(): SyncStateSummary {
        const files = [...this.tracked.values()].map(({ file }) => ({
            name: file.name,
            state: fileSyncState(file),
            error: file.modified ? file.syncError : null
        }));
        const state = files.reduce<SyncState>(
            (worst, f) => (PRIORITY.indexOf(f.state) > PRIORITY.indexOf(worst) ? f.state : worst),
            'saved'
        );
        return { state, files };
    }

    private afterSync(entry: Tracked): void {
        const { file } = entry;
        if (!this.enabled() || !file.active || !file.modified) {
            entry.failures = 0;
            return;
        }
        if (!file.syncError) {
            // Edited while the sync was running.
            entry.failures = 0;
            this.schedule(entry, this.delays.debounce);
        } else if (!needsUser(file.syncError)) {
            const retry = this.delays.retry;
            this.schedule(entry, retry[Math.min(entry.failures++, retry.length - 1)]);
        }
    }

    private schedule(entry: Tracked, delay: number): void {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            entry.timer = undefined;
            // A running sync reschedules itself when it ends.
            if (this.enabled() && entry.file.active && !entry.file.syncing) {
                this.sync(entry.file, () => {});
            }
        }, delay);
    }

    private publishState(): void {
        const summary = this.summary();
        const key = JSON.stringify(summary);
        if (key !== this.lastPublished) {
            this.lastPublished = key;
            this.publish(summary);
        }
    }
}

function postToWindow(summary: SyncStateSummary): void {
    if (typeof window === 'undefined' || typeof window.postMessage !== 'function') {
        return;
    }
    // file:// pages have an opaque origin, which postMessage does not accept.
    const target = location.origin === 'null' ? '*' : location.origin;
    window.postMessage({ kwSyncState: summary }, target);
}

export { SyncScheduler };
