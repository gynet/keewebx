import { expect, test } from 'bun:test';
import { ReplyReceipt, type ReceiptBinding } from '../src/reply-receipt';

const binding = (): ReceiptBinding => ({ request: '{"id":"request","scope":"session","origin":"https://login.example"}',
    port: 'physical-port', authorization: 4, key: {}, deadline: 2000 });

test('only the identical signed request on its original grant receives its opaque receipt', () => {
    const store = new ReplyReceipt<Readonly<{ message: string }>>(() => 1000);
    const owner = binding(), response = { message: 'opaque encrypted response' };
    store.remember(owner, response);
    expect(store.read({ ...owner })).toBe(response);
    for (const changed of [{ request: owner.request + 'changed' }, { port: 'other-port' },
        { authorization: owner.authorization + 1 }, { key: {} }, { deadline: owner.deadline + 1 }]) {
        expect(store.read({ ...owner, ...changed })).toBeUndefined();
    }
    expect(store.read(owner)).toBe(response);
});
test('only one reply is retained and expiry, replacement or cancellation makes it unusable', () => {
    let now = 1000;
    const store = new ReplyReceipt<string>(() => now), first = binding(), second = { ...first, request: 'next signed request' };
    store.remember(first, 'first'); store.remember(second, 'second');
    expect(store.read(first)).toBeUndefined(); expect(store.read(second)).toBe('second');
    now = second.deadline; expect(store.read(second)).toBeUndefined();
    now = 1000; expect(store.read(second)).toBeUndefined();
    store.remember(first, 'first'); store.clear(); expect(store.read(first)).toBeUndefined();
});
test('expired or non-finite request deadlines never become reusable receipts', () => {
    const store = new ReplyReceipt<string>(() => 1000);
    for (const deadline of [0, 999, 1000, NaN, Infinity]) {
        const value = { ...binding(), deadline };
        store.remember(value, 'response'); expect(store.read(value)).toBeUndefined();
    }
});
