import type { AppModel } from 'models/app-model';

type Operation = { promise: Promise<void>; fileId?: string; finish(): void };
const pending = new WeakMap<AppModel, Set<Operation>>();

/** Register before the first await so locking cannot overtake an unfinished attachment. */
export function beginPendingOperation(model: AppModel, fileId?: string): () => void {
    let operations = pending.get(model);
    if (!operations) { operations = new Set(); pending.set(model, operations); }
    let finish!: () => void;
    const promise = new Promise<void>((resolve) => { finish = resolve; });
    const operation = { promise, fileId, finish: () => { operations!.delete(operation); finish(); } };
    operations.add(operation);
    return operation.finish;
}

export async function waitForPendingOperations(model: AppModel, signal: AbortSignal, fileId?: string, exclude?: () => void): Promise<void> {
    const selected = () => [...(pending.get(model) ?? [])].filter(operation => operation.finish !== exclude &&
        (!fileId || !operation.fileId || operation.fileId === fileId));
    while (selected().length) {
        await new Promise<void>((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Lock canceled')); };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) { abort(); return; }
            void Promise.all(selected().map(operation => operation.promise)).then(() => {
                signal.removeEventListener('abort', abort);
                resolve();
            });
        });
    }
    if (signal.aborted) throw new Error('Lock canceled');
}
