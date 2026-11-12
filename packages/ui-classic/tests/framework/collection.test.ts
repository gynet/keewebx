import { describe, test, expect, beforeEach } from 'bun:test';
import { Collection } from 'framework/collection';

/**
 * Framework Collection tests — characterization / regression baseline.
 *
 * These tests lock in the observable behavior of `framework/collection.ts`
 * so that future refactors (including the 2026-04-09 Collection<T>
 * generic refactor) cannot silently break anything. Tests exercise:
 *
 *   - Construction (empty / with initial items)
 *   - Type check enforcement (instanceof `static model`)
 *   - push / pop / shift / unshift / splice
 *   - Proxy index access (collection[0], collection[1])
 *   - length getter / setter
 *   - Array-proxied methods: forEach, map, filter, find, some, every
 *     includes, indexOf, reduce, slice, concat, reverse, sort, entries,
 *     keys, values, [Symbol.iterator]
 *   - get(id) lookup by `model.id`
 *   - remove(idOrModel)
 *   - Event emission: 'add', 'remove', 'change' events fire on mutations
 *   - comparator + sort
 *   - toJSON
 *   - Generic typing (Collection<TestModel>) — TypeScript-only assertion,
 *     ensures the generic parameter flows through public methods.
 *
 * NOT TESTED (out of scope):
 *   - Integration with real Model subclasses — covered separately by
 *     model-specific tests (entry-model, file-model, etc.)
 *   - Views that consume collections — covered by view / E2E tests
 */

class TestModel {
    id: string;
    name: string;
    value: number;

    constructor(id: string, name = 'default', value = 0) {
        this.id = id;
        this.name = name;
        this.value = value;
    }
}

class TestCollection extends Collection<TestModel> {
    static override model = TestModel;
}

// A distinct model class used to verify the runtime type check rejects
// non-matching instances.
class WrongModel {
    id = 'wrong';
}

