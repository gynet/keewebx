/**
 * Golden file regression tests.
 *
 * For each .kdbx file in resources/ (internal test databases):
 *   1. Load the database with known credentials
 *   2. Save it
 *   3. Reload the saved output
 *   4. Field-by-field verify all data is preserved
 *
 * This catches regressions where a code change silently alters
 * the save output or loses data during serialization.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as kdbxweb from '../../lib';
import { argon2 } from '../test-support/argon2';

const RESOURCES_DIR = path.join(__dirname, '../../resources');

function readResource(name: string): ArrayBuffer {
    const filePath = path.join(RESOURCES_DIR, name);
    const content = fs.readFileSync(filePath);
    return kdbxweb.ByteUtils.arrayToBuffer(new Uint8Array(content));
}

/** Get field value as string regardless of plain or protected */
function fieldText(field: kdbxweb.KdbxEntryField | undefined): string {
    if (field === undefined || field === null) return '';
    if (field instanceof kdbxweb.ProtectedValue) return field.getText();
    return field;
}

/** Deep compare two entries field by field */
function compareEntries(
    original: kdbxweb.KdbxEntry,
    reloaded: kdbxweb.KdbxEntry,
    label: string
) {
    // Compare all fields
    for (const [key, value] of original.fields) {
        const reloadedValue = reloaded.fields.get(key);
        expect(fieldText(reloadedValue)).toBe(fieldText(value));
    }

    // Verify no extra fields added
    expect(reloaded.fields.size).toBe(original.fields.size);

    // Compare icon
    expect(reloaded.icon).toBe(original.icon);

    // Compare tags
    expect(reloaded.tags).toEqual(original.tags);

    // Compare binary count
    expect(reloaded.binaries.size).toBe(original.binaries.size);

    // Compare binary keys
    for (const key of original.binaries.keys()) {
        expect(reloaded.binaries.has(key)).toBe(true);
    }

    // Compare history length
    expect(reloaded.history.length).toBe(original.history.length);

    // Compare auto-type settings
    expect(reloaded.autoType.enabled).toBe(original.autoType.enabled);
    expect(reloaded.autoType.obfuscation).toBe(original.autoType.obfuscation);
    expect(reloaded.autoType.items.length).toBe(original.autoType.items.length);
}

/** Deep compare two groups */
function compareGroups(
    original: kdbxweb.KdbxGroup,
    reloaded: kdbxweb.KdbxGroup,
    label: string
) {
    expect(reloaded.name).toBe(original.name);
    expect(reloaded.icon).toBe(original.icon);
    expect(reloaded.entries.length).toBe(original.entries.length);
    expect(reloaded.groups.length).toBe(original.groups.length);

    // Recursively compare sub-groups
    for (let i = 0; i < original.groups.length; i++) {
        compareGroups(
            original.groups[i],
            reloaded.groups[i],
            `${label}/${original.groups[i].name}`
        );
    }

    // Compare entries
    for (let i = 0; i < original.entries.length; i++) {
        const entryLabel = `${label}/entry[${fieldText(original.entries[i].fields.get('Title'))}]`;
        compareEntries(original.entries[i], reloaded.entries[i], entryLabel);
    }
}

/** Full golden file comparison for a database */
function verifyGoldenFile(original: kdbxweb.Kdbx, reloaded: kdbxweb.Kdbx) {
    // Meta fields
    // Note: undefined vs "" is an acceptable difference after XML round-trip
    expect(reloaded.meta.name).toBe(original.meta.name);
    expect(reloaded.meta.desc || '').toBe(original.meta.desc || '');
    expect(reloaded.meta.defaultUser || '').toBe(original.meta.defaultUser || '');
    expect(reloaded.meta.recycleBinEnabled).toBe(original.meta.recycleBinEnabled);
    expect(reloaded.meta.historyMaxItems).toBe(original.meta.historyMaxItems);
    expect(reloaded.meta.historyMaxSize).toBe(original.meta.historyMaxSize);

    // Memory protection
    expect(reloaded.meta.memoryProtection.title).toBe(original.meta.memoryProtection.title);
    expect(reloaded.meta.memoryProtection.userName).toBe(
        original.meta.memoryProtection.userName
    );
    expect(reloaded.meta.memoryProtection.password).toBe(
        original.meta.memoryProtection.password
    );
    expect(reloaded.meta.memoryProtection.url).toBe(original.meta.memoryProtection.url);
    expect(reloaded.meta.memoryProtection.notes).toBe(original.meta.memoryProtection.notes);

    // Custom icons
    expect(reloaded.meta.customIcons.size).toBe(original.meta.customIcons.size);

    // Deleted objects
    expect(reloaded.deletedObjects.length).toBe(original.deletedObjects.length);

    // Group tree
    expect(reloaded.groups.length).toBe(original.groups.length);
    for (let i = 0; i < original.groups.length; i++) {
        compareGroups(original.groups[i], reloaded.groups[i], original.groups[i].name || 'root');
    }
}

