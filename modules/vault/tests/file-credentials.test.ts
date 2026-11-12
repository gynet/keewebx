import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { argon2d, argon2id } from 'hash-wasm';
import { ByteUtils, Credentials, CryptoEngine, Int64, Kdbx, ProtectedValue, VarDictionary } from 'kdbxweb';
import { exportVault } from '../src/comp/app/vault-files';
import { waitForCredentialChanges } from '../src/util/kdbxweb/credential-changes';

// Keep the real shared FileModel setters, model state, credentials and serializer.
// Only unrelated browser/collection imports are stubbed for this headless unit test.
mock.module('demo.kdbx', () => ({ default: '' }));
mock.module('../src/collections/group-collection', () => ({ GroupCollection: class extends Array {} }));
mock.module('../src/models/group-model', () => ({ GroupModel: class {} }));
mock.module('../src/models/app-settings-model', () => ({ AppSettingsModel: {} }));
mock.module('../src/models/entry-model', () => ({ EntryModel: class {} }));
mock.module('../src/util/formatting/icon-url-format', () => ({ IconUrlFormat: {} }));
mock.module('../src/util/locale', () => ({ Locale: {} }));
mock.module('../src/collections/file-info-collection', () => ({ FileInfoCollection: {} }));
const { FileModel } = await import('../src/models/file-model');

type Argon2 = Parameters<typeof CryptoEngine.setArgon2Impl>[0];
const hash: Argon2 = async (password, salt, memory, iterations, length, parallelism, type) => {
    const bytes = await (type === CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id)({
        password: new Uint8Array(password), salt: new Uint8Array(salt), memorySize: memory,
        iterations, parallelism, hashLength: length, outputType: 'binary'
    });
    return ByteUtils.arrayToBuffer(bytes);
};
const realSha256 = CryptoEngine.sha256;
const pw = (text: string) => ProtectedValue.fromString(text);
const key = (text: string) => new TextEncoder().encode(text); // Non-XML key files use async SHA-256.

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

/** Hold the actual setter's digest result after computation, before it can publish. */
function holdHashes(...texts: string[]) {
    const gates = texts.map((text) => ({ text, started: deferred(), release: deferred() }));
    const spy = mock((data: ArrayBuffer) => {
        const text = new TextDecoder().decode(data);
        const gate = gates.find((candidate) => candidate.text === text);
        if (!gate) return realSha256(data);
        return realSha256(data).then((digest) => {
            gate.started.resolve();
            return gate.release.promise.then(() => digest);
        });
    });
    CryptoEngine.sha256 = spy;
    return gates;
}

async function model(withKey = false) {
    const credentials = new Credentials(pw('original'), withKey ? key('original-key') : undefined);
    await credentials.ready;
    const db = Kdbx.create(credentials, 'Credentials');
    db.header.kdfParameters!.set('M', VarDictionary.ValueType.UInt64, Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', VarDictionary.ValueType.UInt64, Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', 'Preserved');
    const file = new FileModel({ id: 'credential-test' });
    file.db = db;
    file.name = 'Credentials';
    file.active = true;
    file.oldPasswordHash = credentials.passwordHash;
    file.oldKeyFileHash = credentials.keyFileHash;
    file.oldPasswordLength = 'original'.length;
    file.oldKeyFileName = withKey ? 'original.key' : '';
    file.oldKeyChangeDate = db.meta.keyChanged;
    return file;
}

async function reopen(data: ArrayBuffer, password: string, keyText?: string) {
    return Kdbx.load(data, new Credentials(pw(password), keyText ? key(keyText) : undefined));
}

function classicSave(file: InstanceType<typeof FileModel>): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => file.getData((data, error) => data ? resolve(data) : reject(error)));
}

beforeEach(() => CryptoEngine.setArgon2Impl(hash));
afterEach(() => { CryptoEngine.sha256 = realSha256; CryptoEngine.setArgon2Impl(hash); });

