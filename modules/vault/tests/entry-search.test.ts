import { describe, expect, test } from 'bun:test';
import { ProtectedValue } from 'kdbxweb';
import '../src/util/kdbxweb/protected-value-ex';
import { EntrySearch, type AdvancedFilter, type EntryFields } from '../src/util/entry-search';

function search(fields: EntryFields, history: Array<{ fields: EntryFields | Map<string, string | ProtectedValue> }> = []) {
    return new EntrySearch({ fields, searchText: '', getAllFields: () => fields, getHistoryEntriesForSearch: () => history });
}
const match = (engine: EntrySearch, text: string, advanced: AdvancedFilter) => engine.matches({ text, textLower: text.toLowerCase(), advanced });

describe('advanced secret opt-in and KDBX history', () => {
    test('New scopes exclude protected built-ins, password and unprotected OTP until explicitly enabled', () => {
        const engine = search({ Title: ProtectedValue.fromString('classified'), UserName: ProtectedValue.fromString('classified'),
            URL: ProtectedValue.fromString('classified'), Notes: ProtectedValue.fromString('classified'),
            Password: 'classified', otp: 'classified', custom: ProtectedValue.fromString('classified') });
        const flags = { title: true, user: true, url: true, notes: true, other: true, excludeProtected: true };
        expect(match(engine, 'classified', flags)).toBe(false);
        expect(match(engine, 'classified', { ...flags, protect: true })).toBe(true);
        expect(match(engine, 'classified', { ...flags, pass: true })).toBe(true);
        expect(match(search({ Password: ProtectedValue.fromString('classified') }), 'classified', { ...flags, protect: true })).toBe(false);
        for (const field of ['Title', 'UserName', 'URL', 'Notes']) {
            const protectedField = search({ [field]: ProtectedValue.fromString('classified') });
            expect(match(protectedField, 'classified', flags)).toBe(false);
            expect(match(protectedField, 'classified', { ...flags, protect: true })).toBe(true);
        }
    });
    test('shared Classic callers retain existing explicit field semantics', () => {
        expect(match(search({ Notes: ProtectedValue.fromString('classified') }), 'classified', { notes: true })).toBe(true);
    });
    test('real Map history and legacy object history both honor history and secret switches', () => {
        for (const fields of [new Map([['Password', ProtectedValue.fromString('old secret')]]), { Password: ProtectedValue.fromString('old secret') }]) {
            const engine = search({ Password: ProtectedValue.fromString('new secret') }, [{ fields }]);
            expect(match(engine, 'old', { pass: true })).toBe(false);
            expect(match(engine, 'old', { history: true, other: true, excludeProtected: true })).toBe(false);
            expect(match(engine, 'old', { history: true, pass: true, excludeProtected: true })).toBe(true);
        }
    });
    test('invalid regex fails closed, matching regex respects case and protected scopes', () => {
        const engine = search({ Notes: ProtectedValue.fromString('SecretCase') });
        expect(match(engine, '[', { regex: true, notes: true, protect: true, excludeProtected: true })).toBe(false);
        expect(match(engine, '^secretcase$', { regex: true, notes: true, excludeProtected: true })).toBe(false);
        expect(match(engine, '^secretcase$', { regex: true, notes: true, protect: true, excludeProtected: true })).toBe(true);
        expect(match(engine, '^secretcase$', { regex: true, cs: true, notes: true, protect: true, excludeProtected: true })).toBe(false);
    });
});

test('case-insensitive all-word matching spans ordinary fields, tags and filenames', () => {
    const engine = new EntrySearch({ fields: {}, searchText: '', tags: ['RESEARCH'], attachments: [{ title: 'Proof.BIN' }],
        getAllFields: () => ({ Title: 'Alpha', UserName: 'Casey' }) });
    const filter = { text: 'alpha casey research proof.bin', textLower: 'alpha casey research proof.bin',
        textLowerParts: ['alpha', 'casey', 'research', 'proof.bin'], advanced: { title: true, user: true, metadata: true, excludeProtected: true } };
    expect(engine.matches(filter)).toBe(true);
    expect(engine.matches({ ...filter, advanced: { ...filter.advanced, metadata: false } })).toBe(false);
});