describe('golden file regression', () => {
    beforeAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    });

    afterAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(undefined as any);
    });

    // Credentials for internal test databases
    const demoCredentials = () =>
        new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            readResource('demo.key')
        );

    // ---------------------------------------------------------------
    // Argon2.kdbx — Argon2d KDF + AES cipher
    // ---------------------------------------------------------------
    test('Argon2.kdbx golden file', async () => {
        const cred = demoCredentials();
        const db1 = await kdbxweb.Kdbx.load(readResource('Argon2.kdbx'), cred);

        const saved = await db1.save();
        const db2 = await kdbxweb.Kdbx.load(saved, cred);

        verifyGoldenFile(db1, db2);
    }, 30000);

    // ---------------------------------------------------------------
    // Argon2id.kdbx — Argon2id KDF + AES cipher
    // ---------------------------------------------------------------
    test('Argon2id.kdbx golden file', async () => {
        const cred = demoCredentials();
        const db1 = await kdbxweb.Kdbx.load(readResource('Argon2id.kdbx'), cred);

        const saved = await db1.save();
        const db2 = await kdbxweb.Kdbx.load(saved, cred);

        verifyGoldenFile(db1, db2);
    }, 30000);

    // ---------------------------------------------------------------
    // Argon2ChaCha.kdbx — Argon2d KDF + ChaCha20 cipher
    // ---------------------------------------------------------------
    test('Argon2ChaCha.kdbx golden file', async () => {
        const cred = demoCredentials();
        const db1 = await kdbxweb.Kdbx.load(
            readResource('Argon2ChaCha.kdbx'),
            cred
        );

        const saved = await db1.save();
        const db2 = await kdbxweb.Kdbx.load(saved, cred);

        verifyGoldenFile(db1, db2);
    }, 30000);

    // ---------------------------------------------------------------
    // KDBX4.1.kdbx — KDBX 4.1 features (tags, previousParentGroup, etc.)
    // ---------------------------------------------------------------
    test('KDBX4.1.kdbx golden file', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('test')
        );
        const db1 = await kdbxweb.Kdbx.load(readResource('KDBX4.1.kdbx'), cred);

        const saved = await db1.save();
        const db2 = await kdbxweb.Kdbx.load(saved, cred);

        verifyGoldenFile(db1, db2);

        // Verify KDBX 4.1-specific features survive round-trip
        const groupWithTags = db2.groups[0].groups[0].groups[0];
        expect(groupWithTags.name).toBe('With tags');
        expect(groupWithTags.tags).toEqual(['Another tag', 'Tag1']);
    }, 30000);

    // ---------------------------------------------------------------
    // Newly created database golden test
    // ---------------------------------------------------------------
    test('newly created database golden file', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('golden-test')
        );
        const db1 = kdbxweb.Kdbx.create(cred, 'GoldenDB');
        db1.upgrade();
        db1.setKdf(kdbxweb.Consts.KdfId.Argon2id);

        // Add groups
        const subGroup = db1.createGroup(db1.getDefaultGroup(), 'SubGroup');
        const deepGroup = db1.createGroup(subGroup, 'DeepGroup');

        // Add entries with various field types
        const entry1 = db1.createEntry(db1.getDefaultGroup());
        entry1.fields.set('Title', 'Test Entry 1');
        entry1.fields.set('UserName', 'user1');
        entry1.fields.set('Password', kdbxweb.ProtectedValue.fromString('pass1'));
        entry1.fields.set('URL', 'https://example.com');
        entry1.fields.set('Notes', 'Notes with\nnewlines');
        entry1.fields.set('CustomField', 'custom value');

        const entry2 = db1.createEntry(subGroup);
        entry2.fields.set('Title', 'Test Entry 2');
        entry2.fields.set('UserName', 'user2');
        entry2.fields.set('Password', kdbxweb.ProtectedValue.fromString('pass2'));

        const entry3 = db1.createEntry(deepGroup);
        entry3.fields.set('Title', 'Deep Entry');
        entry3.fields.set('Password', kdbxweb.ProtectedValue.fromString('deep'));

        // Add history
        entry1.pushHistory();
        entry1.fields.set('Title', 'Test Entry 1 (updated)');

        // Add binary
        const bin = await db1.createBinary(
            kdbxweb.ProtectedValue.fromString('file content here')
        );
        entry1.binaries.set('test.txt', bin);

        // Save and reload
        const saved = await db1.save();
        const db2 = await kdbxweb.Kdbx.load(saved, cred);

        verifyGoldenFile(db1, db2);

        // Verify specific values survived
        const root2 = db2.getDefaultGroup();
        expect(root2.entries[0].fields.get('Title')).toBe('Test Entry 1 (updated)');
        expect(
            (root2.entries[0].fields.get('Password') as kdbxweb.ProtectedValue).getText()
        ).toBe('pass1');
        expect(root2.entries[0].history.length).toBe(1);
        expect(root2.entries[0].binaries.size).toBe(1);
        expect(root2.groups[1].name).toBe('SubGroup');
        expect(root2.groups[1].entries[0].fields.get('Title')).toBe('Test Entry 2');
        expect(root2.groups[1].groups[0].name).toBe('DeepGroup');
        expect(root2.groups[1].groups[0].entries[0].fields.get('Title')).toBe('Deep Entry');
    }, 30000);
});