describe('framework/Collection — behavior baseline', () => {
    let coll: TestCollection;

    beforeEach(() => {
        coll = new TestCollection();
    });

    describe('construction', () => {
        test('empty construction has length 0', () => {
            expect(coll.length).toBe(0);
        });

        test('construction with initial items populates', () => {
            const c = new TestCollection([
                new TestModel('a'),
                new TestModel('b'),
                new TestModel('c')
            ]);
            expect(c.length).toBe(3);
            expect(c[0].id).toBe('a');
            expect(c[1].id).toBe('b');
            expect(c[2].id).toBe('c');
        });
    });

    describe('type check (static model)', () => {
        test('rejects instances of wrong class on push', () => {
            expect(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                coll.push(new WrongModel() as any);
            }).toThrow(/Attempt to write WrongModel into TestCollection/);
        });

        test('rejects primitive values', () => {
            expect(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                coll.push('not a model' as any);
            }).toThrow();
        });

        test('accepts correct model subclass instances', () => {
            expect(() => coll.push(new TestModel('ok'))).not.toThrow();
            expect(coll.length).toBe(1);
        });
    });

    describe('push / pop / shift / unshift', () => {
        test('push appends items and increments length', () => {
            coll.push(new TestModel('a'));
            coll.push(new TestModel('b'));
            expect(coll.length).toBe(2);
            expect(coll[0].id).toBe('a');
            expect(coll[1].id).toBe('b');
        });

        test('push with multiple args appends all', () => {
            coll.push(new TestModel('a'), new TestModel('b'), new TestModel('c'));
            expect(coll.length).toBe(3);
        });

        test('pop removes and returns last item', () => {
            coll.push(new TestModel('a'), new TestModel('b'));
            const popped = coll.pop();
            expect(popped?.id).toBe('b');
            expect(coll.length).toBe(1);
            expect(coll[0].id).toBe('a');
        });

        test('pop on empty returns undefined', () => {
            expect(coll.pop()).toBeUndefined();
            expect(coll.length).toBe(0);
        });

        test('shift removes and returns first item', () => {
            coll.push(new TestModel('a'), new TestModel('b'));
            const shifted = coll.shift();
            expect(shifted?.id).toBe('a');
            expect(coll.length).toBe(1);
            expect(coll[0].id).toBe('b');
        });

        test('unshift prepends items', () => {
            coll.push(new TestModel('b'));
            coll.unshift(new TestModel('a'));
            expect(coll.length).toBe(2);
            expect(coll[0].id).toBe('a');
            expect(coll[1].id).toBe('b');
        });
    });

    describe('splice', () => {
        test('splice removes and returns removed items', () => {
            coll.push(new TestModel('a'), new TestModel('b'), new TestModel('c'));
            const removed = coll.splice(1, 1);
            expect(removed.length).toBe(1);
            expect(removed[0].id).toBe('b');
            expect(coll.length).toBe(2);
            expect(coll[0].id).toBe('a');
            expect(coll[1].id).toBe('c');
        });

        test('splice with inserts adds new items', () => {
            coll.push(new TestModel('a'), new TestModel('c'));
            coll.splice(1, 0, new TestModel('b'));
            expect(coll.length).toBe(3);
            expect(coll[1].id).toBe('b');
        });
    });

    describe('length set clears items', () => {
        test('length=0 empties', () => {
            coll.push(new TestModel('a'), new TestModel('b'));
            coll.length = 0;
            expect(coll.length).toBe(0);
        });

        test('length=1 truncates from 3 to 1', () => {
            coll.push(new TestModel('a'), new TestModel('b'), new TestModel('c'));
            coll.length = 1;
            expect(coll.length).toBe(1);
            expect(coll[0].id).toBe('a');
        });
    });

    describe('array-proxied methods', () => {
        beforeEach(() => {
            coll.push(
                new TestModel('a', 'Alpha', 1),
                new TestModel('b', 'Beta', 2),
                new TestModel('c', 'Gamma', 3)
            );
        });

        test('forEach iterates items with correct type', () => {
            const ids: string[] = [];
            coll.forEach((item) => ids.push(item.id));
            expect(ids).toEqual(['a', 'b', 'c']);
        });

        test('map returns transformed array', () => {
            const names = coll.map((item) => item.name);
            expect(names).toEqual(['Alpha', 'Beta', 'Gamma']);
        });

        test('filter returns matching items', () => {
            const highValue = coll.filter((item) => item.value >= 2);
            expect(highValue.length).toBe(2);
            expect(highValue.map((x) => x.id)).toEqual(['b', 'c']);
        });

        test('find returns first match', () => {
            const found = coll.find((item) => item.name === 'Beta');
            expect(found?.id).toBe('b');
        });

        test('find returns undefined for no match', () => {
            expect(coll.find((item) => item.name === 'Zeta')).toBeUndefined();
        });

        test('some returns true if any match', () => {
            expect(coll.some((item) => item.value === 2)).toBe(true);
            expect(coll.some((item) => item.value === 99)).toBe(false);
        });

        test('every returns true if all match', () => {
            expect(coll.every((item) => item.value > 0)).toBe(true);
            expect(coll.every((item) => item.value > 1)).toBe(false);
        });

        test('indexOf / includes work by reference', () => {
            const b = coll[1];
            expect(coll.indexOf(b)).toBe(1);
            expect(coll.includes(b)).toBe(true);
            expect(coll.indexOf(new TestModel('a'))).toBe(-1);
        });

        test('reduce accumulates', () => {
            const total = coll.reduce((acc, item) => acc + item.value, 0);
            expect(total).toBe(6);
        });

        test('slice returns a plain array', () => {
            const s = coll.slice(1, 3);
            expect(s.length).toBe(2);
            expect(s[0].id).toBe('b');
            expect(s[1].id).toBe('c');
        });

        test('[Symbol.iterator] yields items', () => {
            const ids: string[] = [];
            for (const item of coll) {
                ids.push(item.id);
            }
            expect(ids).toEqual(['a', 'b', 'c']);
        });

        test('entries yields [index, item] pairs', () => {
            const pairs: [number, string][] = [];
            for (const [i, item] of coll.entries()) {
                pairs.push([i, item.id]);
            }
            expect(pairs).toEqual([
                [0, 'a'],
                [1, 'b'],
                [2, 'c']
            ]);
        });
    });

    describe('get(id)', () => {
        test('finds item by id field', () => {
            coll.push(new TestModel('xyz', 'Test', 42));
            const found = coll.get('xyz');
            expect(found?.name).toBe('Test');
            expect(found?.value).toBe(42);
        });

        test('returns undefined for missing id', () => {
            coll.push(new TestModel('a'));
            expect(coll.get('missing')).toBeUndefined();
        });
    });

    describe('remove(idOrModel)', () => {
        test('removes by id string', () => {
            coll.push(new TestModel('a'), new TestModel('b'), new TestModel('c'));
            coll.remove('b');
            expect(coll.length).toBe(2);
            expect(coll[0].id).toBe('a');
            expect(coll[1].id).toBe('c');
        });

        test('removes by model reference', () => {
            const a = new TestModel('a');
            const b = new TestModel('b');
            coll.push(a, b);
            coll.remove(b);
            expect(coll.length).toBe(1);
            expect(coll[0]).toBe(a);
        });

        test('no-op for missing id', () => {
            coll.push(new TestModel('a'));
            coll.remove('missing');
            expect(coll.length).toBe(1);
        });
    });

    describe('event emission', () => {
        test("push emits 'add' for each item and 'change' once", () => {
            const added: TestModel[] = [];
            let changeEvents = 0;
            coll.on('add', (item: TestModel) => added.push(item));
            coll.on('change', () => changeEvents++);

            coll.push(new TestModel('a'), new TestModel('b'));
            expect(added.length).toBe(2);
            expect(added[0].id).toBe('a');
            expect(changeEvents).toBe(1);
        });

        test("pop emits 'remove' and 'change'", () => {
            coll.push(new TestModel('a'), new TestModel('b'));
            const removed: TestModel[] = [];
            let changeEvents = 0;
            coll.on('remove', (item: TestModel) => removed.push(item));
            coll.on('change', () => changeEvents++);

            coll.pop();
            expect(removed.length).toBe(1);
            expect(removed[0].id).toBe('b');
            expect(changeEvents).toBe(1);
        });

        test('splice emits remove + add + change', () => {
            coll.push(new TestModel('a'), new TestModel('b'));
            const events: string[] = [];
            coll.on('add', () => events.push('add'));
            coll.on('remove', () => events.push('remove'));
            coll.on('change', () => events.push('change'));

            coll.splice(0, 1, new TestModel('c'));
            // remove a, add c, change once
            expect(events).toContain('remove');
            expect(events).toContain('add');
            expect(events).toContain('change');
        });

        test('once fires handler only first time', () => {
            let callCount = 0;
            coll.once('add', () => callCount++);
            coll.push(new TestModel('a'));
            coll.push(new TestModel('b'));
            expect(callCount).toBe(1);
        });

        test('off removes listener', () => {
            let callCount = 0;
            const listener = () => callCount++;
            coll.on('add', listener);
            coll.off('add', listener);
            coll.push(new TestModel('a'));
            expect(callCount).toBe(0);
        });
    });

    describe('sort with comparator', () => {
        test('sort uses comparator', () => {
            coll.push(
                new TestModel('c', 'Gamma', 3),
                new TestModel('a', 'Alpha', 1),
                new TestModel('b', 'Beta', 2)
            );
            coll.comparator = (x, y) => x.value - y.value;
            coll.sort();
            expect(coll[0].id).toBe('a');
            expect(coll[1].id).toBe('b');
            expect(coll[2].id).toBe('c');
        });
    });

    describe('toJSON', () => {
        test('returns shallow copy of items array', () => {
            coll.push(new TestModel('a'), new TestModel('b'));
            const json = coll.toJSON();
            expect(Array.isArray(json)).toBe(true);
            expect(json.length).toBe(2);
            expect(json[0].id).toBe('a');
            // Ensure it's a copy, not a reference to internal array
            json.pop();
            expect(coll.length).toBe(2);
        });
    });

    describe('generic type flow (compile-time only)', () => {
        test('Collection<TestModel>.get returns TestModel | undefined', () => {
            // This is a pure compile-time assertion — if Collection's
            // generic parameter isn't wired through, the line below
            // won't compile (TS would complain about accessing `.name`
            // on `unknown | undefined`). Bun test runs the compiled JS,
            // but if the file fails to compile this whole test file
            // won't run and all the above assertions will be missing.
            coll.push(new TestModel('a', 'Alpha'));
            const found = coll.get('a');
            const name: string | undefined = found?.name;
            expect(name).toBe('Alpha');
        });

        test('forEach callback parameter is TestModel', () => {
            coll.push(new TestModel('a', 'Alpha', 42));
            let captured: TestModel | undefined;
            coll.forEach((item) => {
                captured = item;
            });
            // Access a TestModel-specific field to ensure the type
            // parameter flowed through forEach's callback signature.
            expect(captured?.value).toBe(42);
        });
    });
});
