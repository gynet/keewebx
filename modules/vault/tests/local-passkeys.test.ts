import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { ByteUtils, Credentials, CryptoEngine, Int64, Kdbx, ProtectedValue, VarDictionary } from 'kdbxweb';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import type { FileInfoModel } from 'models/file-info-model';
import { argon2d, argon2id } from 'hash-wasm';
import { getSessionAccess } from 'comp/app/session-access';
import { resetCredentialHash } from 'util/kdbxweb/credential-changes';
import { waitForPendingOperations } from '../../ui/src/pending-operations';

// Hardware boundary only: HKDF, AES-GCM, credential hashing and KDBX load/save remain real.
const primitive = await import('comp/passkey/passkey-prf');
let available = true;
const prf = new Uint8Array(32).fill(71);
const registration = () => ({ credentialId: new Uint8Array(16).fill(5), prfSalt: new Uint8Array(32).fill(19), prfOutput: prf.slice() });
let create = async () => registration();
let evaluate = async () => prf.slice();
const registered = mock(() => create());
const evaluated = mock(() => evaluate());
mock.module('comp/passkey/passkey-prf', () => ({ ...primitive,
    isPasskeyPrfSupported: () => available, registerPasskey: registered, evaluatePrf: evaluated
}));
mock.module('util/logger', () => ({ Logger: class { error() {} debug() {} info() {} warn() {} } }));
const { enrollLocalPasskey, unlockWithLocalPasskey, forgetLocalPasskey, hasLocalPasskey,
    hasLocalPasskeyData, canUseLocalPasskeys, localPasskeyError } = await import('../../ui/src/local-passkeys');
const { SettingsStore } = await import('comp/settings/settings-store');
const keep = () => true;
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const keyFile = (text: string) => new File([text], 'vault.keyx');
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
class List<T extends { id: string }> extends Array<T> { get(id: string) { return this.find((value) => value.id === id); } }
function info(id: string): FileInfoModel {
    return { id, name: 'Vault', storage: null, path: null, opts: null, keyFileName: null, keyFileHash: null,
        chalResp: null, passkeyCredentialId: null, passkeyPrfSalt: null, passkeyWrappedKey: null, passkeyCreatedDate: null,
        set(props: object) { Object.assign(this, props); }
    } as unknown as FileInfoModel;
}
async function fixture(keyText?: string) {
    const credentials = new Credentials(ProtectedValue.fromString('master'), keyText ? bytes(keyText) : undefined);
    await credentials.ready;
    const db = Kdbx.create(credentials, 'Vault');
    db.header.kdfParameters!.set('M', VarDictionary.ValueType.UInt64, Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', VarDictionary.ValueType.UInt64, Int64.from(2));
    db.createEntry(db.getDefaultGroup()).fields.set('Title', 'Encrypted evidence');
    const encrypted = await db.save();
    const file = { id: 'one', name: 'Vault', active: true, demo: false, db, syncing: false, modified: false,
        dirty: false, passwordChanged: false, keyFileChanged: false, chalResp: null } as FileModel;
    const fi = info('one'); if (keyText) fi.keyFileName = 'vault.keyx';
    const files = new List<FileModel>(file), infos = new List(fi, info('two'));
    let loaded: Kdbx | undefined;
    const open = mock((params: Parameters<AppModel['openFile']>[0], done: (error?: unknown, file?: FileModel) => void) => {
        void (async () => {
            if (!params.canOpen?.()) throw new Error('Open canceled');
            loaded = await Kdbx.load(encrypted, new Credentials(params.password!, params.keyFileData));
            if (!params.canOpen?.()) throw new Error('Open canceled');
            done();
        })().catch(done);
    });
    const model = { files, fileInfos: infos, settings: { rememberKeyFiles: 'none' }, openFile: open } as unknown as AppModel;
    return { file, fi, model, open, files, infos, encrypted, loaded: () => loaded };
}
let storage: Record<string, string>;
beforeEach(() => {
    CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) =>
        ByteUtils.arrayToBuffer(await (type === CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id)({
            password: new Uint8Array(password), salt: new Uint8Array(salt), memorySize: memory,
            iterations, parallelism, hashLength: length, outputType: 'binary'
        })));

    available = true; create = async () => registration(); evaluate = async () => prf.slice();
    registered.mockClear(); evaluated.mockClear(); storage = {};
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });
});

