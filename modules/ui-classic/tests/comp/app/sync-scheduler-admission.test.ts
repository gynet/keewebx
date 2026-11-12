import { afterEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import { SyncScheduler } from '../../../../vault/src/comp/app/sync-scheduler';
import type { FileModel } from '../../../../vault/src/models/file-model';

// Separate per-file process; no module mocks or private scheduler state access.
class File extends EventEmitter {
    id = 'queued'; name = 'queued vault'; active = true; modified = true;
    syncing = false; syncError: string | null = null;
    close() { this.active = false; this.emit('change:active', this, false); }
}
const cleanup: File[] = [];
afterEach(() => { for (const file of cleanup.splice(0)) file.close(); });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function setup() {
    let enabled = true;
    const file = new File(); cleanup.push(file);
    const sync = mock((_file: FileModel, done: (error?: unknown) => void) => done());
    const scheduler = new SyncScheduler(sync, () => enabled, () => {}, { debounce: 20, retry: [80] });
    scheduler.watch(file as unknown as FileModel);
    return { file, sync, scheduler, disable: () => { enabled = false; }, enable: () => { enabled = true; } };
}

describe('SyncScheduler admission at queued timer dispatch', () => {
    test('a queued edit debounce cannot write after admission is disabled; explicit retry after resume saves the retained edit', async () => {
        const h = setup();
        h.file.emit('change:editSeq', h.file, 1, 0);
        h.disable(); await wait(70);
        expect(h.sync).not.toHaveBeenCalled(); expect(h.file.modified).toBe(true);
        h.enable(); h.scheduler.retryAll(); await wait(20);
        expect(h.sync).toHaveBeenCalledTimes(1);
    });

    test('an already queued offline retry cannot write after admission is disabled', async () => {
        const h = setup();
        h.file.syncError = 'network error';
        h.file.emit('change:syncing', h.file, false, true);
        // afterSync schedules its retry in a microtask while enabled is still true.
        await Promise.resolve();
        h.disable(); await wait(130);
        expect(h.sync).not.toHaveBeenCalled(); expect(h.file.modified).toBe(true);
        expect(h.scheduler.summary().state).toBe('offline');
        h.enable(); h.scheduler.retryAll(); await wait(20);
        expect(h.sync).toHaveBeenCalledTimes(1);
    });

    test('retryAll queued while enabled must recheck admission before its zero-delay callback runs', async () => {
        const h = setup();
        h.scheduler.retryAll(); h.disable(); await wait(30);
        expect(h.sync).not.toHaveBeenCalled();
        h.scheduler.retryAll(); await wait(30);
        expect(h.sync).not.toHaveBeenCalled();
        h.enable(); h.scheduler.retryAll(); await wait(20);
        expect(h.sync).toHaveBeenCalledTimes(1);
    });
});
