import { ByteUtils, Credentials, ProtectedValue } from 'kdbxweb';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import type { FileInfoModel } from 'models/file-info-model';
import { getSessionAccess } from 'comp/app/session-access';
import { SettingsStore } from 'comp/settings/settings-store';
import { isPasskeyPrfSupported } from 'comp/passkey/passkey-prf';
import { enablePasskeyForFile, unlockFileWithPasskey } from 'comp/passkey/passkey-unlock';
import { credentialChangeVersion, isSupportedCredentialShape, waitForCredentialChanges } from 'util/kdbxweb/credential-changes';
import { beginPendingOperation } from './pending-operations';

const attempts = new WeakMap<FileInfoModel, object>();
const descriptorKeys = ['passkeyCredentialId', 'passkeyPrfSalt', 'passkeyWrappedKey', 'passkeyCreatedDate'] as const;
function descriptor(info: FileInfoModel) {
    return {
        passkeyCredentialId: info.passkeyCredentialId, passkeyPrfSalt: info.passkeyPrfSalt,
        passkeyWrappedKey: info.passkeyWrappedKey, passkeyCreatedDate: info.passkeyCreatedDate
    };
}
export function hasLocalPasskey(info: FileInfoModel | undefined): boolean {
    return !!(info?.passkeyCredentialId && info.passkeyPrfSalt && info.passkeyWrappedKey);
}
export function hasLocalPasskeyData(info: FileInfoModel | undefined): boolean {
    return !!info && descriptorKeys.some((key) => !!info[key]);
}
export function canUseLocalPasskeys(): boolean {
    return globalThis.isSecureContext === true && isPasskeyPrfSupported();
}
function requireSupport(): void {
    if (!canUseLocalPasskeys()) throw new Error('Passkey unlock is unavailable here. Use your password and any required key file.');
}
function erase(value?: ProtectedValue | null): void {
    if (value) { ByteUtils.zeroBuffer(value.value); ByteUtils.zeroBuffer(value.salt); }
}
function matches(left?: ProtectedValue, right?: ProtectedValue): boolean {
    if (!left || !right) return left === right;
    const a = left.getBinary(), b = right.getBinary();
    try {
        let diff = a.length ^ b.length;
        for (let i = 0; i < Math.max(a.length, b.length); ++i) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
        return diff === 0;
    } finally { ByteUtils.zeroBuffer(a); ByteUtils.zeroBuffer(b); }
}
function capture(model: AppModel, info: FileInfoModel, current: () => boolean) {
    const access = getSessionAccess(model), epoch = access.epoch;
    const initial = descriptor(info);
    const identity = [info.id, info.name, info.storage, info.path, info.opts, info.keyFileName, info.keyFileHash, info.chalResp];
    const attempt = {};
    attempts.set(info, attempt);
    const valid = () => access.state === 'open' && access.isCurrent(epoch) && current() &&
        model.fileInfos.get(info.id) === info && attempts.get(info) === attempt &&
        descriptorKeys.every((key) => info[key] === initial[key]) &&
        [info.id, info.name, info.storage, info.path, info.opts, info.keyFileName, info.keyFileHash, info.chalResp]
            .every((value, i) => value === identity[i]);
    const check = () => { if (!valid()) throw new Error('The vault or session changed. Try again.'); };
    check();
    return { check, valid };
}
function persist(model: AppModel, info: FileInfoModel, next: ReturnType<typeof descriptor>): void {
    const previous = descriptor(info);
    info.set(next, { silent: true });
    try { SettingsStore.saveRequired('file-info', model.fileInfos); }
    catch {
        info.set(previous, { silent: true });
        throw new Error('Could not save the passkey settings in this browser. The previous local settings were kept; a newly created authenticator credential may need to be removed separately.');
    }
}

/** Local descriptor only: this never deletes a credential from an authenticator or changes KDBX. */
export function forgetLocalPasskey(model: AppModel, id: string, current: () => boolean): void {
    const info = model.fileInfos.get(id);
    if (!info) throw new Error('Unknown vault');
    capture(model, info, current).check(); // also invalidates any outstanding ceremony
    persist(model, info, {
        passkeyCredentialId: null, passkeyPrfSalt: null, passkeyWrappedKey: null, passkeyCreatedDate: null
    });
}

