import { expect, test } from 'bun:test';
import { Operation } from '../src/operation';

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
test('all stages share one deadline and cannot renew it', async () => {
    let now = 1000; const stages: string[] = [];
    const operation = new Operation('Connecting', 30000, stage => stages.push(stage), () => {}, () => now);
    try {
        expect(await operation.run('Find accounts', async () => 42)).toBe(42);
        now = 20000; expect(operation.remainingMs).toBe(11000);
        operation.setStage('Read selected account'); expect(operation.deadline).toBe(31000);
        now = 31000; expect(() => operation.assert()).toThrow('Read selected account timed out');
        expect(stages).toEqual(['Connecting', 'Find accounts', 'Read selected account']);
    } finally { operation.cancel(); }
});
test('cancellation stops an awaiting stage immediately and discards its late result', async () => {
    const waiting = deferred<string>(), operation = new Operation('Connecting', 30000, () => {}, () => {});
    let consumed = false;
    const result = operation.run('Reading account', () => waiting.promise).then(() => { consumed = true; }, error => error);
    await Promise.resolve(); operation.cancel();
    expect(await result).toBeInstanceOf(Error);
    waiting.resolve('late result'); await Promise.resolve(); await Promise.resolve();
    expect(consumed).toBe(false);
});
test('canceling before a queued stage starts prevents its side effects', async () => {
    const operation = new Operation('Connecting', 30000, () => {}, () => {}); let calls = 0;
    const result = operation.run('Read fields', async () => { calls++; }).catch(error => error);
    operation.cancel(); expect(await result).toBeInstanceOf(Error); expect(calls).toBe(0);
});
test('one timeout releases a hung operation and exposes the actual stalled stage', async () => {
    let count = 0, stage = '';
    const operation = new Operation('Connecting', 10, () => {}, value => { count++; stage = value; });
    const result = operation.run('Finding matching accounts', () => new Promise<never>(() => {})).catch(error => error);
    expect((await result).message).toContain('Finding matching accounts timed out');
    expect(count).toBe(1); expect(stage).toBe('Finding matching accounts');
    operation.cancel(); expect(count).toBe(1);
});
test('a finished action cancels its timer and rejects later stage starts', async () => {
    let timeouts = 0;
    const operation = new Operation('Connecting', 10, () => {}, () => timeouts++);
    await operation.run('Find accounts', async () => 1); operation.cancel();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(timeouts).toBe(0);
    await expect(operation.run('Read fields', async () => 2)).rejects.toThrow('canceled');
});