describe('shared FileModel credential publication', () => {
    for (const order of ['AB', 'BA']) {
        test(`password setters completing ${order} retain the last request in export and Classic save`, async () => {
            const file = await model();
            const [a, b] = holdHashes('password-A', 'password-B');
            file.setPassword(pw('password-A'));
            file.setPassword(pw('password-B'));
            await Promise.all([a.started.promise, b.started.promise]);
            const completedFirst = order === 'AB' ? a : b;
            completedFirst.release.resolve();
            if (order === 'BA') {
                // Neither export nor Classic save should wait for superseded A.
                await reopen(await exportVault(file), 'password-B');
                await reopen(await classicSave(file), 'password-B');
            }
            (order === 'AB' ? b : a).release.resolve();
            await Promise.all([a.release.promise, b.release.promise]);
            // Drain all hash/publication continuations, including superseded A.
            await new Promise((resolve) => setTimeout(resolve, 0));
            CryptoEngine.sha256 = realSha256;
            const data = await exportVault(file);
            await reopen(data, 'password-B');
            await expect(reopen(data, 'password-A')).rejects.toThrow();
            await expect(reopen(data, 'original')).rejects.toThrow();
            await reopen(await classicSave(file), 'password-B');
            expect(file.passwordChanged).toBe(true);
        });

        test(`key-file setters completing ${order} retain the last request`, async () => {
            const file = await model(true);
            const [a, b] = holdHashes('key-A', 'key-B');
            file.setKeyFile(key('key-A'), 'a.key');
            file.setKeyFile(key('key-B'), 'b.key');
            await Promise.all([a.started.promise, b.started.promise]);
            (order === 'AB' ? a : b).release.resolve();
            if (order === 'BA') await reopen(await exportVault(file), 'original', 'key-B');
            (order === 'AB' ? b : a).release.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
            CryptoEngine.sha256 = realSha256;
            const data = await exportVault(file);
            await reopen(data, 'original', 'key-B');
            await expect(reopen(data, 'original', 'key-A')).rejects.toThrow();
            await reopen(await classicSave(file), 'original', 'key-B');
            expect(file.keyFileName).toBe('b.key');
        });
    }

    test('resetPassword wakes an existing export waiter and prevents canceled hashing from publishing', async () => {
        const file = await model();
        const [a] = holdHashes('canceled-password');
        file.setPassword(pw('canceled-password'));
        await a.started.promise;
        const exporting = exportVault(file);
        file.resetPassword();
        await reopen(await exporting, 'original'); // A is still blocked.
        expect(file.db.credentials.passwordHash).toBe(file.oldPasswordHash);
        expect(file.passwordChanged).toBe(false);
        expect(file.passwordLength).toBe('original'.length);
        a.release.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        CryptoEngine.sha256 = realSha256;
        const data = await classicSave(file);
        await reopen(data, 'original');
        await expect(reopen(data, 'canceled-password')).rejects.toThrow();
        expect(file.db.credentials.passwordHash).toBe(file.oldPasswordHash);
    });

    for (const action of ['reset', 'remove']) {
        test(`${action} key file invalidates pending hashing and preserves Classic metadata`, async () => {
            const file = await model(true);
            const [a] = holdHashes('canceled-key');
            file.setKeyFile(key('canceled-key'), 'canceled.key');
            await a.started.promise;
            const exporting = exportVault(file);
            if (action === 'reset') file.resetKeyFile(); else file.removeKeyFile();
            await reopen(await exporting, 'original', action === 'reset' ? 'original-key' : undefined);
            a.release.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
            CryptoEngine.sha256 = realSha256;
            const data = await classicSave(file);
            await reopen(data, 'original', action === 'reset' ? 'original-key' : undefined);
            await expect(reopen(data, 'original', 'canceled-key')).rejects.toThrow();
            expect(file.keyFileName).toBe(action === 'reset' ? 'original.key' : '');
            expect(file.keyFileChanged).toBe(action === 'remove');
            expect(file.db.credentials.keyFileHash).toBe(action === 'reset' ? file.oldKeyFileHash : undefined);
        });
    }

    test('Classic getData immediately after setters awaits both intended credentials', async () => {
        const file = await model();
        const [password, keyFile] = holdHashes('new-password', 'new-key');
        file.setPassword(pw('new-password'));
        file.setKeyFile(key('new-key'), 'new.key');
        const saving = classicSave(file);
        await Promise.all([password.started.promise, keyFile.started.promise]);
        keyFile.release.resolve();
        password.release.resolve();
        const bytes = await saving;
        CryptoEngine.sha256 = realSha256;
        await reopen(bytes, 'new-password', 'new-key');
        await expect(reopen(bytes, 'original')).rejects.toThrow();
    });

    test('resetting one part preserves the change date of the other pending credential', async () => {
        const file = await model(true);
        const [password, keyFile] = holdHashes('pending-password', 'pending-key');
        file.setKeyFile(key('pending-key'), 'pending.key');
        await keyFile.started.promise;
        const keyDate = file.db.meta.keyChanged;
        file.resetPassword();
        expect(file.db.meta.keyChanged).toBe(keyDate);
        keyFile.release.resolve();
        await waitForCredentialChanges(file.db.credentials);
        file.setPassword(pw('pending-password'));
        await password.started.promise;
        const passwordDate = file.db.meta.keyChanged;
        file.resetKeyFile();
        expect(file.db.meta.keyChanged).toBe(passwordDate);
        password.release.resolve();
        await waitForCredentialChanges(file.db.credentials);
        CryptoEngine.sha256 = realSha256;
        await reopen(await classicSave(file), 'pending-password', 'original-key');
    });

    test('reset recovers from a failed current hash and ignores a superseded failure', async () => {
        const file = await model();
        const [a] = holdHashes('failing-password');
        file.setPassword(pw('failing-password'));
        await a.started.promise;
        a.release.reject(new Error('hash failed'));
        await expect(waitForCredentialChanges(file.db.credentials)).rejects.toThrow('hash failed');
        file.resetPassword();
        await reopen(await exportVault(file), 'original');
        const [b] = holdHashes('obsolete-password');
        file.setPassword(pw('obsolete-password'));
        await b.started.promise;
        file.resetPassword();
        b.release.reject(new Error('obsolete failure'));
        await reopen(await classicSave(file), 'original');
    });
});
