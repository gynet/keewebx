import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ByteUtils, Consts, Credentials, CryptoEngine, Int64, Kdbx, KdbxBinaryWithHash, ProtectedValue, VarDictionary } from 'kdbxweb';

// Existing shared-model tests mock EntryModel process-wide. Run this real-model
// suite in its own Bun process so test ordering cannot replace the implementation.
if (process.env.KEEWEBX_ATTACHMENT_TEST_WORKER !== '1') {
    test('attachment publication: isolated real-model regression suite', async () => {
        const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
            cwd: new URL('..', import.meta.url).pathname,
            env: { ...process.env, KEEWEBX_ATTACHMENT_TEST_WORKER: '1' },
            stdout: 'pipe', stderr: 'pipe'
        });
        const [code, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
        ]);
        if (code !== 0) throw new Error(stdout + stderr);
        expect(stdout + stderr).toMatch(/\b[1-9]\d* pass\b/);
    });
} else {
    mock.module('../src/models/app-settings-model', () => ({ AppSettingsModel: {} }));
    mock.module('../src/util/data/ranking', () => ({ Ranking: {} }));
    const { EntryModel } = await import('../src/models/entry-model');
    const realSha256 = CryptoEngine.sha256;

    function deferred<T = void>() {
        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
        return { promise, resolve, reject };
    }

    async function fixture() {
        const credentials = new Credentials(ProtectedValue.fromString('master'));
        await credentials.ready;
        const db = Kdbx.create(credentials, 'Attachments');
        const raw = db.createEntry(db.getDefaultGroup());
        raw.times.lastModTime = new Date('2020-01-01T00:00:00Z');
        // Exercise real addAttachment and _entryModified with a minimal file/index.
        // Rendering is irrelevant to binary publication, so only refresh is observed.
        const entry = Object.create(EntryModel.prototype) as InstanceType<typeof EntryModel>;
        const file = {
            active: true, db, historyMaxItems: 10, dirty: false, modified: false, editSeq: 0,
            entries: new Map<string, InstanceType<typeof EntryModel>>(),
            getEntry(id: string) { return this.entries.get(id); },
            setModified() { this.dirty = true; this.modified = true; this.editSeq++; },
            reload() { throw new Error('Unexpected reload'); }
        };
        let refreshed = 0;
        Object.assign(entry, {
            entry: raw, id: 'entry', file, unsaved: false, isJustCreated: false,
            _fillByEntry() { refreshed++; }
        });
        file.entries.set(entry.id, entry);
        return { db, raw, entry, file, refreshed: () => refreshed };
    }

    function holdHash(data: ArrayBuffer) {
        const expected = ByteUtils.bytesToHex(data);
        const started = deferred();
        const release = deferred();
        CryptoEngine.sha256 = (bytes) => {
            if (ByteUtils.bytesToHex(bytes) !== expected) return realSha256(bytes);
            return realSha256(bytes).then((digest) => {
                started.resolve();
                return release.promise.then(() => digest);
            });
        };
        return { started, release };
    }

    function expectUntouched(target: Awaited<ReturnType<typeof fixture>>) {
        expect(target.db.binaries.getAllWithHashes()).toHaveLength(0);
        expect(target.raw.binaries.size).toBe(0);
        expect(target.raw.history).toHaveLength(0);
        expect(target.raw.times.lastModTime).toEqual(new Date('2020-01-01T00:00:00Z'));
        expect([target.file.dirty, target.file.modified, target.file.editSeq, target.entry.unsaved]).toEqual([false, false, 0, false]);
        expect(target.refreshed()).toBe(0);
    }

    afterEach(() => { CryptoEngine.sha256 = realSha256; });

    describe('attachment publication after hashing', () => {
        test('a batch publishes once, preserving both binaries and a single history snapshot', async () => {
            const target = await fixture();
            await target.entry.addAttachments([{ name: 'one', data: new Uint8Array([1]).buffer }, { name: 'two', data: new Uint8Array([2]).buffer }]);
            expect([...target.raw.binaries.keys()]).toEqual(['one', 'two']);
            expect(target.db.binaries.getAllWithHashes()).toHaveLength(2);
            expect(target.raw.history).toHaveLength(1);
            expect(target.file.editSeq).toBe(1);
        });

        test('one failed hash discards the whole batch without orphan binaries', async () => {
            const target = await fixture();
            CryptoEngine.sha256 = data => ByteUtils.bytesToHex(data) === '02'
                ? Promise.reject(new Error('Batch hash failed')) : realSha256(data);
            await expect(target.entry.addAttachments([{ name: 'one', data: new Uint8Array([1]).buffer }, { name: 'two', data: new Uint8Array([2]).buffer }])).rejects.toThrow('Batch hash failed');
            expectUntouched(target);
        });

        test('duplicate batch names cannot replace each other', async () => {
            const target = await fixture();
            await expect(target.entry.addAttachments([{ name: 'same', data: new ArrayBuffer(1) }, { name: 'same', data: new ArrayBuffer(2) }])).rejects.toThrow('Duplicate');
            expectUntouched(target);
        });

        for (const reason of ['cancel', 'reauthenticated', 'db-replaced', 'entry-deleted', 'entry-replaced', 'raw-entry-replaced', 'file-replaced', 'file-closed']) {
            test(`${reason} while hashing leaves no binary registration, history or dirty mutation`, async () => {
                const target = await fixture();
                const bytes = new Uint8Array([10, 20, 30]).buffer;
                const { started, release } = holdHash(bytes);
                let epoch = 1;
                let allowed = true;
                const pending = target.entry.addAttachment('upload.bin', bytes, () => allowed && epoch === 1);
                await started.promise;
                expectUntouched(target);
                switch (reason) {
                    case 'cancel': allowed = false; break;
                    case 'reauthenticated': epoch++; break;
                    case 'db-replaced': target.file.db = (await fixture()).db; break;
                    case 'entry-deleted': target.file.entries.delete(target.entry.id); target.db.move(target.raw, null); break;
                    case 'entry-replaced': target.file.entries.set(target.entry.id, {} as InstanceType<typeof EntryModel>); break;
                    case 'raw-entry-replaced': target.entry.entry = target.db.createEntry(target.db.getDefaultGroup()); break;
                    case 'file-replaced': target.entry.file = { ...target.file }; break;
                    case 'file-closed': target.file.active = false; break;
                }
                release.resolve();
                await expect(pending).rejects.toThrow(reason === 'cancel' || reason === 'reauthenticated' ? 'canceled' : 'target changed or closed');
                expectUntouched(target);
                expect(target.file.db.binaries.getAllWithHashes()).toHaveLength(0);
            });
        }

        test('registered upload may publish during the immediate securing epoch and survives KDBX save/reopen', async () => {
            const target = await fixture();
            const bytes = new Uint8Array([11, 22, 33]).buffer;
            const { started, release } = holdHash(bytes);
            let phase = 'open';
            const epoch = 1;
            let currentEpoch = epoch;
            const pending = target.entry.addAttachment('upload.bin', bytes,
                () => currentEpoch === epoch && (phase === 'open' || phase === 'securing'));
            await started.promise;
            expectUntouched(target);
            phase = 'securing';
            release.resolve();
            await pending;
            const binary = target.raw.binaries.get('upload.bin') as KdbxBinaryWithHash;
            expect(target.db.binaries.getValueByHash(binary.hash)).toEqual(bytes);
            expect(target.raw.history).toHaveLength(1);
            expect(target.raw.history[0].binaries.size).toBe(0);
            expect([target.file.dirty, target.file.modified, target.file.editSeq, target.entry.unsaved]).toEqual([true, true, 1, true]);
            expect(target.refreshed()).toBe(1);
            // Cheap existing AES fixture keeps this test focused on actual binary retention.
            CryptoEngine.sha256 = realSha256;
            target.db.header.kdfParameters = new VarDictionary();
            target.db.header.kdfParameters.set('$UUID', VarDictionary.ValueType.Bytes, ByteUtils.arrayToBuffer(ByteUtils.base64ToBytes(Consts.KdfId.Aes)));
            target.db.header.kdfParameters.set('S', VarDictionary.ValueType.Bytes, ByteUtils.arrayToBuffer(CryptoEngine.random(32)));
            target.db.header.kdfParameters.set('R', VarDictionary.ValueType.UInt64, Int64.from(10));
            const loaded = await Kdbx.load(await target.db.save(), new Credentials(ProtectedValue.fromString('master')));
            expect((loaded.getDefaultGroup().entries[0].binaries.get('upload.bin') as KdbxBinaryWithHash).value).toEqual(bytes);
            currentEpoch++;
        });

        test('Classic call without a guard still publishes, with input bytes owned by the operation', async () => {
            const target = await fixture();
            const bytes = new Uint8Array([1, 2, 3]);
            const { started, release } = holdHash(bytes.buffer);
            const pending = target.entry.addAttachment('classic.bin', bytes.buffer);
            await started.promise;
            bytes.fill(0);
            release.resolve();
            await pending;
            const binary = target.raw.binaries.get('classic.bin') as KdbxBinaryWithHash;
            expect(binary.value).toEqual(new Uint8Array([1, 2, 3]).buffer);
            expect(target.db.binaries.getValueByHash(binary.hash)).toEqual(binary.value);
            expect(target.file.dirty).toBe(true);
            expect(target.refreshed()).toBe(1);
        });

        test('hash failure is rejected without marking or registering anything', async () => {
            const target = await fixture();
            const bytes = new Uint8Array([4, 5, 6]).buffer;
            const { started, release } = holdHash(bytes);
            const pending = target.entry.addAttachment('failed.bin', bytes);
            await started.promise;
            release.reject(new Error('Hash failed'));
            await expect(pending).rejects.toThrow('Hash failed');
            expectUntouched(target);
        });

        test('a throwing guard rejects before all live side effects', async () => {
            const target = await fixture();
            await expect(target.entry.addAttachment('guard.bin', new ArrayBuffer(1), () => { throw new Error('Guard failed'); })).rejects.toThrow('Guard failed');
            expectUntouched(target);
        });
    });
}
