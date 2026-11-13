import { beforeEach, expect, mock, test } from 'bun:test';

// Control the IDB event boundaries independently of request success.
let opening: any;
const open = mock(() => (opening = {}));
(globalThis as any).window = { indexedDB: { open } };
mock.module('util/logger', () => ({ Logger: class {} }));
mock.module('comp/settings/storage-namespace', () => ({ storageKey: (key: string) => key }));
const { IoBrowserCache } = await import('../../../vault/src/storage/io-browser-cache');
const logger = { debug() {}, error() {}, ts() {} } as any;
let transactions: any[];
let operations: string[];
const database = { transaction: () => {
    const request: any = {};
    const tx: any = { request, objectStore: () => ({
        put: (_data: unknown, id: string) => { operations.push(`put:${id}`); return request; },
        delete: (id: string) => { operations.push(`delete:${id}`); return request; }
    }) };
    transactions.push(tx); return tx;
} };
function cache(connected = true) {
    const io = new IoBrowserCache({ cacheName: 'FilesCache', logger });
    if (connected) io.db = database as any;
    return io;
}
beforeEach(() => { transactions = []; operations = []; open.mockClear(); });
for (const action of ['save', 'remove'] as const) {
    function start(io: InstanceType<typeof IoBrowserCache>, done: (...args: any[]) => void) {
        if (action === 'save') io.save('id', new ArrayBuffer(1), done); else io.remove('id', done);
    }
    test(`${action}: request success alone does not acknowledge durability`, () => {
        const done = mock(); start(cache(), done);
        const tx = transactions[0];
        tx.request.onsuccess?.(); expect(done).not.toHaveBeenCalled();
        tx.oncomplete(); expect(done.mock.calls).toEqual([[undefined]]);
    });
    test(`${action}: abort after request success reports failure exactly once`, () => {
        const done = mock(); start(cache(), done);
        const tx = transactions[0];
        tx.request.onsuccess?.(); tx.onabort(); tx.oncomplete();
        expect(done).toHaveBeenCalledTimes(1); expect(done.mock.calls[0][0]).toBeInstanceOf(Error);
    });
    test(`${action}: request quota error waits for abort and preserves the cause`, () => {
        const done = mock(); start(cache(), done);
        const tx = transactions[0], error = new DOMException('full', 'QuotaExceededError');
        tx.request.error = error; tx.request.onerror(); tx.onerror();
        expect(done).not.toHaveBeenCalled(); tx.onabort();
        expect(done.mock.calls).toEqual([[error]]);
    });
    test(`${action}: unavailable transaction fails once`, () => {
        const io = cache(), done = mock(), error = new Error('unavailable');
        io.db = { transaction() { throw error; } } as any;
        start(io, done); expect(done.mock.calls).toEqual([[error]]);
    });
}
test('concurrent initial writes share one open and enqueue in call order', () => {
    const io = cache(false), first = mock(), second = mock();
    io.save('import', new ArrayBuffer(1), first); io.save('edit', new ArrayBuffer(2), second);
    expect(open).toHaveBeenCalledTimes(1); expect(operations).toEqual([]);
    opening.result = database; opening.onsuccess();
    expect(operations).toEqual(['put:import', 'put:edit']);
    expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
    transactions[0].oncomplete(); transactions[1].oncomplete();
    expect(first.mock.calls).toEqual([[undefined]]); expect(second.mock.calls).toEqual([[undefined]]);
});
test('failed database open settles all callers and permits retry', () => {
    const io = cache(false), first = mock(), second = mock();
    io.save('a', 1, first); io.remove('b', second);
    const error = new Error('denied'); opening.error = error; opening.onerror();
    expect(first.mock.calls).toEqual([[error]]); expect(second.mock.calls).toEqual([[error]]);
    io.save('retry', 2); expect(open).toHaveBeenCalledTimes(2);
    opening.result = database; opening.onsuccess(); expect(operations).toEqual(['put:retry']);
});
test('deferred purge rechecks eligibility before creating the deletion transaction', () => {
    const io = cache(false), done = mock(); let eligible = true;
    io.remove('recovery', done, () => eligible);
    eligible = false; opening.result = database; opening.onsuccess();
    expect(operations).toEqual([]); expect(done.mock.calls).toEqual([[undefined]]);
});
test('optional cache refresh rechecks policy after database open', () => {
    const io = cache(false); let enabled = true;
    io.save('remote', 1, undefined, () => enabled);
    enabled = false; opening.result = database; opening.onsuccess();
    expect(operations).toEqual([]);
});
