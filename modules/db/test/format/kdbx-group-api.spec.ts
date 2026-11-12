/**
 * KdbxGroup API tests.
 *
 * Comprehensive tests for group hierarchy operations:
 * - Create groups and sub-groups
 * - Nested group hierarchies
 * - Move groups between parents
 * - Delete groups (to recycle bin and permanently)
 * - Group properties (name, icon, notes, enableAutoType, enableSearching)
 * - allGroups(), allEntries(), allGroupsAndEntries() iterators
 * - Group round-trip through save/reload
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as kdbxweb from '../../lib';
import { argon2 } from '../test-support/argon2';

describe('KdbxGroup API', () => {
    beforeAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    });

    afterAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(undefined as any);
    });

    function createDb(name = 'TestDB'): kdbxweb.Kdbx {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('test')
        );
        const db = kdbxweb.Kdbx.create(cred, name);
        db.upgrade();
        db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
        return db;
    }

    function createCred(): kdbxweb.KdbxCredentials {
        return new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('test')
        );
    }

    // ---------------------------------------------------------------
    // Group creation
    // ---------------------------------------------------------------

    describe('group creation', () => {
        test('database has a default group', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            expect(root).toBeTruthy();
            expect(root.name).toBe('TestDB');
        });

        test('creates sub-group', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            const sub = db.createGroup(root, 'SubGroup');

            expect(sub.name).toBe('SubGroup');
            expect(sub.parentGroup).toBe(root);
            expect(root.groups).toContain(sub);
        });

        test('creates nested sub-groups', () => {
            const db = createDb();
            const root = db.getDefaultGroup();

            const level1 = db.createGroup(root, 'Level 1');
            const level2 = db.createGroup(level1, 'Level 2');
            const level3 = db.createGroup(level2, 'Level 3');

            expect(level1.parentGroup).toBe(root);
            expect(level2.parentGroup).toBe(level1);
            expect(level3.parentGroup).toBe(level2);
            expect(level3.name).toBe('Level 3');
        });

        test('creates multiple sibling groups', () => {
            const db = createDb();
            const root = db.getDefaultGroup();

            const g1 = db.createGroup(root, 'Group A');
            const g2 = db.createGroup(root, 'Group B');
            const g3 = db.createGroup(root, 'Group C');

            // Root has recycle bin + 3 new groups
            const nonRecycleBin = root.groups.filter(
                (g) => g.name !== kdbxweb.Consts.Defaults.RecycleBinName
            );
            expect(nonRecycleBin.length).toBe(3);
            expect(nonRecycleBin.map((g) => g.name)).toEqual([
                'Group A',
                'Group B',
                'Group C'
            ]);
        });

        test('new group has a UUID', () => {
            const db = createDb();
            const group = db.createGroup(db.getDefaultGroup(), 'WithUUID');
            expect(group.uuid).toBeTruthy();
            expect(group.uuid.empty).toBe(false);
        });

        test('new group has default icon', () => {
            const db = createDb();
            const group = db.createGroup(db.getDefaultGroup(), 'WithIcon');
            expect(group.icon).toBe(kdbxweb.Consts.Icons.Folder);
        });
    });

    // ---------------------------------------------------------------
    // Group properties
    // ---------------------------------------------------------------

    describe('group properties', () => {
        test('sets and gets name', () => {
            const db = createDb();
            const group = db.createGroup(db.getDefaultGroup(), 'Original');
            group.name = 'Renamed';
            expect(group.name).toBe('Renamed');
        });

        test('sets and gets notes', () => {
            const db = createDb();
            const group = db.createGroup(db.getDefaultGroup(), 'WithNotes');
            group.notes = 'These are group notes';
            expect(group.notes).toBe('These are group notes');
        });

        test('sets and gets icon', () => {
            const db = createDb();
            const group = db.createGroup(db.getDefaultGroup(), 'CustomIcon');
            group.icon = kdbxweb.Consts.Icons.NetworkServer;
            expect(group.icon).toBe(kdbxweb.Consts.Icons.NetworkServer);
        });

        test('sets enableAutoType', () => {
            const db = createDb();
            const group = db.createGroup(db.getDefaultGroup(), 'NoAutoType');
            group.enableAutoType = false;
            expect(group.enableAutoType).toBe(false);
        });

        test('sets enableSearching', () => {
            const db = createDb();
            const group = db.createGroup(db.getDefaultGroup(), 'NoSearch');
            group.enableSearching = false;
            expect(group.enableSearching).toBe(false);
        });

        test('sets expanded state', () => {
            const db = createDb();
            const group = db.createGroup(db.getDefaultGroup(), 'Collapsed');
            group.expanded = false;
            expect(group.expanded).toBe(false);
        });

        test('group properties survive save/reload', async () => {
            const db = createDb();
            const group = db.createGroup(db.getDefaultGroup(), 'PropsGroup');
            group.notes = 'Group notes here';
            group.icon = kdbxweb.Consts.Icons.Star;
            group.enableAutoType = false;
            group.enableSearching = false;
            group.expanded = false;

            // Add an entry so the group is not empty
            const entry = db.createEntry(group);
            entry.fields.set('Title', 'In Group');
            entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('p'));

            const saved = await db.save();
            const db2 = await kdbxweb.Kdbx.load(saved, createCred());

            // Find the group (skip recycle bin)
            const reloadedGroup = db2
                .getDefaultGroup()
                .groups.find((g) => g.name === 'PropsGroup');
            expect(reloadedGroup).toBeTruthy();
            expect(reloadedGroup!.notes).toBe('Group notes here');
            expect(reloadedGroup!.icon).toBe(kdbxweb.Consts.Icons.Star);
            expect(reloadedGroup!.enableAutoType).toBe(false);
            expect(reloadedGroup!.enableSearching).toBe(false);
            expect(reloadedGroup!.expanded).toBe(false);
            expect(reloadedGroup!.entries.length).toBe(1);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // Group hierarchy traversal
    // ---------------------------------------------------------------

    describe('hierarchy traversal', () => {
        test('allGroups() yields all descendant groups', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            const g1 = db.createGroup(root, 'G1');
            const g2 = db.createGroup(g1, 'G2');
            db.createGroup(g2, 'G3');

            const allGroups = [...root.allGroups()];
            const names = allGroups.map((g) => g.name);

            expect(names).toContain('TestDB'); // root
            expect(names).toContain('G1');
            expect(names).toContain('G2');
            expect(names).toContain('G3');
            expect(names).toContain(kdbxweb.Consts.Defaults.RecycleBinName);
        });

        test('allEntries() yields all entries in all groups', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            const sub = db.createGroup(root, 'Sub');

            const e1 = db.createEntry(root);
            e1.fields.set('Title', 'Root Entry');
            const e2 = db.createEntry(sub);
            e2.fields.set('Title', 'Sub Entry');

            const allEntries = [...root.allEntries()];
            expect(allEntries.length).toBe(2);

            const titles = allEntries.map((e) => e.fields.get('Title'));
            expect(titles).toContain('Root Entry');
            expect(titles).toContain('Sub Entry');
        });

        test('allGroupsAndEntries() yields everything', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            const sub = db.createGroup(root, 'Sub');

            const e1 = db.createEntry(root);
            e1.fields.set('Title', 'E1');
            const e2 = db.createEntry(sub);
            e2.fields.set('Title', 'E2');

            const all = [...root.allGroupsAndEntries()];

            // Should include root, recycle bin, sub group, and 2 entries
            const groups = all.filter((x) => x instanceof kdbxweb.KdbxGroup);
            const entries = all.filter((x) => x instanceof kdbxweb.KdbxEntry);

            expect(groups.length).toBeGreaterThanOrEqual(3); // root + recycle + sub
            expect(entries.length).toBe(2);
        });
    });

    // ---------------------------------------------------------------
    // Move operations
    // ---------------------------------------------------------------

    describe('move operations', () => {
        test('moves entry between groups', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            const g1 = db.createGroup(root, 'Source');
            const g2 = db.createGroup(root, 'Target');

            const entry = db.createEntry(g1);
            entry.fields.set('Title', 'Mobile Entry');

            expect(g1.entries.length).toBe(1);
            expect(g2.entries.length).toBe(0);

            db.move(entry, g2);

            expect(g1.entries.length).toBe(0);
            expect(g2.entries.length).toBe(1);
            expect(g2.entries[0].fields.get('Title')).toBe('Mobile Entry');
        });

        test('moves group between parents', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            const g1 = db.createGroup(root, 'Parent1');
            const g2 = db.createGroup(root, 'Parent2');
            const child = db.createGroup(g1, 'Child');

            expect(g1.groups.length).toBe(1);
            expect(g2.groups.length).toBe(0);

            db.move(child, g2);

            expect(g1.groups.length).toBe(0);
            expect(g2.groups.length).toBe(1);
            expect(g2.groups[0].name).toBe('Child');
        });

        test('move updates parentGroup', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            const g1 = db.createGroup(root, 'G1');
            const g2 = db.createGroup(root, 'G2');
            const entry = db.createEntry(g1);

            expect(entry.parentGroup).toBe(g1);
            db.move(entry, g2);
            expect(entry.parentGroup).toBe(g2);
        });

        test('move to null deletes the entry', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            const entry = db.createEntry(root);
            entry.fields.set('Title', 'To Delete');

            const initialCount = root.entries.length;
            db.move(entry, null);

            expect(root.entries.length).toBe(initialCount - 1);
            expect(db.deletedObjects.length).toBeGreaterThan(0);
        });
    });

    // ---------------------------------------------------------------
    // Delete operations
    // ---------------------------------------------------------------

    describe('delete operations', () => {
        test('remove() moves entry to recycle bin when enabled', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            const entry = db.createEntry(root);
            entry.fields.set('Title', 'Recycle Me');

            db.remove(entry);

            expect(root.entries).not.toContain(entry);

            // Check recycle bin
            const recycleBin = db.getGroup(db.meta.recycleBinUuid!);
            expect(recycleBin).toBeTruthy();
            expect(recycleBin!.entries).toContain(entry);
        });

        test('remove() moves group to recycle bin', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            const group = db.createGroup(root, 'Deletable');

            db.remove(group);

            const nonRecycleBin = root.groups.filter(
                (g) => g.name !== kdbxweb.Consts.Defaults.RecycleBinName
            );
            expect(nonRecycleBin.find((g) => g.name === 'Deletable')).toBeFalsy();

            const recycleBin = db.getGroup(db.meta.recycleBinUuid!);
            expect(recycleBin).toBeTruthy();
            expect(recycleBin!.groups.find((g) => g.name === 'Deletable')).toBeTruthy();
        });

        test('remove() with recycle bin disabled permanently deletes', () => {
            const db = createDb();
            db.meta.recycleBinEnabled = false;
            db.meta.recycleBinUuid = undefined;

            const root = db.getDefaultGroup();
            const entry = db.createEntry(root);
            const entryUuid = entry.uuid.id;

            db.remove(entry);

            expect(root.entries).not.toContain(entry);
            // Should have added a deleted object record
            expect(
                db.deletedObjects.some((d) => d.uuid.id === entryUuid)
            ).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // getGroup
    // ---------------------------------------------------------------

    describe('getGroup', () => {
        test('finds group by UUID', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            const sub = db.createGroup(root, 'FindMe');

            const found = db.getGroup(sub.uuid);
            expect(found).toBe(sub);
        });

        test('finds deeply nested group', () => {
            const db = createDb();
            const root = db.getDefaultGroup();
            const g1 = db.createGroup(root, 'L1');
            const g2 = db.createGroup(g1, 'L2');
            const g3 = db.createGroup(g2, 'L3');

            const found = db.getGroup(g3.uuid);
            expect(found).toBe(g3);
        });

        test('returns undefined for non-existent UUID', () => {
            const db = createDb();
            const fakeUuid = kdbxweb.KdbxUuid.random();
            const found = db.getGroup(fakeUuid);
            expect(found).toBeUndefined();
        });
    });

    // ---------------------------------------------------------------
    // Recycle bin
    // ---------------------------------------------------------------

    describe('recycle bin', () => {
        test('creates recycle bin automatically', () => {
            const db = createDb();
            expect(db.meta.recycleBinEnabled).toBe(true);
            expect(db.meta.recycleBinUuid).toBeTruthy();

            const recycleBin = db.getGroup(db.meta.recycleBinUuid!);
            expect(recycleBin).toBeTruthy();
            expect(recycleBin!.name).toBe(kdbxweb.Consts.Defaults.RecycleBinName);
        });

        test('recycle bin has auto-type and searching disabled', () => {
            const db = createDb();
            const recycleBin = db.getGroup(db.meta.recycleBinUuid!);
            expect(recycleBin!.enableAutoType).toBe(false);
            expect(recycleBin!.enableSearching).toBe(false);
        });

        test('recycle bin has trash icon', () => {
            const db = createDb();
            const recycleBin = db.getGroup(db.meta.recycleBinUuid!);
            expect(recycleBin!.icon).toBe(kdbxweb.Consts.Icons.TrashBin);
        });
    });

    // ---------------------------------------------------------------
    // Group hierarchy save/reload
    // ---------------------------------------------------------------

    describe('hierarchy save/reload', () => {
        test('complex hierarchy survives round-trip', async () => {
            const db = createDb('HierarchyTest');
            const root = db.getDefaultGroup();

            // Build: root -> (A -> (A1, A2), B -> (B1 -> (B1a)))
            const a = db.createGroup(root, 'A');
            db.createGroup(a, 'A1');
            db.createGroup(a, 'A2');

            const b = db.createGroup(root, 'B');
            const b1 = db.createGroup(b, 'B1');
            db.createGroup(b1, 'B1a');

            // Add entries at various levels
            const re = db.createEntry(root);
            re.fields.set('Title', 'Root Entry');
            re.fields.set('Password', kdbxweb.ProtectedValue.fromString('p'));

            const ae = db.createEntry(a);
            ae.fields.set('Title', 'A Entry');
            ae.fields.set('Password', kdbxweb.ProtectedValue.fromString('p'));

            const b1ae = db.createEntry(b1);
            b1ae.fields.set('Title', 'B1a Entry');
            b1ae.fields.set('Password', kdbxweb.ProtectedValue.fromString('p'));

            const saved = await db.save();
            const db2 = await kdbxweb.Kdbx.load(saved, createCred());
            const root2 = db2.getDefaultGroup();

            // Verify structure
            const allNames = [...root2.allGroups()].map((g) => g.name);
            expect(allNames).toContain('A');
            expect(allNames).toContain('A1');
            expect(allNames).toContain('A2');
            expect(allNames).toContain('B');
            expect(allNames).toContain('B1');
            expect(allNames).toContain('B1a');

            // Verify entries
            const allEntryTitles = [...root2.allEntries()].map((e) =>
                e.fields.get('Title')
            );
            expect(allEntryTitles).toContain('Root Entry');
            expect(allEntryTitles).toContain('A Entry');
            expect(allEntryTitles).toContain('B1a Entry');
        }, 30000);
    });

    // ---------------------------------------------------------------
    // Group copyFrom
    // ---------------------------------------------------------------

    describe('copyFrom', () => {
        test('copies group properties', () => {
            const db = createDb();
            const original = db.createGroup(db.getDefaultGroup(), 'Original');
            original.notes = 'original notes';
            original.icon = kdbxweb.Consts.Icons.Star;
            original.enableAutoType = false;

            const copy = new kdbxweb.KdbxGroup();
            copy.copyFrom(original);

            expect(copy.name).toBe('Original');
            expect(copy.notes).toBe('original notes');
            expect(copy.icon).toBe(kdbxweb.Consts.Icons.Star);
            expect(copy.enableAutoType).toBe(false);
            expect(copy.uuid.id).toBe(original.uuid.id);
        });
    });

    // ---------------------------------------------------------------
    // Group tags (KDBX 4.1)
    // ---------------------------------------------------------------

    describe('group tags (KDBX 4.1)', () => {
        test('sets and gets group tags', () => {
            const db = createDb();
            const group = db.createGroup(db.getDefaultGroup(), 'Tagged');
            group.tags = ['tag1', 'tag2', 'important'];
            expect(group.tags).toEqual(['tag1', 'tag2', 'important']);
        });
    });
});