/** Caller supplies a live mount predicate. Pending-operation tracking starts before the first await. */
export async function enrollLocalPasskey(
    model: AppModel, file: FileModel, password: string, keyFile: File | undefined, current: () => boolean
): Promise<void> {
    requireSupport();
    const info = model.fileInfos.get(file.id);
    if (!info) throw new Error('Save and reopen this vault before enabling passkey unlock.');
    const guard = capture(model, info, current);
    const db = file.db, credentials = db.credentials, version = credentialChangeVersion(credentials);
    const check = () => {
        guard.check();
        if (model.files.get(file.id) !== file || !file.active || file.demo || file.db !== db ||
            db.credentials !== credentials || credentialChangeVersion(credentials) !== version) {
            throw new Error('The vault credentials changed. Try again.');
        }
        if (file.syncing || file.modified || file.dirty || file.passwordChanged || file.keyFileChanged) {
            throw new Error('Save the vault successfully before enabling passkey unlock.');
        }
        if (!isSupportedCredentialShape(credentials) || file.chalResp || !credentials.passwordHash) throw new Error('This vault requires factors that passkey unlock cannot support.');
    };
    guard.check();
    const finish = beginPendingOperation(model);
    let key: ArrayBuffer | undefined, candidate: Credentials | undefined;
    let input: ProtectedValue | undefined;
    try {
        await waitForCredentialChanges(credentials);
        check();
        const passwordHash = credentials.passwordHash, keyHash = credentials.keyFileHash;
        const checkFactors = () => {
            check();
            if (credentials.passwordHash !== passwordHash || credentials.keyFileHash !== keyHash) {
                throw new Error('The vault credentials changed. Try again.');
            }
        };
        if (!!keyHash !== !!keyFile) throw new Error('Provide the current key file when this vault requires one.');
        if (keyFile) key = await keyFile.arrayBuffer();
        checkFactors();
        input = ProtectedValue.fromString(password);
        candidate = new Credentials(null);
        await candidate.ready;
        const results = await Promise.allSettled([candidate.setPassword(input), candidate.setKeyFile(key)]);
        checkFactors();
        if (results.some((result) => result.status === 'rejected') ||
            !matches(passwordHash, candidate.passwordHash) || !matches(keyHash, candidate.keyFileHash)) {
            throw new Error('Wrong password or key file.');
        }
        const result = await enablePasskeyForFile(file.id, file.name, password);
        checkFactors();
        persist(model, info, {
            passkeyCredentialId: result.credentialIdBase64, passkeyPrfSalt: result.prfSaltBase64,
            passkeyWrappedKey: result.wrappedKeyBase64, passkeyCreatedDate: result.createdDate
        });
    } finally {
        if (key) ByteUtils.zeroBuffer(key);
        erase(input); erase(candidate?.passwordHash); erase(candidate?.keyFileHash);
        finish();
    }
}

/** The unwrapped password stays protected and goes through AppModel's normal KDBX verification. */
export async function unlockWithLocalPasskey(
    model: AppModel, id: string, keyFile: { name: string; data: string } | null, current: () => boolean
): Promise<void> {
    requireSupport();
    const info = model.fileInfos.get(id);
    if (!info || !hasLocalPasskey(info)) throw new Error('No complete passkey registration. Use your password.');
    if (info.chalResp) throw new Error('This vault requires additional factors. Open it in Classic.');
    if (model.files.get(id)) throw new Error('This vault is already open.');
    if ((info.keyFileName || info.keyFileHash) && !keyFile &&
        !(model.settings.rememberKeyFiles === 'data' && info.keyFileHash)) {
        throw new Error('Select the key file first. A passkey replaces only the master password.');
    }
    const guard = capture(model, info, current);
    const finish = beginPendingOperation(model);
    let secret: ProtectedValue | undefined, key: ArrayBuffer | undefined;
    try {
        const result = await unlockFileWithPasskey(id, {
            credentialId: info.passkeyCredentialId!, prfSalt: info.passkeyPrfSalt!, wrappedKey: info.passkeyWrappedKey!
        });
        secret = result.password;
        guard.check();
        if (keyFile) key = ByteUtils.arrayToBuffer(ByteUtils.base64ToBytes(keyFile.data));
        await new Promise<void>((resolve, reject) => {
            model.openFile({
                id, name: info.name, storage: info.storage ?? undefined, path: info.path ?? undefined,
                opts: info.opts ?? undefined, password: secret, keyFileData: key,
                keyFileName: keyFile?.name ?? info.keyFileName ?? undefined, canOpen: guard.valid
            }, (error) => error ? reject(error) : resolve());
        });
        // Leave legacy ciphertext migration to Classic. Admission replaces FileInfo and unmounts
        // the unlock card; no descriptor mutation is allowed after that boundary here.
    } finally { erase(secret); if (key) ByteUtils.zeroBuffer(key); finish(); }
}

export function localPasskeyError(error: unknown): string {
    const name = (error as { name?: string })?.name;
    if (name === 'NotAllowedError' || name === 'AbortError') return 'Passkey request canceled. You can still use your password.';
    if (name === 'PasskeyPrfNotSupportedError') return 'This authenticator does not support passkey unlock. Use your password or try another authenticator.';
    if ((error as { code?: string })?.code === 'InvalidKey') return 'Wrong password or key file. Use your current password and any required key file.';
    return error instanceof Error && !(error instanceof DOMException) ? error.message : 'Passkey request failed. Use your password and any required key file.';
}
