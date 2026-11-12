import type { AppModel } from 'models/app-model';

const pending = new WeakMap<AppModel, Set<Promise<void>>>();

/** Register before the first await so locking cannot overtake an unfinished attachment. */
export function beginPendingOperation(model: AppModel): () => void {
    let operations = pending.get(model);
    if (!operations) { operations = new Set(); pending.set(model, operations); }
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    operations.add(operation);
    return () => { operations!.delete(operation); finish(); };
}

export async function waitForPendingOperations(model: AppModel, signal: AbortSignal): Promise<void> {
    while (pending.get(model)?.size) {
        await new Promise<void>((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Lock canceled')); };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) { abort(); return; }
            void Promise.all([...pending.get(model)!]).then(() => {
                signal.removeEventListener('abort', abort);
                resolve();
            });
        });
    }
    if (signal.aborted) throw new Error('Lock canceled');
}
