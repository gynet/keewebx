/**
 * KdbxEntry API tests.
 *
 * Comprehensive tests for all entry field operations:
 * - Standard fields (Title, UserName, Password, URL, Notes)
 * - Custom fields (plain and protected)
 * - Binary attachments
 * - History management (push, remove)
 * - Auto-type configuration
 * - Entry copy
 * - Tags, icons, colors
 * - Field round-trip through save/reload
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as kdbxweb from '../../lib';
import { argon2 } from '../test-support/argon2';

describe('KdbxEntry API', () => {
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
    // Standard fields
    // ---------------------------------------------------------------

    describe('standard fields', () => {
        test('new entry has default fields', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());

            // Default fields are set but empty
            expect(entry.fields.has('Title')).toBe(true);
            expect(entry.fields.has('UserName')).toBe(true);
            expect(entry.fields.has('Password')).toBe(true);
            expect(entry.fields.has('URL')).toBe(true);
            expect(entry.fields.has('Notes')).toBe(true);
        });

        test('sets and gets Title', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('Title', 'My Entry');
            expect(entry.fields.get('Title')).toBe('My Entry');
        });

        test('sets and gets UserName', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('UserName', 'admin@example.com');
            expect(entry.fields.get('UserName')).toBe('admin@example.com');
        });

        test('sets and gets Password as ProtectedValue', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            const pwd = kdbxweb.ProtectedValue.fromString('s3cret!');
            entry.fields.set('Password', pwd);

            const retrieved = entry.fields.get('Password');
            expect(retrieved).toBeInstanceOf(kdbxweb.ProtectedValue);
            expect((retrieved as kdbxweb.ProtectedValue).getText()).toBe('s3cret!');
        });

        test('sets and gets URL', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('URL', 'https://example.com/login');
            expect(entry.fields.get('URL')).toBe('https://example.com/login');
        });

        test('sets and gets Notes with multi-line text', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            const notes = 'Line 1\nLine 2\nLine 3';
            entry.fields.set('Notes', notes);
            expect(entry.fields.get('Notes')).toBe(notes);
        });

        test('standard fields survive save/reload', async () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('Title', 'Saved Entry');
            entry.fields.set('UserName', 'user@test.com');
            entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('mypass'));
            entry.fields.set('URL', 'https://test.com');
            entry.fields.set('Notes', 'Test notes');

            const saved = await db.save();
            const db2 = await kdbxweb.Kdbx.load(saved, createCred());
            const entry2 = db2.getDefaultGroup().entries[0];

            expect(entry2.fields.get('Title')).toBe('Saved Entry');
            expect(entry2.fields.get('UserName')).toBe('user@test.com');
            expect(
                (entry2.fields.get('Password') as kdbxweb.ProtectedValue).getText()
            ).toBe('mypass');
            expect(entry2.fields.get('URL')).toBe('https://test.com');
            expect(entry2.fields.get('Notes')).toBe('Test notes');
        }, 30000);
    });

    // ---------------------------------------------------------------
    // Custom fields
    // ---------------------------------------------------------------

    describe('custom fields', () => {
        test('sets and gets plain custom fields', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('CustomField1', 'value1');
            entry.fields.set('CustomField2', 'value2');

            expect(entry.fields.get('CustomField1')).toBe('value1');
            expect(entry.fields.get('CustomField2')).toBe('value2');
        });

        test('sets and gets protected custom fields', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            const secret = kdbxweb.ProtectedValue.fromString('secret-api-key');
            entry.fields.set('API_KEY', secret);

            const retrieved = entry.fields.get('API_KEY');
            expect(retrieved).toBeInstanceOf(kdbxweb.ProtectedValue);
            expect((retrieved as kdbxweb.ProtectedValue).getText()).toBe('secret-api-key');
        });

        test('removes custom fields', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('TempField', 'temp');
            expect(entry.fields.has('TempField')).toBe(true);

            entry.fields.delete('TempField');
            expect(entry.fields.has('TempField')).toBe(false);
        });

        test('iterates over all fields', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('Title', 'Test');
            entry.fields.set('Custom1', 'val1');
            entry.fields.set('Custom2', kdbxweb.ProtectedValue.fromString('val2'));

            const keys: string[] = [];
            for (const [key] of entry.fields) {
                keys.push(key);
            }
            expect(keys).toContain('Title');
            expect(keys).toContain('Custom1');
            expect(keys).toContain('Custom2');
        });

        test('custom fields survive save/reload', async () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('Title', 'Custom Fields Test');
            entry.fields.set('PlainCustom', 'plain-value');
            entry.fields.set(
                'ProtectedCustom',
                kdbxweb.ProtectedValue.fromString('protected-value')
            );

            const saved = await db.save();
            const db2 = await kdbxweb.Kdbx.load(saved, createCred());
            const entry2 = db2.getDefaultGroup().entries[0];

            expect(entry2.fields.get('PlainCustom')).toBe('plain-value');
            const protectedField = entry2.fields.get('ProtectedCustom');
            expect(protectedField).toBeInstanceOf(kdbxweb.ProtectedValue);
            expect((protectedField as kdbxweb.ProtectedValue).getText()).toBe(
                'protected-value'
            );
        }, 30000);
    });

    // ---------------------------------------------------------------
    // Binary attachments
    // ---------------------------------------------------------------

    describe('binary attachments', () => {
        test('adds binary attachment to entry', async () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            const binary = await db.createBinary(
                kdbxweb.ProtectedValue.fromString('file content')
            );
            entry.binaries.set('test.txt', binary);

            expect(entry.binaries.size).toBe(1);
            expect(entry.binaries.has('test.txt')).toBe(true);
        });

        test('adds multiple binaries', async () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());

            const bin1 = await db.createBinary(
                kdbxweb.ProtectedValue.fromString('content1')
            );
            const bin2 = await db.createBinary(
                kdbxweb.ProtectedValue.fromString('content2')
            );

            entry.binaries.set('file1.txt', bin1);
            entry.binaries.set('file2.txt', bin2);

            expect(entry.binaries.size).toBe(2);
        });

        test('removes binary attachment', async () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            const binary = await db.createBinary(
                kdbxweb.ProtectedValue.fromString('temporary')
            );
            entry.binaries.set('temp.txt', binary);
            expect(entry.binaries.size).toBe(1);

            entry.binaries.delete('temp.txt');
            expect(entry.binaries.size).toBe(0);
        });

        test('binary attachments survive save/reload', async () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('Title', 'Binary Test');
            entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('p'));

            const binary = await db.createBinary(
                kdbxweb.ProtectedValue.fromString('attachment data here')
            );
            entry.binaries.set('doc.txt', binary);

            const saved = await db.save();
            const db2 = await kdbxweb.Kdbx.load(saved, createCred());
            const entry2 = db2.getDefaultGroup().entries[0];

            expect(entry2.binaries.size).toBe(1);
            expect(entry2.binaries.has('doc.txt')).toBe(true);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // History management
    // ---------------------------------------------------------------

    describe('history', () => {
        test('pushHistory creates a history entry', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('Title', 'Version 1');
            expect(entry.history.length).toBe(0);

            entry.pushHistory();
            expect(entry.history.length).toBe(1);
            expect(entry.history[0].fields.get('Title')).toBe('Version 1');
        });

        test('pushHistory preserves previous state', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());

            entry.fields.set('Title', 'V1');
            entry.pushHistory();

            entry.fields.set('Title', 'V2');
            entry.pushHistory();

            entry.fields.set('Title', 'V3');

            expect(entry.history.length).toBe(2);
            expect(entry.history[0].fields.get('Title')).toBe('V1');
            expect(entry.history[1].fields.get('Title')).toBe('V2');
            expect(entry.fields.get('Title')).toBe('V3');
        });

        test('removeHistory removes history entries', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());

            for (let i = 0; i < 5; i++) {
                entry.fields.set('Title', `Version ${i}`);
                entry.pushHistory();
            }

            expect(entry.history.length).toBe(5);

            entry.removeHistory(0, 2);
            expect(entry.history.length).toBe(3);
            expect(entry.history[0].fields.get('Title')).toBe('Version 2');
        });

        test('history survives save/reload', async () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('Title', 'Original');
            entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('p'));
            entry.pushHistory();

            entry.fields.set('Title', 'Updated');
            entry.pushHistory();

            entry.fields.set('Title', 'Current');

            const saved = await db.save();
            const db2 = await kdbxweb.Kdbx.load(saved, createCred());
            const entry2 = db2.getDefaultGroup().entries[0];

            expect(entry2.fields.get('Title')).toBe('Current');
            expect(entry2.history.length).toBe(2);
            expect(entry2.history[0].fields.get('Title')).toBe('Original');
            expect(entry2.history[1].fields.get('Title')).toBe('Updated');
        }, 30000);
    });

    // ---------------------------------------------------------------
    // Auto-type
    // ---------------------------------------------------------------

    describe('auto-type', () => {
        test('auto-type is enabled by default', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            expect(entry.autoType.enabled).toBe(true);
            expect(entry.autoType.obfuscation).toBe(
                kdbxweb.Consts.AutoTypeObfuscationOptions.None
            );
        });

        test('sets auto-type default sequence', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.autoType.defaultSequence = '{USERNAME}{TAB}{PASSWORD}{ENTER}';
            expect(entry.autoType.defaultSequence).toBe(
                '{USERNAME}{TAB}{PASSWORD}{ENTER}'
            );
        });

        test('adds auto-type items', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());

            entry.autoType.items.push({
                window: 'Chrome - Login Page',
                keystrokeSequence: '{USERNAME}{TAB}{PASSWORD}{ENTER}'
            });

            expect(entry.autoType.items.length).toBe(1);
            expect(entry.autoType.items[0].window).toBe('Chrome - Login Page');
        });

        test('auto-type survives save/reload', async () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('Title', 'AutoType Test');
            entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('p'));
            entry.autoType.defaultSequence = '{USERNAME}{TAB}{PASSWORD}{ENTER}';
            entry.autoType.items.push({
                window: 'Browser*',
                keystrokeSequence: '{USERNAME}{TAB}{PASSWORD}{ENTER}'
            });

            const saved = await db.save();
            const db2 = await kdbxweb.Kdbx.load(saved, createCred());
            const entry2 = db2.getDefaultGroup().entries[0];

            expect(entry2.autoType.enabled).toBe(true);
            expect(entry2.autoType.defaultSequence).toBe(
                '{USERNAME}{TAB}{PASSWORD}{ENTER}'
            );
            expect(entry2.autoType.items.length).toBe(1);
            expect(entry2.autoType.items[0].window).toBe('Browser*');
        }, 30000);
    });

    // ---------------------------------------------------------------
    // Entry copy
    // ---------------------------------------------------------------

    describe('copyFrom', () => {
        test('copies all fields', () => {
            const db = createDb();
            const original = db.createEntry(db.getDefaultGroup());
            original.fields.set('Title', 'Original');
            original.fields.set('UserName', 'user');
            original.fields.set(
                'Password',
                kdbxweb.ProtectedValue.fromString('pass')
            );
            original.fields.set('CustomField', 'custom');

            const copy = new kdbxweb.KdbxEntry();
            copy.copyFrom(original);

            expect(copy.fields.get('Title')).toBe('Original');
            expect(copy.fields.get('UserName')).toBe('user');
            expect(
                (copy.fields.get('Password') as kdbxweb.ProtectedValue).getText()
            ).toBe('pass');
            expect(copy.fields.get('CustomField')).toBe('custom');
        });

        test('copied fields are independent (not shared references)', () => {
            const db = createDb();
            const original = db.createEntry(db.getDefaultGroup());
            original.fields.set('Title', 'Original');

            const copy = new kdbxweb.KdbxEntry();
            copy.copyFrom(original);

            // Modify copy should not affect original
            copy.fields.set('Title', 'Modified Copy');
            expect(original.fields.get('Title')).toBe('Original');
        });

        test('copies UUID', () => {
            const db = createDb();
            const original = db.createEntry(db.getDefaultGroup());

            const copy = new kdbxweb.KdbxEntry();
            copy.copyFrom(original);

            expect(copy.uuid.id).toBe(original.uuid.id);
        });
    });

    // ---------------------------------------------------------------
    // Tags
    // ---------------------------------------------------------------

    describe('tags', () => {
        test('sets and gets tags', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.tags = ['important', 'work', 'login'];

            expect(entry.tags).toEqual(['important', 'work', 'login']);
        });

        test('tags survive save/reload', async () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('Title', 'Tagged Entry');
            entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('p'));
            entry.tags = ['tag1', 'tag2'];

            const saved = await db.save();
            const db2 = await kdbxweb.Kdbx.load(saved, createCred());
            const entry2 = db2.getDefaultGroup().entries[0];

            expect(entry2.tags).toEqual(['tag1', 'tag2']);
        }, 30000);
    });

    // ---------------------------------------------------------------
    // Icons and colors
    // ---------------------------------------------------------------

    describe('icons and colors', () => {
        test('sets icon', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.icon = kdbxweb.Consts.Icons.World;
            expect(entry.icon).toBe(kdbxweb.Consts.Icons.World);
        });

        test('sets foreground color', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fgColor = '#FF0000';
            expect(entry.fgColor).toBe('#FF0000');
        });

        test('sets background color', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.bgColor = '#00FF00';
            expect(entry.bgColor).toBe('#00FF00');
        });

        test('icon and colors survive save/reload', async () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('Title', 'Colored Entry');
            entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('p'));
            entry.icon = kdbxweb.Consts.Icons.NetworkServer;
            entry.fgColor = '#FF0000';
            entry.bgColor = '#00FF00';

            const saved = await db.save();
            const db2 = await kdbxweb.Kdbx.load(saved, createCred());
            const entry2 = db2.getDefaultGroup().entries[0];

            expect(entry2.icon).toBe(kdbxweb.Consts.Icons.NetworkServer);
            expect(entry2.fgColor).toBe('#FF0000');
            expect(entry2.bgColor).toBe('#00FF00');
        }, 30000);
    });

    // ---------------------------------------------------------------
    // UUID
    // ---------------------------------------------------------------

    describe('UUID', () => {
        test('new entry has a non-empty UUID', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            expect(entry.uuid).toBeTruthy();
            expect(entry.uuid.empty).toBe(false);
        });

        test('two entries have different UUIDs', () => {
            const db = createDb();
            const entry1 = db.createEntry(db.getDefaultGroup());
            const entry2 = db.createEntry(db.getDefaultGroup());
            expect(entry1.uuid.id).not.toBe(entry2.uuid.id);
        });
    });

    // ---------------------------------------------------------------
    // Times
    // ---------------------------------------------------------------

    describe('times', () => {
        test('new entry has creation time', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            expect(entry.times.creationTime).toBeTruthy();
        });

        test('update() refreshes lastModTime', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());

            const before = entry.times.lastModTime?.getTime() || 0;
            entry.times.update();
            const after = entry.times.lastModTime?.getTime() || 0;

            expect(after).toBeGreaterThanOrEqual(before);
        });
    });

    // ---------------------------------------------------------------
    // Override URL
    // ---------------------------------------------------------------

    describe('overrideUrl', () => {
        test('sets and gets overrideUrl', () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.overrideUrl = 'cmd://notepad.exe';
            expect(entry.overrideUrl).toBe('cmd://notepad.exe');
        });
    });

    // ---------------------------------------------------------------
    // Fields with special characters
    // ---------------------------------------------------------------

    describe('fields with special characters', () => {
        test('handles XML special characters in field keys', async () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('Title', 'Special Chars');
            entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('p'));
            // Custom field with XML-safe special chars in value
            entry.fields.set('HTML_Field', '<div class="test">&amp;</div>');

            const saved = await db.save();
            const db2 = await kdbxweb.Kdbx.load(saved, createCred());
            const entry2 = db2.getDefaultGroup().entries[0];

            expect(entry2.fields.get('HTML_Field')).toBe(
                '<div class="test">&amp;</div>'
            );
        }, 30000);

        test('handles empty string fields', async () => {
            const db = createDb();
            const entry = db.createEntry(db.getDefaultGroup());
            entry.fields.set('Title', '');
            entry.fields.set('UserName', '');
            entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(''));

            const saved = await db.save();
            const db2 = await kdbxweb.Kdbx.load(saved, createCred());
            const entry2 = db2.getDefaultGroup().entries[0];

            // Empty fields may round-trip as empty string
            const title = entry2.fields.get('Title');
            expect(title === '' || title === undefined || title === null).toBe(true);
        }, 30000);
    });
});
