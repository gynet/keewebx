import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as kdbxweb from '../../lib';
import { argon2 } from '../test-support/argon2';
import { TestResources } from '../test-support/test-resources';

describe('Kdbx', () => {
    const challengeResponse: kdbxweb.KdbxChallengeResponseFn = function (challenge) {
        const responses = new Map<string, string>([
            [
                '011ed85afa703341893596fba2da60b6cacabaa5468a0e9ea74698b901bc89ab',
                'ae7244b336f3360e4669ec9eaf4ddc23785aef03'
            ],
            [
                '0ba4bbdf2e44fe56b64136a5086ba3ab814130d8e3fe7ed0e869cc976af6c12a',
                '18350f73193e1c89211921d3016bfe3ddfc54d3e'
            ]
        ]);
        const hexChallenge = kdbxweb.ByteUtils.bytesToHex(challenge);
        const response = responses.get(hexChallenge) || '0000000000000000000000000000000000000000';
        return Promise.resolve(kdbxweb.ByteUtils.hexToBytes(response));
    };

    beforeAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    });

    afterAll(() => {
        // Reset to no impl (default state)
        kdbxweb.CryptoEngine.setArgon2Impl(undefined as any);
    });

    test('sets all imports without issues', () => {
        for (const value of Object.values(kdbxweb)) {
            expect(value).toBeTruthy();
        }
    });

    test('loads simple xml file', async () => {
        const cred = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(''));
        const xml = kdbxweb.ByteUtils.bytesToString(TestResources.emptyUuidXml).toString();
        const db = await kdbxweb.Kdbx.loadXml(xml, cred);
        expect(db).toBeInstanceOf(kdbxweb.Kdbx);
    });

    test('generates error for malformed xml file', async () => {
        const cred = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(''));
        try {
            await kdbxweb.Kdbx.loadXml('malformed-xml', cred);
            throw new Error('Not expected');
        } catch (e) {
            expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            expect((e as kdbxweb.KdbxError).code).toBe(kdbxweb.Consts.ErrorCodes.FileCorrupt);
            expect((e as kdbxweb.KdbxError).message).toContain('bad xml');
        }
    });

    test('loads kdbx4 file with argon2 kdf', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            TestResources.demoKey
        );
        const db = await kdbxweb.Kdbx.load(TestResources.argon2, cred);
        expect(db).toBeInstanceOf(kdbxweb.Kdbx);
        checkDb(db);
        const ab = await db.save();
        const db2 = await kdbxweb.Kdbx.load(ab, cred);
        expect(db2.meta.generator).toBe('KdbxWeb');
        checkDb(db2);
    }, 10000);

    test('loads kdbx4 file with argon2id kdf', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            TestResources.demoKey
        );
        const db = await kdbxweb.Kdbx.load(TestResources.argon2id, cred);
        expect(db).toBeInstanceOf(kdbxweb.Kdbx);
        checkDb(db);
        const ab = await db.save();
        const db2 = await kdbxweb.Kdbx.load(ab, cred);
        expect(db2.meta.generator).toBe('KdbxWeb');
        checkDb(db2);
    }, 10000);

    test('loads kdbx4 file with argon2 kdf and chacha20 encryption', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            TestResources.demoKey
        );
        const db = await kdbxweb.Kdbx.load(TestResources.argon2ChaCha, cred);
        expect(db).toBeInstanceOf(kdbxweb.Kdbx);
        checkDb(db);
        const ab = await db.save();
        const db2 = await kdbxweb.Kdbx.load(ab, cred);
        expect(db2.meta.generator).toBe('KdbxWeb');
        checkDb(db2);
    }, 10000);

    test('loads a kdbx4 file with challenge-response', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            null,
            challengeResponse
        );
        const db = await kdbxweb.Kdbx.load(TestResources.yubikey4, cred);
        expect(db).toBeInstanceOf(kdbxweb.Kdbx);
        expect(db.meta.generator).toBe('KeePassXC');
    }, 10000);

    test('creates new database', async () => {
        const keyFile = await kdbxweb.Credentials.createRandomKeyFile(1);
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            keyFile
        );
        const db = kdbxweb.Kdbx.create(cred, 'example');
        const subGroup = db.createGroup(db.getDefaultGroup(), 'subgroup');
        const entry = db.createEntry(subGroup);
        db.meta.customData.set('key', { value: 'val' });
        db.createDefaultGroup();
        db.createRecycleBin();
        entry.fields.set('Title', 'title');
        entry.fields.set('UserName', 'user');
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('pass'));
        entry.fields.set('Notes', 'notes');
        entry.fields.set('URL', 'url');
        const binary = await db.createBinary(kdbxweb.ProtectedValue.fromString('bin.txt content'));
        entry.binaries.set('bin.txt', binary);
        entry.pushHistory();
        entry.fields.set('Title', 'newtitle');
        entry.fields.set('UserName', 'newuser');
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('newpass'));
        entry.fields.set('CustomPlain', 'custom-plain');
        entry.fields.set(
            'CustomProtected',
            kdbxweb.ProtectedValue.fromString('custom-protected')
        );
        entry.times.update();
        const ab = await db.save();
        const db2 = await kdbxweb.Kdbx.load(ab, cred);
        expect(db2.meta.generator).toBe('KdbxWeb');
        expect(db2.meta.customData.get('key')?.value).toBe('val');
        expect(db2.groups.length).toBe(1);
        expect(db2.groups[0].groups.length).toBe(2);
        expect(db2.getGroup(db2.meta.recycleBinUuid!)).toBe(db2.groups[0].groups[0]);
    });

    test('creates random keyfile v2', async () => {
        const keyFile = await kdbxweb.Credentials.createRandomKeyFile(2);
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            keyFile
        );
        const db = kdbxweb.Kdbx.create(cred, 'example');
        const keyFileStr = kdbxweb.ByteUtils.bytesToString(keyFile).toString();
        expect(keyFileStr).toContain('<Version>2.0</Version>');
        const ab = await db.save();
        const db2 = await kdbxweb.Kdbx.load(ab, cred);
        expect(db2.meta.generator).toBe('KdbxWeb');
    });

    test('generates error for bad file', async () => {
        try {
            // @ts-ignore
            await kdbxweb.Kdbx.load('file');
            throw new Error('Not expected');
        } catch (e) {
            expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            expect((e as kdbxweb.KdbxError).code).toBe(kdbxweb.Consts.ErrorCodes.InvalidArg);
            expect((e as kdbxweb.KdbxError).message).toContain('data');
        }
    });

    test('rejects KDBX3 version in format load', async () => {
        // Directly test the format layer's KDBX3 rejection
        const cred = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('test'));
        const db = kdbxweb.Kdbx.create(cred, 'test');
        // Force version to 3 internally (bypassing setVersion validation)
        db.header.versionMajor = 3;
        try {
            await db.save();
            throw new Error('Not expected');
        } catch (e) {
            expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            expect((e as kdbxweb.KdbxError).code).toBe(kdbxweb.Consts.ErrorCodes.InvalidVersion);
            expect((e as kdbxweb.KdbxError).message).toContain('KDBX3 is not supported');
        }
    });

    test('generates error for bad header hash', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            TestResources.demoKey
        );
        const file = new Uint8Array(TestResources.argon2.byteLength);
        file.set(new Uint8Array(TestResources.argon2));
        file[254] = 0;
        try {
            await kdbxweb.Kdbx.load(file.buffer, cred);
            throw new Error('Not expected');
        } catch (e) {
            expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            expect((e as kdbxweb.KdbxError).code).toBe(kdbxweb.Consts.ErrorCodes.FileCorrupt);
            expect((e as kdbxweb.KdbxError).message).toContain('header hash mismatch');
        }
    });

    test('generates error for bad header hmac', async () => {
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            TestResources.demoKey
        );
        const file = new Uint8Array(TestResources.argon2.byteLength);
        file.set(new Uint8Array(TestResources.argon2));
        file[286] = 0;
        try {
            await kdbxweb.Kdbx.load(file.buffer, cred);
            throw new Error('Not expected');
        } catch (e) {
            expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            expect((e as kdbxweb.KdbxError).code).toBe(kdbxweb.Consts.ErrorCodes.InvalidKey);
        }
    });

    test('generates error for bad credentials', async () => {
        try {
            // @ts-ignore
            await kdbxweb.Kdbx.load(new ArrayBuffer(0), '123');
            throw new Error('Not expected');
        } catch (e) {
            expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            expect((e as kdbxweb.KdbxError).code).toBe(kdbxweb.Consts.ErrorCodes.InvalidArg);
            expect((e as kdbxweb.KdbxError).message).toContain('credentials');
        }
    });

    test('generates error for null credentials', async () => {
        try {
            // @ts-ignore
            await kdbxweb.Kdbx.load(new ArrayBuffer(0), null);
            throw new Error('Not expected');
        } catch (e) {
            expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            expect((e as kdbxweb.KdbxError).code).toBe(kdbxweb.Consts.ErrorCodes.InvalidArg);
            expect((e as kdbxweb.KdbxError).message).toContain('credentials');
        }
    });

    test('generates error for bad password', async () => {
        const cred = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('demo'));
        try {
            // @ts-ignore
            await cred.setPassword('string');
            throw new Error('Not expected');
        } catch (e) {
            expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            expect((e as kdbxweb.KdbxError).code).toBe(kdbxweb.Consts.ErrorCodes.InvalidArg);
            expect((e as kdbxweb.KdbxError).message).toContain('password');
        }
    });

    test('generates error for bad keyfile', async () => {
        const cred = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('demo'));
        try {
            // @ts-ignore
            await cred.setKeyFile('123');
            throw new Error('Not expected');
        } catch (e) {
            expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            expect((e as kdbxweb.KdbxError).code).toBe(kdbxweb.Consts.ErrorCodes.InvalidArg);
            expect((e as kdbxweb.KdbxError).message).toContain('keyFile');
        }
    });

    test('generates error for create with bad credentials', () => {
        expect(() => {
            // @ts-ignore
            kdbxweb.Kdbx.create('file');
        }).toThrow();
    });

    test('generates loadXml error for bad data', async () => {
        try {
            // @ts-ignore
            await kdbxweb.Kdbx.loadXml(new ArrayBuffer(0));
            throw new Error('Not expected');
        } catch (e) {
            expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            expect((e as kdbxweb.KdbxError).code).toBe(kdbxweb.Consts.ErrorCodes.InvalidArg);
            expect((e as kdbxweb.KdbxError).message).toContain('data');
        }
    });

    test('generates loadXml error for bad credentials', async () => {
        try {
            // @ts-ignore
            await kdbxweb.Kdbx.loadXml('str', null);
            throw new Error('Not expected');
        } catch (e) {
            expect(e).toBeInstanceOf(kdbxweb.KdbxError);
            expect((e as kdbxweb.KdbxError).code).toBe(kdbxweb.Consts.ErrorCodes.InvalidArg);
            expect((e as kdbxweb.KdbxError).message).toContain('credentials');
        }
    });

    test('saves db to xml', async () => {
        const keyFile = await kdbxweb.Credentials.createRandomKeyFile();
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            keyFile
        );
        const db = kdbxweb.Kdbx.create(cred, 'example');
        const subGroup = db.createGroup(db.getDefaultGroup(), 'subgroup');
        const entry = db.createEntry(subGroup);
        entry.fields.set('Title', 'title');
        entry.fields.set('UserName', 'user');
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('pass'));
        entry.fields.set('Notes', 'notes');
        entry.fields.set('URL', 'url');
        entry.times.update();
        const xml = await db.saveXml();
        expect(xml).toContain('<Value ProtectInMemory="True">pass</Value>');
    });

    test('cleanups by history rules', async () => {
        const keyFile = await kdbxweb.Credentials.createRandomKeyFile();
        const cred = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString('demo'),
            keyFile
        );
        const db = kdbxweb.Kdbx.create(cred, 'example');
        const subGroup = db.createGroup(db.getDefaultGroup(), 'subgroup');
        const entry = db.createEntry(subGroup);
        let i;
        for (i = 0; i < 3; i++) {
            entry.fields.set('Title', i.toString());
            entry.pushHistory();
        }
        expect(entry.history[0].fields.get('Title')).toBe('0');
        expect(entry.history.length).toBe(3);
        db.cleanup({ historyRules: true });
        expect(entry.history.length).toBe(3);
        for (i = 3; i < 10; i++) {
            entry.fields.set('Title', i.toString());
            entry.pushHistory();
        }
        expect(entry.history[0].fields.get('Title')).toBe('0');
        expect(entry.history.length).toBe(10);
        db.cleanup({ historyRules: true });
        expect(entry.history[0].fields.get('Title')).toBe('0');
        expect(entry.history.length).toBe(10);
        for (i = 10; i < 11; i++) {
            entry.fields.set('Title', i.toString());
            entry.pushHistory();
        }
        expect(entry.history.length).toBe(11);
        db.cleanup({ historyRules: true });
        expect(entry.history[0].fields.get('Title')).toBe('1');
        expect(entry.history.length).toBe(10);
    });

    test('cleanup retains attachments and icons referenced outside the default root', async () => {
        const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('cleanup roots'));
        const db = kdbxweb.Kdbx.create(credentials, 'multiple roots');
        const secondRoot = kdbxweb.KdbxGroup.create('second root');
        db.groups.push(secondRoot);
        const entry = db.createEntry(db.getDefaultGroup());
        const historyBinary = await db.createBinary(new Uint8Array([1, 2, 3]).buffer);
        const currentBinary = await db.createBinary(new Uint8Array([4, 5, 6]).buffer);
        const unusedBinary = await db.createBinary(new Uint8Array([7, 8, 9]).buffer);
        const icons = Array.from({ length: 4 }, () => kdbxweb.KdbxUuid.random());
        for (const icon of icons) db.meta.customIcons.set(icon.id, { data: new Uint8Array([1]).buffer });
        entry.customIcon = icons[0];
        entry.binaries.set('history.bin', historyBinary);
        entry.pushHistory();
        entry.customIcon = icons[1];
        entry.binaries.clear();
        entry.binaries.set('current.bin', currentBinary);
        secondRoot.customIcon = icons[2];
        db.move(entry, secondRoot);

        db.cleanup({ historyRules: true, customIcons: true, binaries: true });

        expect(db.binaries.getAllWithHashes().map(binary => binary.hash).sort())
            .toEqual([historyBinary.hash, currentBinary.hash].sort());
        expect(db.binaries.getRefByHash(unusedBinary.hash)).toBeUndefined();
        expect([...db.meta.customIcons.keys()].sort()).toEqual(icons.slice(0, 3).map(icon => icon.id).sort());
        const reopened = await kdbxweb.Kdbx.load(await db.save(), credentials);
        const restored = reopened.groups[1].entries[0];
        expect(restored.uuid.id).toBe(entry.uuid.id);
        expect(restored.binaries.get('current.bin')).toEqual(currentBinary);
        expect(restored.history[0].binaries.get('history.bin')).toEqual(historyBinary);
        expect([...reopened.meta.customIcons.keys()].sort()).toEqual(icons.slice(0, 3).map(icon => icon.id).sort());
    });

    test('creates missing uuids', async () => {
        const cred = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(''));
        const xml = kdbxweb.ByteUtils.bytesToString(TestResources.emptyUuidXml).toString();
        const db = await kdbxweb.Kdbx.loadXml(xml, cred);
        expect(db).toBeInstanceOf(kdbxweb.Kdbx);
        expect(db.groups.length).toBe(1);
        expect(db.groups[0].uuid).toBeTruthy();
        expect(db.groups[0].uuid.id).toBeTruthy();
        const entry = db.groups[0].groups[0].entries[0];
        expect(entry.uuid).toBeTruthy();
        expect(entry.uuid.id).toBeTruthy();
        expect(entry.history.length).toBeGreaterThan(0);
        for (let i = 0; i < entry.history.length; i++) {
            const he = entry.history[i];
            expect(he.uuid).toBeTruthy();
            expect(he.uuid.id).toBe(entry.uuid.id);
        }
    });

    test('supports KDBX4.1 features', async () => {
        const cred = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('test'));
        let db = await kdbxweb.Kdbx.load(TestResources.kdbx41, cred);

        check(db);

        const xml = await db.saveXml();
        db = await kdbxweb.Kdbx.loadXml(xml, cred);

        check(db);

        function check(db: kdbxweb.Kdbx) {
            const groupWithTags = db.groups[0].groups[0].groups[0];
            expect(groupWithTags).toBeTruthy();
            expect(groupWithTags.name).toBe('With tags');
            expect(groupWithTags.tags).toEqual(['Another tag', 'Tag1']);
            expect(groupWithTags.previousParentGroup).toBe(undefined);

            const regularEntry = db.groups[0].entries[0];
            expect(regularEntry.qualityCheck).toBe(undefined);

            const entryWithDisabledPasswordQuality = db.groups[0].entries[1];
            expect(entryWithDisabledPasswordQuality).toBeTruthy();
            expect(entryWithDisabledPasswordQuality.fields.get('Title')).toBe('DisabledQ');
            expect(entryWithDisabledPasswordQuality.qualityCheck).toBe(false);

            const previousParentGroup = db.groups[0].groups[0].groups[1];
            expect(previousParentGroup).toBeTruthy();
            expect(previousParentGroup.name).toBe('Inside');

            const groupMovedFromInside = db.groups[0].groups[0].groups[2];
            expect(groupMovedFromInside).toBeTruthy();
            expect(groupMovedFromInside.name).toBe('New group was inside');
            expect(
                previousParentGroup.uuid.equals(groupMovedFromInside.previousParentGroup)
            ).toBeTruthy();

            const entryMovedFromInside = db.groups[0].groups[0].entries[0];
            expect(entryMovedFromInside).toBeTruthy();
            expect(entryMovedFromInside.fields.get('Title')).toBe('Was inside');
            expect(
                previousParentGroup.uuid.equals(entryMovedFromInside.previousParentGroup)
            ).toBeTruthy();

            expect(db.meta.customIcons.size).toBe(2);
            const icon1 = db.meta.customIcons.get('3q2nWI0en0W/wvhaCFJsnw==');
            expect(icon1).toBeTruthy();
            expect(icon1!.name).toBe('Bulb icon');
            expect(icon1!.lastModified?.toISOString()).toBe('2021-05-05T18:28:34.000Z');

            expect(db.meta.customData.size).toBe(4);
            expect(db.meta.customData.get('Test_A')).toEqual({
                value: 'NmL56onQIqdk1WSt',
                lastModified: new Date('2021-01-20T18:10:44.000Z')
            });
        }
    });

    function checkDb(db: any) {
        expect(db.meta.name).toBe('demo');
        expect(db.meta.nameChanged.toISOString()).toBe('2015-08-16T14:45:23.000Z');
        expect(db.meta.desc).toBe('demo db');
        expect(db.meta.descChanged.toISOString()).toBe('2015-08-16T14:45:23.000Z');
        expect(db.meta.defaultUser).toBe('me');
        expect(db.meta.defaultUserChanged.toISOString()).toBe('2015-08-16T14:45:23.000Z');
        expect(db.meta.mntncHistoryDays).toBe(365);
        expect(db.meta.color).toBe('#FF0000');
        expect(db.meta.keyChanged.toISOString()).toBe('2015-08-16T14:53:28.000Z');
        expect(db.meta.keyChangeRec).toBe(-1);
        expect(db.meta.keyChangeForce).toBe(-1);
        expect(db.meta.recycleBinEnabled).toBe(true);
        expect(db.meta.recycleBinUuid.id).toBe('fZ7q9U4TBU+5VomeW3BZOQ==');
        expect(db.meta.recycleBinChanged.toISOString()).toBe('2015-08-16T14:44:42.000Z');
        expect(db.meta.entryTemplatesGroup.empty).toBe(true);
        expect(db.meta.entryTemplatesGroupChanged.toISOString()).toBe('2015-08-16T14:44:42.000Z');
        expect(db.meta.historyMaxItems).toBe(10);
        expect(db.meta.historyMaxSize).toBe(6291456);
        expect(db.meta.lastSelectedGroup.id).toBe('LWIve8M1xUuvrORCdYeRgA==');
        expect(db.meta.lastTopVisibleGroup.id).toBe('LWIve8M1xUuvrORCdYeRgA==');
        expect(db.meta.memoryProtection.title).toBe(false);
        expect(db.meta.memoryProtection.userName).toBe(false);
        expect(db.meta.memoryProtection.password).toBe(true);
        expect(db.meta.memoryProtection.url).toBe(false);
        expect(db.meta.memoryProtection.notes).toBe(false);
        expect(db.meta.customIcons.size).toBe(1);
        expect(db.meta.customIcons.get('rr3vZ1ozek+R4pAcLeqw5w==')).toBeTruthy();

        const binaries = db.binaries.getAll();
        expect(binaries.length).toBe(1);
        expect(binaries[0].ref).toBeTruthy();
        expect(binaries[0].value).toBeTruthy();

        expect(db.deletedObjects.length).toBe(1);
        expect(db.deletedObjects[0].uuid.id).toBe('LtoeZ26BBkqtr93N9tqO4g==');
        expect(db.deletedObjects[0].deletionTime.toISOString()).toBe('2015-08-16T14:50:13.000Z');

        expect(db.groups.length).toBe(1);
    }
});
