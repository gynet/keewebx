/**
 * Round-trip compatibility tests.
 *
 * For each supported external KDBX4 file:
 *   1. Load the database
 *   2. Save it (re-encrypting with our implementation)
 *   3. Reload the saved output
 *   4. Verify all data is intact (entries, groups, fields, binaries)
 *
 * This ensures our save path produces files that our load path can read,
 * and that no data is lost or corrupted during the round-trip.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as kdbxweb from '../../lib';
import { argon2 } from '../test-support/argon2';

const EXTERNAL_DIR = path.join(__dirname, '../../resources/external');

function readFile(...segments: string[]): ArrayBuffer {
    const filePath = path.join(EXTERNAL_DIR, ...segments);
    const content = fs.readFileSync(filePath);
    return kdbxweb.ByteUtils.arrayToBuffer(new Uint8Array(content));
}

/** Collect all entries from a database into a flat map keyed by UUID */
function collectEntries(db: kdbxweb.Kdbx): Map<string, kdbxweb.KdbxEntry> {
    const map = new Map<string, kdbxweb.KdbxEntry>();
    for (const entry of db.getDefaultGroup().allEntries()) {
        map.set(entry.uuid.id, entry);
    }
    return map;
}

/** Collect all groups from a database into a flat map keyed by UUID */
function collectGroups(db: kdbxweb.Kdbx): Map<string, kdbxweb.KdbxGroup> {
    const map = new Map<string, kdbxweb.KdbxGroup>();
    for (const group of db.getDefaultGroup().allGroups()) {
        map.set(group.uuid.id, group);
    }
    return map;
}

/** Get field value as string regardless of plain or protected */
function fieldAsString(field: kdbxweb.KdbxEntryField | undefined): string | undefined {
    if (field === undefined || field === null) return undefined;
    if (field instanceof kdbxweb.ProtectedValue) return field.getText();
    return field;
}

/** Verify all entries match between two databases */
function verifyEntriesMatch(
    original: Map<string, kdbxweb.KdbxEntry>,
    reloaded: Map<string, kdbxweb.KdbxEntry>
) {
    expect(reloaded.size).toBe(original.size);

    for (const [uuid, origEntry] of original) {
        const reloadedEntry = reloaded.get(uuid);
        expect(reloadedEntry).toBeTruthy();
        if (!reloadedEntry) continue;

        // Verify all fields
        for (const [key, value] of origEntry.fields) {
            const reloadedValue = reloadedEntry.fields.get(key);
            expect(fieldAsString(reloadedValue)).toBe(fieldAsString(value));
        }

        // Verify binary count matches
        expect(reloadedEntry.binaries.size).toBe(origEntry.binaries.size);

        // Verify history length
        expect(reloadedEntry.history.length).toBe(origEntry.history.length);
    }
}

/** Verify all groups match between two databases */
function verifyGroupsMatch(
    original: Map<string, kdbxweb.KdbxGroup>,
    reloaded: Map<string, kdbxweb.KdbxGroup>
) {
    expect(reloaded.size).toBe(original.size);

    for (const [uuid, origGroup] of original) {
        const reloadedGroup = reloaded.get(uuid);
        expect(reloadedGroup).toBeTruthy();
        if (!reloadedGroup) continue;

        expect(reloadedGroup.name).toBe(origGroup.name);
        expect(reloadedGroup.entries.length).toBe(origGroup.entries.length);
        expect(reloadedGroup.groups.length).toBe(origGroup.groups.length);
    }
}

