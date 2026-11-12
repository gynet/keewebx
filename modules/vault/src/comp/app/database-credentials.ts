import { ByteUtils, Credentials, CryptoEngine, ProtectedValue } from 'kdbxweb';
import type { FileModel } from 'models/file-model';
import { credentialChangeVersion, isSupportedCredentialShape, waitForCredentialChanges } from '../../util/kdbxweb/credential-changes';

export interface DatabaseCredentialDraft {
    password: { action: 'keep' | 'reset' } | { action: 'set'; value: string; confirmation: string };
    keyFile: { action: 'keep' | 'reset' | 'remove' } | { action: 'set'; data: ArrayBuffer; name: string };
}

/** Capture when editing starts; a changed credential or reset baseline requires a fresh draft. */
export function captureDatabaseCredentials(file: FileModel) {
    const credentials = file.db.credentials;
    return {
        db: file.db, credentials, version: credentialChangeVersion(credentials),
        passwordHash: credentials.passwordHash, keyFileHash: credentials.keyFileHash,
        oldPasswordHash: file.oldPasswordHash, oldKeyFileHash: file.oldKeyFileHash,
        keyFileName: file.keyFileName, oldKeyFileName: file.oldKeyFileName
    };
}
export type DatabaseCredentialBaseline = ReturnType<typeof captureDatabaseCredentials>;

/**
 * Explicit in-memory apply, not persistence. Prepare every factor once, then synchronously commit
 * all factors/metadata after the last baseline and permission check. Register the entire operation
 * with session coordination before calling. This does not roll back a completed commit.
 * Owned mutable staging buffers are erased after all preparation tasks settle. Input strings and
 * File objects remain caller-owned; JavaScript strings and crypto-engine internals cannot be wiped here.
 */
export async function applyDatabaseCredentials(
    file: FileModel, baseline: DatabaseCredentialBaseline, draft: DatabaseCredentialDraft,
    canApply: () => boolean
): Promise<void> {
    const assertCurrent = () => {
        if (!canApply() || !file.active) throw new Error('The vault is no longer available for this change.');
        if (file.syncing) throw new Error('A save is in progress. Wait for it to finish, then retry.');
        if (file.chalResp || !isSupportedCredentialShape(file.db.credentials)) throw new Error('Manage additional authentication factors in Classic.');
        const live = captureDatabaseCredentials(file);
        if (Object.keys(baseline).some((key) => live[key as keyof typeof live] !== baseline[key as keyof typeof baseline])) {
            throw new Error('Credentials changed while editing. Discard this draft and try again.');
        }
    };
    assertCurrent();
    if (draft.password.action === 'set' && (!draft.password.value || draft.password.value !== draft.password.confirmation)) {
        throw new Error('Enter a new password and matching confirmation.');
    }
    if (draft.keyFile.action === 'set' && (!draft.keyFile.name || !draft.keyFile.data.byteLength)) {
        throw new Error('Select a non-empty key file.');
    }
    const passwordBytes = draft.password.action === 'set' ? new TextEncoder().encode(draft.password.value) : undefined;
    const keyData = draft.keyFile.action === 'set' ? draft.keyFile.data.slice(0) : undefined;
    let staged: Credentials | undefined;
    try {
        staged = new Credentials(null);
        await staged.ready;
        const candidate = staged;
        // Own the password byte buffer so it is erased on digest rejection as well as success.
        // allSettled is essential: a failed factor cannot leave a sibling using staging buffers.
        const results = await Promise.allSettled([
            passwordBytes ? Promise.resolve().then(() => CryptoEngine.sha256(ByteUtils.arrayToBuffer(passwordBytes)))
                .then((hash) => { candidate.passwordHash = ProtectedValue.fromBinary(hash); }) : Promise.resolve(),
            keyData ? Promise.resolve().then(() => candidate.setKeyFile(keyData)) : Promise.resolve()
        ]);
        if (results.some((result) => result.status === 'rejected')) {
            throw new Error('Could not prepare credentials. No credential changes were applied.');
        }
        // Only explicitly replaced factors may recover from a failed Classic setter.
        await waitForCredentialChanges(baseline.credentials, [
            ...(draft.password.action !== 'keep' ? ['password' as const] : []),
            ...(draft.keyFile.action !== 'keep' ? ['keyFile' as const] : [])
        ]);
        assertCurrent();
        const passwordHash = draft.password.action === 'set' ? staged.passwordHash
            : draft.password.action === 'reset' ? file.oldPasswordHash : baseline.passwordHash;
        const keyFileHash = draft.keyFile.action === 'set' ? staged.keyFileHash
            : draft.keyFile.action === 'reset' ? file.oldKeyFileHash
                : draft.keyFile.action === 'remove' ? undefined : baseline.keyFileHash;
        if (!passwordHash && !keyFileHash) throw new Error('Keep a password or a key file to protect this database.');
        if (draft.password.action === 'keep' && draft.keyFile.action === 'keep') return;
        const passwordChanged = draft.password.action === 'set' || (draft.password.action === 'keep' && file.passwordChanged);
        const keyFileChanged = draft.keyFile.action === 'set' || (draft.keyFile.action === 'keep' && file.keyFileChanged) ||
            (draft.keyFile.action === 'remove' && !!file.oldKeyFileHash);
        const keyChanged = draft.password.action === 'set' || draft.keyFile.action === 'set' ||
            (draft.keyFile.action === 'remove' && keyFileChanged) ? new Date()
            : !passwordChanged && !keyFileChanged && passwordHash === file.oldPasswordHash && keyFileHash === file.oldKeyFileHash
                ? file.oldKeyChangeDate : file.db.meta.keyChanged;
        file.commitPreparedCredentials({
            db: baseline.db, credentials: baseline.credentials, version: baseline.version,
            passwordHash, keyFileHash, passwordChanged, keyFileChanged, keyChanged,
            passwordLength: draft.password.action === 'set' ? draft.password.value.length
                : draft.password.action === 'reset' ? file.oldPasswordLength : file.passwordLength,
            keyFileName: draft.keyFile.action === 'set' ? draft.keyFile.name : draft.keyFile.action === 'reset'
                ? file.oldKeyFileName : draft.keyFile.action === 'remove' ? '' : file.keyFileName,
            removeKeyFile: draft.keyFile.action === 'remove'
        }, () => { assertCurrent(); return true; });
    } finally {
        if (passwordBytes) ByteUtils.zeroBuffer(passwordBytes);
        if (keyData) ByteUtils.zeroBuffer(keyData);
        for (const hash of [staged?.passwordHash, staged?.keyFileHash]) {
            if (hash) { ByteUtils.zeroBuffer(hash.value); ByteUtils.zeroBuffer(hash.salt); }
        }
    }
}
