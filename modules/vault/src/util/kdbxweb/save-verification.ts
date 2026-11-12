import { ByteUtils, Credentials, Kdbx, ProtectedValue } from 'kdbxweb';

export class SaveVerificationError extends Error {
    readonly code = 'SaveVerificationFailed';
    constructor() { super('Save verification failed. Keep this vault open and retry saving.'); }
}

/** Called after credential changes settle, before serialization starts. No rehashing. */
export function captureSaveCredentials(credentials: Credentials): Credentials {
    const allowed = new Set(['ready', 'passwordHash', 'keyFileHash', '_challengeResponse']);
    if (Object.getPrototypeOf(credentials) !== Credentials.prototype ||
        Reflect.ownKeys(credentials).some((key) => typeof key !== 'string' || !allowed.has(key) ||
            !('value' in Object.getOwnPropertyDescriptor(credentials, key)!))) throw new SaveVerificationError();
    const copy = Object.create(Credentials.prototype) as Credentials;
    const hash = (value?: ProtectedValue) => {
        if (!value) return undefined;
        if (Object.getPrototypeOf(value) !== ProtectedValue.prototype) throw new SaveVerificationError();
        return new ProtectedValue(ByteUtils.arrayToBuffer(value.value.slice()), ByteUtils.arrayToBuffer(value.salt.slice()));
    };
    try {
        copy.passwordHash = hash(credentials.passwordHash);
        copy.keyFileHash = hash(credentials.keyFileHash);
    } catch (error) {
        releaseSaveCredentials(copy);
        throw error;
    }
    // Preserve Classic's callback without retaining its mutable credential object.
    Object.defineProperty(copy, '_challengeResponse', {
        value: Object.getOwnPropertyDescriptor(credentials, '_challengeResponse')?.value, writable: true
    });
    Object.defineProperty(copy, 'ready', { value: Promise.resolve(copy) });
    return copy;
}

export function releaseSaveCredentials(credentials: Credentials): void {
    for (const value of [credentials.passwordHash, credentials.keyFileHash]) {
        if (value) { ByteUtils.zeroBuffer(value.value); ByteUtils.zeroBuffer(value.salt); }
    }
}

/** Reopen the exact serialized bytes with their detached factors before any durable write. */
export async function verifySavedData(data: ArrayBuffer, credentials: Credentials): Promise<void> {
    try { await Kdbx.load(data, credentials); }
    catch { throw new SaveVerificationError(); }
}
