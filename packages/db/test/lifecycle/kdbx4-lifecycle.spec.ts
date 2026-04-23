import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as kdbxweb from '../../lib';
import { argon2 } from '../test-support/argon2';

/**
 * KDBX4 Full Database Lifecycle Tests
 *
 * Tests the complete lifecycle: create -> populate -> save -> reload -> verify
 * This is the most critical test suite for the database library.
 */
describe('KDBX4 Lifecycle', () => {
    beforeAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    });

    afterAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(undefined as any);
    });

    function createCredentials(): kdbxweb.KdbxCredentials {
        return new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('test-lifecycle-password')
        );
    }

    test('creates a KDBX4 database with Argon2id + ChaCha20, populates, saves, reloads, and verifies all data', async () => {
        // --- Phase 1: Create and populate ---
        const cred = createCredentials();
        const db = kdbxweb.Kdbx.create(cred, 'LifecycleTestDB');

        // Configure KDBX4 with Argon2id + ChaCha20
        db.upgrade();
        db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
        db.header.dataCipherUuid = new kdbxweb.KdbxUuid(kdbxweb.Consts.CipherId.ChaCha20);

        // Verify initial structure
        expect(db.header.versionMajor).toBe(4);
        expect(db.meta.name).toBe('LifecycleTestDB');

        const defaultGroup = db.getDefaultGroup();
        expect(defaultGroup).toBeTruthy();

        // Add a subgroup
        const subGroup = db.createGroup(defaultGroup, 'Credentials');
        expect(subGroup.name).toBe('Credentials');

        // Add an entry with all field types
        const entry = db.createEntry(subGroup);
        entry.fields.set('Title', 'GitHub Account');
        entry.fields.set('UserName', 'testuser@example.com');
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('S3cretP@ssw0rd!'));
        entry.fields.set('URL', 'https://github.com/login');
        entry.fields.set('Notes', 'Primary GitHub account\nUsed for work repositories');

        // Add custom data to the entry
        entry.customData = new Map([
            ['otp-secret', { value: 'JBSWY3DPEHPK3PXP' }],
            ['last-rotated', { value: '2026-01-15T00:00:00Z' }]
        ]);

        // Add tags
        entry.tags = ['work', 'development'];

        // Add a binary attachment
        const attachmentContent = kdbxweb.ProtectedValue.fromString(
            'SSH private key content for testing purposes'
        );
        const binary = await db.createBinary(attachmentContent);
        entry.binaries.set('id_rsa.pub', binary);

        // Add a second entry
        const entry2 = db.createEntry(subGroup);
        entry2.fields.set('Title', 'AWS Console');
        entry2.fields.set('UserName', 'admin');
        entry2.fields.set('Password', kdbxweb.ProtectedValue.fromString('AWSp@ss123'));
        entry2.fields.set('URL', 'https://console.aws.amazon.com');
        entry2.fields.set('Notes', '');

        // Add custom plain and protected fields
        entry.fields.set('CustomPlain', 'plain-value');
        entry.fields.set(
            'CustomProtected',
            kdbxweb.ProtectedValue.fromString('protected-custom-value')
        );

        // Add custom data to the database metadata
        db.meta.customData.set('app-version', { value: '2.0.0' });
        db.meta.customData.set('created-by', { value: 'lifecycle-test' });

        // --- Phase 2: Save ---
        const savedBuffer = await db.save();
        expect(savedBuffer).toBeInstanceOf(ArrayBuffer);
        expect(savedBuffer.byteLength).toBeGreaterThan(0);

        // --- Phase 3: Reload ---
        const reloadedDb = await kdbxweb.Kdbx.load(savedBuffer, createCredentials());

        // --- Phase 4: Verify all data ---

        // Verify database metadata
        expect(reloadedDb.meta.generator).toBe('KdbxWeb');
        expect(reloadedDb.meta.name).toBe('LifecycleTestDB');
        expect(reloadedDb.header.versionMajor).toBe(4);
        expect(reloadedDb.header.dataCipherUuid!.toString()).toBe(
            kdbxweb.Consts.CipherId.ChaCha20
        );

        // Verify custom metadata
        expect(reloadedDb.meta.customData.get('app-version')?.value).toBe('2.0.0');
        expect(reloadedDb.meta.customData.get('created-by')?.value).toBe('lifecycle-test');

        // Verify group structure
        const reloadedDefault = reloadedDb.getDefaultGroup();
        expect(reloadedDefault).toBeTruthy();

        // Find the Credentials subgroup (skip the recycle bin)
        const credentialsGroup = reloadedDefault.groups.find((g) => g.name === 'Credentials');
        expect(credentialsGroup).toBeTruthy();
        expect(credentialsGroup!.entries.length).toBe(2);

        // Verify first entry
        const reloadedEntry = credentialsGroup!.entries[0];
        expect(reloadedEntry.fields.get('Title')).toBe('GitHub Account');
        expect(reloadedEntry.fields.get('UserName')).toBe('testuser@example.com');
        expect(reloadedEntry.fields.get('URL')).toBe('https://github.com/login');
        expect(reloadedEntry.fields.get('Notes')).toBe(
            'Primary GitHub account\nUsed for work repositories'
        );

        // Verify password (ProtectedValue)
        const reloadedPassword = reloadedEntry.fields.get('Password');
        expect(reloadedPassword).toBeInstanceOf(kdbxweb.ProtectedValue);
        expect((reloadedPassword as kdbxweb.ProtectedValue).getText()).toBe('S3cretP@ssw0rd!');

        // Verify custom fields
        expect(reloadedEntry.fields.get('CustomPlain')).toBe('plain-value');
        const reloadedCustomProtected = reloadedEntry.fields.get('CustomProtected');
        expect(reloadedCustomProtected).toBeInstanceOf(kdbxweb.ProtectedValue);
        expect((reloadedCustomProtected as kdbxweb.ProtectedValue).getText()).toBe(
            'protected-custom-value'
        );

        // Verify custom data on entry
        expect(reloadedEntry.customData).toBeTruthy();
        expect(reloadedEntry.customData!.get('otp-secret')?.value).toBe('JBSWY3DPEHPK3PXP');
        expect(reloadedEntry.customData!.get('last-rotated')?.value).toBe(
            '2026-01-15T00:00:00Z'
        );

        // Verify binary attachment
        expect(reloadedEntry.binaries.size).toBe(1);
        const reloadedBinaryRef = reloadedEntry.binaries.get('id_rsa.pub');
        expect(reloadedBinaryRef).toBeTruthy();

        // Resolve the binary via the entry's binary reference
        if (reloadedBinaryRef && 'hash' in reloadedBinaryRef) {
            const binaryValue = reloadedBinaryRef.value;
            expect(binaryValue).toBeTruthy();
            if (binaryValue instanceof kdbxweb.ProtectedValue) {
                expect(binaryValue.getText()).toBe(
                    'SSH private key content for testing purposes'
                );
            }
        }

        // Verify second entry
        const reloadedEntry2 = credentialsGroup!.entries[1];
        expect(reloadedEntry2.fields.get('Title')).toBe('AWS Console');
        expect(reloadedEntry2.fields.get('UserName')).toBe('admin');
        const pwd2 = reloadedEntry2.fields.get('Password');
        expect(pwd2).toBeInstanceOf(kdbxweb.ProtectedValue);
        expect((pwd2 as kdbxweb.ProtectedValue).getText()).toBe('AWSp@ss123');
        expect(reloadedEntry2.fields.get('URL')).toBe('https://console.aws.amazon.com');
    }, 30000);

    test('modifies an entry, saves, reloads, and verifies the modification persists', async () => {
        // Create and populate
        const cred = createCredentials();
        const db = kdbxweb.Kdbx.create(cred, 'ModifyTestDB');
        db.upgrade();
        db.setKdf(kdbxweb.Consts.KdfId.Argon2id);

        const group = db.getDefaultGroup();
        const entry = db.createEntry(group);
        entry.fields.set('Title', 'Original Title');
        entry.fields.set('UserName', 'original-user');
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('original-pass'));
        entry.fields.set('URL', 'https://original.example.com');

        // Save the original version
        const savedBuffer1 = await db.save();

        // Reload
        const db2 = await kdbxweb.Kdbx.load(savedBuffer1, createCredentials());
        const group2 = db2.getDefaultGroup();
        const entry2 = group2.entries[0];

        // Push history before modifying
        entry2.pushHistory();

        // Modify
        entry2.fields.set('Title', 'Modified Title');
        entry2.fields.set('UserName', 'modified-user');
        entry2.fields.set('Password', kdbxweb.ProtectedValue.fromString('modified-pass'));
        entry2.fields.set('URL', 'https://modified.example.com');
        entry2.fields.set('NewField', 'added-after-create');
        entry2.times.update();

        // Save the modified version
        const savedBuffer2 = await db2.save();

        // Reload and verify modifications
        const db3 = await kdbxweb.Kdbx.load(savedBuffer2, createCredentials());
        const group3 = db3.getDefaultGroup();
        const entry3 = group3.entries[0];

        expect(entry3.fields.get('Title')).toBe('Modified Title');
        expect(entry3.fields.get('UserName')).toBe('modified-user');
        const pwd = entry3.fields.get('Password');
        expect(pwd).toBeInstanceOf(kdbxweb.ProtectedValue);
        expect((pwd as kdbxweb.ProtectedValue).getText()).toBe('modified-pass');
        expect(entry3.fields.get('URL')).toBe('https://modified.example.com');
        expect(entry3.fields.get('NewField')).toBe('added-after-create');

        // Verify history was preserved
        expect(entry3.history.length).toBe(1);
        expect(entry3.history[0].fields.get('Title')).toBe('Original Title');
    }, 30000);

    test('deletes an entry, saves, reloads, and verifies it appears in deleted objects', async () => {
        // Create and populate
        const cred = createCredentials();
        const db = kdbxweb.Kdbx.create(cred, 'DeleteTestDB');
        db.upgrade();
        db.setKdf(kdbxweb.Consts.KdfId.Argon2id);

        // Disable recycle bin so move(entry, null) triggers addDeletedObject
        db.meta.recycleBinEnabled = false;

        const group = db.getDefaultGroup();
        const entry1 = db.createEntry(group);
        entry1.fields.set('Title', 'Keep This');
        entry1.fields.set('Password', kdbxweb.ProtectedValue.fromString('keep'));

        const entry2 = db.createEntry(group);
        entry2.fields.set('Title', 'Delete This');
        entry2.fields.set('Password', kdbxweb.ProtectedValue.fromString('delete'));
        const deletedUuid = entry2.uuid.toString();

        // Save first to establish the entry
        const savedBuffer1 = await db.save();

        // Reload and delete
        const db2 = await kdbxweb.Kdbx.load(savedBuffer1, createCredentials());
        db2.meta.recycleBinEnabled = false;
        const group2 = db2.getDefaultGroup();
        const entryToDelete = group2.entries.find(
            (e) => e.fields.get('Title') === 'Delete This'
        );
        expect(entryToDelete).toBeTruthy();

        // Delete the entry (move to null = permanent delete with deleted object tracking)
        db2.move(entryToDelete!, null);

        // Save after deletion
        const savedBuffer2 = await db2.save();

        // Reload and verify
        const db3 = await kdbxweb.Kdbx.load(savedBuffer2, createCredentials());
        const group3 = db3.getDefaultGroup();

        // The deleted entry should no longer be in the group
        expect(group3.entries.length).toBe(1);
        expect(group3.entries[0].fields.get('Title')).toBe('Keep This');

        // The deleted entry should be in deletedObjects
        const deletedObj = db3.deletedObjects.find(
            (d) => d.uuid && d.uuid.toString() === deletedUuid
        );
        expect(deletedObj).toBeTruthy();
        expect(deletedObj!.deletionTime).toBeTruthy();
    }, 30000);

    test('round-trips a database with multiple groups and nested structure', async () => {
        const cred = createCredentials();
        const db = kdbxweb.Kdbx.create(cred, 'NestedGroupsDB');
        db.upgrade();
        db.setKdf(kdbxweb.Consts.KdfId.Argon2id);

        const root = db.getDefaultGroup();

        // Create a nested structure: root -> work -> projects -> secret-project
        const work = db.createGroup(root, 'Work');
        const personal = db.createGroup(root, 'Personal');
        const projects = db.createGroup(work, 'Projects');
        const secretProject = db.createGroup(projects, 'Secret Project');

        // Add entries at various levels
        const rootEntry = db.createEntry(root);
        rootEntry.fields.set('Title', 'Root Level Entry');
        rootEntry.fields.set('Password', kdbxweb.ProtectedValue.fromString('root'));

        const workEntry = db.createEntry(work);
        workEntry.fields.set('Title', 'Work Entry');
        workEntry.fields.set('Password', kdbxweb.ProtectedValue.fromString('work'));

        const secretEntry = db.createEntry(secretProject);
        secretEntry.fields.set('Title', 'Secret Entry');
        secretEntry.fields.set('Password', kdbxweb.ProtectedValue.fromString('top-secret'));

        const personalEntry = db.createEntry(personal);
        personalEntry.fields.set('Title', 'Personal Entry');
        personalEntry.fields.set('Password', kdbxweb.ProtectedValue.fromString('personal'));

        // Save and reload
        const savedBuffer = await db.save();
        const db2 = await kdbxweb.Kdbx.load(savedBuffer, createCredentials());

        const root2 = db2.getDefaultGroup();

        // Verify root entries
        const rootEntries = root2.entries.filter(
            (e) => e.fields.get('Title') === 'Root Level Entry'
        );
        expect(rootEntries.length).toBe(1);

        // Find work group (skip recycle bin)
        const work2 = root2.groups.find((g) => g.name === 'Work');
        expect(work2).toBeTruthy();
        expect(work2!.entries.length).toBe(1);
        expect(work2!.entries[0].fields.get('Title')).toBe('Work Entry');

        // Find projects -> secret project
        const projects2 = work2!.groups.find((g) => g.name === 'Projects');
        expect(projects2).toBeTruthy();
        const secret2 = projects2!.groups.find((g) => g.name === 'Secret Project');
        expect(secret2).toBeTruthy();
        expect(secret2!.entries.length).toBe(1);
        expect(secret2!.entries[0].fields.get('Title')).toBe('Secret Entry');

        // Find personal group
        const personal2 = root2.groups.find((g) => g.name === 'Personal');
        expect(personal2).toBeTruthy();
        expect(personal2!.entries.length).toBe(1);
        expect(personal2!.entries[0].fields.get('Title')).toBe('Personal Entry');
    }, 30000);

    test('preserves multiple binary attachments across save/reload', async () => {
        const cred = createCredentials();
        const db = kdbxweb.Kdbx.create(cred, 'BinaryTestDB');
        db.upgrade();
        db.setKdf(kdbxweb.Consts.KdfId.Argon2id);

        const group = db.getDefaultGroup();
        const entry = db.createEntry(group);
        entry.fields.set('Title', 'Entry With Binaries');
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('pass'));

        // Add two different binary attachments
        const bin1 = await db.createBinary(
            kdbxweb.ProtectedValue.fromString('Content of file 1')
        );
        entry.binaries.set('file1.txt', bin1);

        const bin2Data = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            bin2Data[i] = i;
        }
        const bin2 = await db.createBinary(kdbxweb.ByteUtils.arrayToBuffer(bin2Data));
        entry.binaries.set('binary.dat', bin2);

        // Save and reload
        const savedBuffer = await db.save();
        const db2 = await kdbxweb.Kdbx.load(savedBuffer, createCredentials());

        const entry2 = db2.getDefaultGroup().entries[0];
        expect(entry2.binaries.size).toBe(2);

        // Verify file1.txt
        const ref1 = entry2.binaries.get('file1.txt');
        expect(ref1).toBeTruthy();

        // Verify binary.dat
        const ref2 = entry2.binaries.get('binary.dat');
        expect(ref2).toBeTruthy();
    }, 30000);
});