describe('round-trip compatibility', () => {
    beforeAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    });

    afterAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(undefined as any);
    });

    // ---------------------------------------------------------------
    // KeePassXC files
    // ---------------------------------------------------------------

    test('Format400.kdbx round-trip preserves all data', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('t')
        );
        const db1 = await kdbxweb.Kdbx.load(
            readFile('keepassxc', 'Format400.kdbx'),
            cred
        );

        const entries1 = collectEntries(db1);
        const groups1 = collectGroups(db1);

        const saved = await db1.save();
        const db2 = await kdbxweb.Kdbx.load(saved, cred);

        const entries2 = collectEntries(db2);
        const groups2 = collectGroups(db2);

        verifyEntriesMatch(entries1, entries2);
        verifyGroupsMatch(groups1, groups2);

        // Verify meta
        expect(db2.meta.name).toBe(db1.meta.name);
    }, 30000);

    test('NewDatabaseBrowser.kdbx round-trip preserves all data', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('a')
        );
        const db1 = await kdbxweb.Kdbx.load(
            readFile('keepassxc', 'NewDatabaseBrowser.kdbx'),
            cred
        );

        const entries1 = collectEntries(db1);
        const groups1 = collectGroups(db1);

        const saved = await db1.save();
        const db2 = await kdbxweb.Kdbx.load(saved, cred);

        const entries2 = collectEntries(db2);
        const groups2 = collectGroups(db2);

        verifyEntriesMatch(entries1, entries2);
        verifyGroupsMatch(groups1, groups2);
    }, 30000);

    // ---------------------------------------------------------------
    // pykeepass files (password-only variants for simpler cred setup)
    // ---------------------------------------------------------------

    // The uncompressed pykeepass files use Argon2d with 64MB + 18 iterations,
    // which is slow in the WASM test module. Need a longer timeout for
    // the round-trip (load + save + reload = 3 Argon2 invocations).
    test('test4_aes_uncompressed.kdbx round-trip', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('password')
        );
        const db1 = await kdbxweb.Kdbx.load(
            readFile('pykeepass', 'test4_aes_uncompressed.kdbx'),
            cred
        );

        const entries1 = collectEntries(db1);
        const groups1 = collectGroups(db1);

        const saved = await db1.save();
        const db2 = await kdbxweb.Kdbx.load(saved, cred);

        verifyEntriesMatch(entries1, collectEntries(db2));
        verifyGroupsMatch(groups1, collectGroups(db2));
    }, 120000);

    test('test4_chacha20_uncompressed.kdbx round-trip', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('password')
        );
        const db1 = await kdbxweb.Kdbx.load(
            readFile('pykeepass', 'test4_chacha20_uncompressed.kdbx'),
            cred
        );

        const entries1 = collectEntries(db1);
        const groups1 = collectGroups(db1);

        const saved = await db1.save();
        const db2 = await kdbxweb.Kdbx.load(saved, cred);

        verifyEntriesMatch(entries1, collectEntries(db2));
        verifyGroupsMatch(groups1, collectGroups(db2));
    }, 120000);

    test('test4_argon2id.kdbx round-trip', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('password')
        );
        const db1 = await kdbxweb.Kdbx.load(
            readFile('pykeepass', 'test4_argon2id.kdbx'),
            cred
        );

        const entries1 = collectEntries(db1);
        const groups1 = collectGroups(db1);

        const saved = await db1.save();
        const db2 = await kdbxweb.Kdbx.load(saved, cred);

        verifyEntriesMatch(entries1, collectEntries(db2));
        verifyGroupsMatch(groups1, collectGroups(db2));
    }, 30000);

    test('test4.kdbx round-trip (password+keyfile)', async () => {
        const keyFileData = readFile('pykeepass', 'test4.key');
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('password'),
            keyFileData
        );
        const db1 = await kdbxweb.Kdbx.load(
            readFile('pykeepass', 'test4.kdbx'),
            cred
        );

        const entries1 = collectEntries(db1);
        const groups1 = collectGroups(db1);

        const saved = await db1.save();
        const db2 = await kdbxweb.Kdbx.load(saved, cred);

        verifyEntriesMatch(entries1, collectEntries(db2));
        verifyGroupsMatch(groups1, collectGroups(db2));
    }, 30000);

    // ---------------------------------------------------------------
    // Internal test databases
    // ---------------------------------------------------------------

    test('Argon2.kdbx round-trip (internal)', async () => {
        const demoKey = readFile('..', '..', 'resources', 'demo.key');
        // Actually use the correct path for internal resources
        const argon2File = path.join(__dirname, '../../resources/Argon2.kdbx');
        const data = kdbxweb.ByteUtils.arrayToBuffer(
            new Uint8Array(fs.readFileSync(argon2File))
        );
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            kdbxweb.ByteUtils.arrayToBuffer(
                new Uint8Array(fs.readFileSync(path.join(__dirname, '../../resources/demo.key')))
            )
        );

        const db1 = await kdbxweb.Kdbx.load(data, cred);
        const entries1 = collectEntries(db1);
        const groups1 = collectGroups(db1);

        const saved = await db1.save();
        const db2 = await kdbxweb.Kdbx.load(saved, cred);

        verifyEntriesMatch(entries1, collectEntries(db2));
        verifyGroupsMatch(groups1, collectGroups(db2));

        // Verify specific meta fields
        expect(db2.meta.name).toBe('demo');
        expect(db2.meta.generator).toBe('KdbxWeb');
    }, 30000);
});
