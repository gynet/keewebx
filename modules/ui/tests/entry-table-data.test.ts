import { test, expect } from 'bun:test';
import { entryPage, visibleColumns } from '../src/entry-table-data';
test('shared column preferences allow known fields and always leave a selectable title', () => {
    for (const value of [null, undefined, '', [], 'notes', 42]) expect(visibleColumns(value)).toEqual(['title', 'user', 'website']);
    expect(visibleColumns(['notes', 'file', 'unknown', 'notes'])).toEqual(['title', 'notes', 'file']);
    expect(visibleColumns(['__proto__', null, {}])).toEqual(['title']);
});
test('entry pages clamp after filtering, empty results and invalid stored state', () => {
    expect(entryPage(49, 10_000)).toBe(49); expect(entryPage(50, 10_000)).toBe(49);
    expect(entryPage(49, 1)).toBe(0); expect(entryPage(49, 0)).toBe(0);
    expect(entryPage(-1, 1000)).toBe(0); expect(entryPage(NaN, 1000)).toBe(0);
});
