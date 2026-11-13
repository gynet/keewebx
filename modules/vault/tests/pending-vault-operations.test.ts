import { expect, test } from 'bun:test';
import type { AppModel } from '../src/models/app-model';
import { beginPendingOperation, waitForPendingOperations } from '../../ui/src/pending-operations';

test('target close drains its operations without waiting for another vault; global lock waits for both', async () => {
    const model = {} as AppModel;
    const a = beginPendingOperation(model, 'A');
    const b = beginPendingOperation(model, 'B');
    const close = beginPendingOperation(model, 'B');
    const controller = new AbortController();
    let closed = false, locked = false;
    const closing = waitForPendingOperations(model, controller.signal, 'B', close).then(() => { closed = true; });
    const locking = waitForPendingOperations(model, controller.signal).then(() => { locked = true; });
    await Promise.resolve(); expect(closed).toBe(false); expect(locked).toBe(false);
    b(); await closing; expect(closed).toBe(true); expect(locked).toBe(false);
    close(); a(); await locking; expect(locked).toBe(true);
});

test('unscoped operations block a target close and aborting its wait does not drop the pending operation', async () => {
    const model = {} as AppModel;
    const finish = beginPendingOperation(model);
    const controller = new AbortController();
    const waiting = waitForPendingOperations(model, controller.signal, 'B');
    controller.abort(); await expect(waiting).rejects.toThrow();
    let drained = false;
    const retry = waitForPendingOperations(model, new AbortController().signal, 'B').then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    finish(); await retry; expect(drained).toBe(true);
});

test('work registered while a drain waits is also awaited', async () => {
    const model = {} as AppModel;
    const first = beginPendingOperation(model, 'B');
    let drained = false;
    const waiting = waitForPendingOperations(model, new AbortController().signal, 'B').then(() => { drained = true; });
    const second = beginPendingOperation(model, 'B');
    first(); await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
    second(); await waiting; expect(drained).toBe(true);
});
