import { afterEach, beforeEach, describe, test, expect, jest } from 'bun:test';
import { EventEmitter } from 'events';
import { fileSyncState, SyncScheduler, type SyncStateSummary } from '../../../../vault/src/comp/app/sync-scheduler';
import type { FileModel } from '../../../../vault/src/models/file-model';

/** Just enough of FileModel: attributes that emit change events like the real one. */
class FakeFile extends EventEmitter {
    id = 'f1';
    name = 'vault';
    active = true;
    modified = false;
    dirty = false;
    syncing = false;
    syncError: string | null = null;
    editSeq = 0;

    set(props: Partial<Record<'active' | 'modified' | 'syncing' | 'syncError' | 'editSeq', unknown>>): void {
        for (const [k, v] of Object.entries(props)) {
            const prev = (this as Record<string, unknown>)[k];
            if (prev !== v) {
                (this as Record<string, unknown>)[k] = v;
                this.emit('change:' + k, this, v, prev);
            }
        }
        this.emit('change', this, props);
    }

    edit(): void {
        this.set({ modified: true, editSeq: this.editSeq + 1 });
    }
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

// Flush afterSync's microtask between timer ticks, independent of machine load.
async function wait(ms: number): Promise<void> {
    for (let tick = 0; tick < ms; tick++) {
        jest.advanceTimersByTime(1);
        await Promise.resolve();
    }
}

function setup(results: Array<string | null>, { enabled = true, editDuringSync = false } = {}) {
    const file = new FakeFile();
    const calls: number[] = [];
    const published: SyncStateSummary[] = [];
    const scheduler = new SyncScheduler(
        (f) => {
            calls.push(Date.now());
            const error = results.length ? results.shift()! : null;
            file.set({ syncing: true });
            setTimeout(() => {
                if (editDuringSync && calls.length === 1) {
                    file.edit();
                }
                const stillModified = !!error || (editDuringSync && calls.length === 1);
                file.set({ syncing: false, syncError: error, modified: stillModified });
            }, 5);
            expect(f).toBe(file as unknown as FileModel);
        },
        () => enabled,
        (s) => published.push(s),
        { debounce: 20, retry: [30, 60] }
    );
    scheduler.watch(file as unknown as FileModel);
    return { file, calls, published, scheduler };
}

describe('SyncScheduler', () => {
    test('saves once after a burst of edits', async () => {
        const { file, calls } = setup([]);
        file.edit();
        file.edit();
        await wait(10);
        file.edit();
        await wait(60);
        expect(calls.length).toBe(1);
        expect(file.modified).toBe(false);
    });

    test('does nothing unless saving on every change is selected', async () => {
        const { file, calls } = setup([], { enabled: false });
        file.edit();
        await wait(60);
        expect(calls.length).toBe(0);
    });

    test('retries while the storage is unreachable, then stops', async () => {
        const { file, calls, published } = setup(['network error', 'HTTP status 503']);
        file.edit();
        await wait(40);
        expect(calls.length).toBe(1);
        expect(published.at(-1)!.state).toBe('offline');
        await wait(150);
        expect(calls.length).toBe(3);
        expect(file.modified).toBe(false);
        expect(published.at(-1)!.state).toBe('saved');
    });

    test('does not retry errors only the user can fix', async () => {
        const { file, calls, published } = setup(['HTTP status 401']);
        file.edit();
        await wait(150);
        expect(calls.length).toBe(1);
        expect(published.at(-1)).toEqual({
            state: 'error',
            files: [{ name: 'vault', state: 'error', error: 'HTTP status 401' }]
        });
    });

    test('saves again when the file changed during a sync', async () => {
        const { file, calls } = setup([], { editDuringSync: true });
        file.edit();
        await wait(100);
        expect(calls.length).toBe(2);
        expect(file.modified).toBe(false);
    });

    test('retries at once when the network comes back', async () => {
        const { file, calls, scheduler } = setup(['network error']);
        file.edit();
        await wait(30);
        expect(calls.length).toBe(1);
        scheduler.retryAll();
        await wait(10);
        expect(calls.length).toBe(2);
    });

    test('forgets a closed file', async () => {
        const { file, published } = setup(['HTTP status 401']);
        file.edit();
        await wait(40);
        file.set({ active: false });
        expect(published.at(-1)).toEqual({ state: 'saved', files: [] });
    });
});

describe('SyncScheduler error kinds', () => {
    test('unsaved verification and cache failures never claim a saved device copy', () => {
        const file = new FakeFile();
        for (const error of ['Save verification failed', 'Cache write failed', 'Sync request expired']) {
            file.syncError = error;
            file.dirty = true;
            for (const modified of [true, false]) {
                file.modified = modified;
                expect(fileSyncState(file as unknown as FileModel)).toBe('error');
            }
        }
        file.syncError = null;
        expect(fileSyncState(file as unknown as FileModel)).toBe('pending');
        file.modified = true; file.dirty = false; file.syncError = 'Network error';
        expect(fileSyncState(file as unknown as FileModel)).toBe('offline');
    });

    test('retries a CORS error, which is what an unreachable server looks like', async () => {
        const { file, calls, published } = setup(['CORS error']);
        file.edit();
        await wait(40);
        expect(published.at(-1)!.state).toBe('offline');
        await wait(60);
        expect(calls.length).toBe(2);
    });
});