describe('New local passkey operations', () => {
    test('enrollment persists only wrapped material; unlock decrypts a real KDBX and leaves credentials unchanged', async () => {
        const h = await fixture(); const original = h.file.db.credentials.passwordHash;
        await enrollLocalPasskey(h.model, h.file, 'master', undefined, keep);
        expect(hasLocalPasskey(h.fi)).toBe(true);
        expect(Object.values(storage).join('')).not.toContain('master');
        expect(h.file.db.credentials.passwordHash).toBe(original);
        expect(h.file.dirty).toBe(false);
        h.files.length = 0;
        await unlockWithLocalPasskey(h.model, h.fi.id, null, keep);
        expect(h.open).toHaveBeenCalledTimes(1);
        expect(h.loaded()!.getDefaultGroup().entries[0].fields.get('Title')).toBe('Encrypted evidence');
        const passed = h.open.mock.calls[0][0].password!;
        expect([...passed.value, ...passed.salt].every((b) => b === 0)).toBe(true);
    });
    test('key-file enrollment and unlock require the correct factor; no key bytes are persisted by enrollment', async () => {
        const h = await fixture('required');
        await expect(enrollLocalPasskey(h.model, h.file, 'master', undefined, keep)).rejects.toThrow('current key file');
        await expect(enrollLocalPasskey(h.model, h.file, 'master', keyFile('wrong'), keep)).rejects.toThrow('Wrong password or key file');
        await expect(enrollLocalPasskey(h.model, h.file, 'wrong', keyFile('required'), keep)).rejects.toThrow('Wrong password or key file');
        expect(registered).not.toHaveBeenCalled();
        await enrollLocalPasskey(h.model, h.file, 'master', keyFile('required'), keep);
        expect(h.fi.keyFileHash).toBeNull(); h.files.length = 0;
        await expect(unlockWithLocalPasskey(h.model, h.fi.id, null, keep)).rejects.toThrow('Select the key file');
        expect(evaluated).not.toHaveBeenCalled();
        await expect(unlockWithLocalPasskey(h.model, h.fi.id, { name: 'bad', data: btoa('wrong') }, keep)).rejects.toMatchObject({ code: 'InvalidKey' });
        await unlockWithLocalPasskey(h.model, h.fi.id, { name: 'good', data: btoa('required') }, keep);
        expect(h.loaded()).toBeDefined();
    });
    test('missing or partial registrations never prompt; forgetting a partial descriptor preserves other vaults', async () => {
        const h = await fixture(); h.files.length = 0;
        await expect(unlockWithLocalPasskey(h.model, h.fi.id, null, keep)).rejects.toThrow('No complete');
        h.fi.passkeyCredentialId = 'partial';
        expect(hasLocalPasskeyData(h.fi)).toBe(true); expect(hasLocalPasskey(h.fi)).toBe(false);
        await expect(unlockWithLocalPasskey(h.model, h.fi.id, null, keep)).rejects.toThrow('No complete');
        const other = h.infos[1]; other.passkeyCredentialId = 'unrelated';
        forgetLocalPasskey(h.model, h.fi.id, keep);
        expect(h.infos).toHaveLength(2); expect(h.fi.passkeyCredentialId).toBeNull();
        expect(other.passkeyCredentialId).toBe('unrelated'); expect(evaluated).not.toHaveBeenCalled();
    });
    test.each(['NotAllowedError', 'AbortError'])('%s preserves registration and permits password fallback', async (name) => {
        const h = await fixture(); await enrollLocalPasskey(h.model, h.file, 'master', undefined, keep);
        const saved = h.fi.passkeyWrappedKey;
        create = async () => { throw new DOMException('canceled', name); };
        await expect(enrollLocalPasskey(h.model, h.file, 'master', undefined, keep)).rejects.toMatchObject({ name });
        expect(h.fi.passkeyWrappedKey).toBe(saved); h.files.length = 0;
        evaluate = async () => { throw new DOMException('canceled', name); };
        await expect(unlockWithLocalPasskey(h.model, h.fi.id, null, keep)).rejects.toMatchObject({ name });
        expect(h.fi.passkeyWrappedKey).toBe(saved); expect(h.open).not.toHaveBeenCalled();
        expect(localPasskeyError(new DOMException('', name))).toContain('canceled');
        await expect(Kdbx.load(h.encrypted, new Credentials(ProtectedValue.fromString('master')))).resolves.toBeDefined();
    });
    test('unsupported environments and PRF refusal fail without automatically forgetting registrations', async () => {
        const h = await fixture(); await enrollLocalPasskey(h.model, h.file, 'master', undefined, keep);
        const saved = h.fi.passkeyWrappedKey; available = false;
        await expect(enrollLocalPasskey(h.model, h.file, 'master', undefined, keep)).rejects.toThrow('unavailable');
        h.files.length = 0;
        await expect(unlockWithLocalPasskey(h.model, h.fi.id, null, keep)).rejects.toThrow('unavailable');
        available = true; evaluate = async () => { throw new primitive.PasskeyPrfNotSupportedError(); };
        await expect(unlockWithLocalPasskey(h.model, h.fi.id, null, keep)).rejects.toMatchObject({ name: 'PasskeyPrfNotSupportedError' });
        expect(h.fi.passkeyWrappedKey).toBe(saved); expect(h.open).not.toHaveBeenCalled();
        Object.defineProperty(globalThis, 'isSecureContext', { value: false, configurable: true });
        expect(canUseLocalPasskeys()).toBe(false);
    });
    test('corrupt wrapped material fails before KDBX open and preserves password fallback', async () => {
        const h = await fixture(); await enrollLocalPasskey(h.model, h.file, 'master', undefined, keep);
        h.fi.passkeyWrappedKey = btoa('invalid ciphertext'); h.files.length = 0;
        await expect(unlockWithLocalPasskey(h.model, h.fi.id, null, keep)).rejects.toThrow();
        expect(h.open).not.toHaveBeenCalled();
        await expect(Kdbx.load(h.encrypted, new Credentials(ProtectedValue.fromString('master')))).resolves.toBeDefined();
    });
    for (const change of ['securing', 'recovery', 'reopened', 'unmounted', 'db', 'credentials', 'reset', 'deleted', 'forgotten'] as const) {
        test(`late enrollment after ${change} cannot publish`, async () => {
            const h = await fixture(), entered = deferred<void>(), pending = deferred<ReturnType<typeof registration>>();
            let mounted = true;
            create = () => { entered.resolve(); return pending.promise; };
            const operation = enrollLocalPasskey(h.model, h.file, 'master', undefined, () => mounted);
            await entered.promise;
            let drained = false;
            const wait = waitForPendingOperations(h.model, new AbortController().signal).then(() => { drained = true; });
            await Promise.resolve(); expect(drained).toBe(false);
            const gate = getSessionAccess(h.model);
            if (change === 'securing') gate.beginSecuring();
            if (change === 'recovery') gate.requireRecovery(gate.beginSecuring());
            if (change === 'reopened') {
                const epoch = gate.requireRecovery(gate.beginSecuring()); await gate.prepareRecovery(epoch);
                await gate.verifyVault(epoch, h.file.id, { password: 'master' }); gate.resumeRecovery(epoch);
            }
            if (change === 'unmounted') mounted = false;
            if (change === 'db') h.file.db = Kdbx.create(h.file.db.credentials, 'replacement');
            if (change === 'credentials') h.file.db.credentials = new Credentials(ProtectedValue.fromString('master'));
            if (change === 'reset') resetCredentialHash(h.file.db.credentials, 'password', h.file.db.credentials.passwordHash);
            if (change === 'deleted') h.infos.splice(0, 1);
            if (change === 'forgotten') forgetLocalPasskey(h.model, h.fi.id, keep);
            pending.resolve(registration());
            await expect(operation).rejects.toThrow(); await wait;
            expect(hasLocalPasskey(h.fi)).toBe(false); expect(drained).toBe(true);
        });
    }
    test.each(['unmounted', 'replaced', 'forgotten', 'epoch'])('late PRF completion after %s never starts open', async (change) => {
        const h = await fixture(); await enrollLocalPasskey(h.model, h.file, 'master', undefined, keep);
        h.files.length = 0; const pending = deferred<Uint8Array>(); let mounted = true;
        evaluate = () => pending.promise;
        const operation = unlockWithLocalPasskey(h.model, h.fi.id, null, () => mounted);
        if (change === 'unmounted') mounted = false;
        if (change === 'replaced') h.infos[0] = info('one');
        if (change === 'forgotten') forgetLocalPasskey(h.model, h.fi.id, keep);
        if (change === 'epoch') getSessionAccess(h.model).beginSecuring();
        pending.resolve(prf.slice()); await expect(operation).rejects.toThrow();
        expect(h.open).not.toHaveBeenCalled();
    });
    test('extra factors, key-only and unsaved credentials cannot be enrolled', async () => {
        const h = await fixture(); h.file.chalResp = {};
        await expect(enrollLocalPasskey(h.model, h.file, 'master', undefined, keep)).rejects.toThrow('factors');
        h.file.chalResp = null; h.file.modified = true;
        await expect(enrollLocalPasskey(h.model, h.file, 'master', undefined, keep)).rejects.toThrow('Save the vault');
        h.file.modified = false; h.file.db.credentials.passwordHash = undefined;
        await expect(enrollLocalPasskey(h.model, h.file, '', undefined, keep)).rejects.toThrow('factors');
        expect(registered).not.toHaveBeenCalled();
    });
    test('factor failure waits for the other hash before scrubbing owned inputs and releasing the pending operation', async () => {
        const h = await fixture('required'), pending = deferred<void>(), entered = deferred<void>();
        const originalPassword = Credentials.prototype.setPassword, originalKey = Credentials.prototype.setKeyFile;
        let candidate: Credentials | undefined, supplied: ProtectedValue | null | undefined, copiedKey: ArrayBuffer | undefined;
        Credentials.prototype.setPassword = function(value) {
            if (!value) return originalPassword.call(this, value);
            candidate = this; supplied = value; entered.resolve();
            return pending.promise.then(() => originalPassword.call(this, value));
        };
        Credentials.prototype.setKeyFile = function(value) {
            if (!value) return originalKey.call(this, value);
            copiedKey = value as ArrayBuffer;
            return Promise.reject(new Error('invalid key encoding'));
        };
        try {
            const operation = enrollLocalPasskey(h.model, h.file, 'master', keyFile('required'), keep);
            await entered.promise;
            let drained = false;
            const drain = waitForPendingOperations(h.model, new AbortController().signal).then(() => { drained = true; });
            await Promise.resolve(); expect(drained).toBe(false);
            pending.resolve();
            await expect(operation).rejects.toThrow('Wrong password or key file'); await drain;
            expect(new Uint8Array(copiedKey!).every((byte) => byte === 0)).toBe(true);
            expect([...supplied!.value, ...supplied!.salt].every((byte) => byte === 0)).toBe(true);
            expect([...candidate!.passwordHash!.value, ...candidate!.passwordHash!.salt].every((byte) => byte === 0)).toBe(true);
            expect(registered).not.toHaveBeenCalled();
        } finally {
            Credentials.prototype.setPassword = originalPassword;
            Credentials.prototype.setKeyFile = originalKey;
        }
    });
    test('pending-operation registration precedes key-file read; locking during that read blocks registration', async () => {
        const h = await fixture('required'), entered = deferred<void>(), read = deferred<ArrayBuffer>();
        const temporary = bytes('required');
        const selected = { arrayBuffer: () => { entered.resolve(); return read.promise; } } as File;
        const operation = enrollLocalPasskey(h.model, h.file, 'master', selected, keep);
        await entered.promise;
        let drained = false;
        const drain = waitForPendingOperations(h.model, new AbortController().signal).then(() => { drained = true; });
        getSessionAccess(h.model).beginSecuring();
        await Promise.resolve(); expect(drained).toBe(false);
        read.resolve(temporary);
        await expect(operation).rejects.toThrow(); await drain;
        expect(new Uint8Array(temporary).every((byte) => byte === 0)).toBe(true);
        expect(registered).not.toHaveBeenCalled();
    });
    test.each(['unavailable', 'silently dropped'])('%s persistence restores enrollment/forget state with saveRequired', async (mode) => {
        const h = await fixture(); await enrollLocalPasskey(h.model, h.file, 'master', undefined, keep);
        const previous = JSON.stringify(h.infos), persisted = { ...storage };
        Object.defineProperty(globalThis, 'localStorage', { configurable: true,
            value: mode === 'unavailable' ? undefined : new Proxy(storage, { set() { return true; } }) });
        await expect(enrollLocalPasskey(h.model, h.file, 'master', undefined, keep)).rejects.toThrow('Could not save');
        expect(JSON.stringify(h.infos)).toBe(previous);
        expect(storage).toEqual(persisted);
        expect(() => forgetLocalPasskey(h.model, h.fi.id, keep)).toThrow('Could not save');
        expect(JSON.stringify(h.infos)).toBe(previous);
        expect(storage).toEqual(persisted);
    });
    test('storage failure rolls back only local descriptor; legacy save remains nonthrowing', async () => {
        const h = await fixture(); await enrollLocalPasskey(h.model, h.file, 'master', undefined, keep);
        const previous = h.fi.passkeyWrappedKey;
        Object.defineProperty(globalThis, 'localStorage', { value: new Proxy({}, { set() { throw new Error('quota'); } }), configurable: true });
        await expect(enrollLocalPasskey(h.model, h.file, 'master', undefined, keep)).rejects.toThrow('Could not save');
        expect(h.fi.passkeyWrappedKey).toBe(previous);
        expect(() => forgetLocalPasskey(h.model, h.fi.id, keep)).toThrow('Could not save');
        expect(h.fi.passkeyWrappedKey).toBe(previous);
        await expect(SettingsStore.save('file-info', h.infos)).resolves.toBeUndefined();
    });
});
