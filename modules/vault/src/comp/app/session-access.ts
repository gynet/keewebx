import { ByteUtils, Credentials, ProtectedValue } from 'kdbxweb';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { credentialChangeVersion, isSupportedCredentialShape, waitForCredentialChanges } from '../../util/kdbxweb/credential-changes';

export type SessionAccessState = 'open' | 'securing' | 'recovery-required' | 'closed';
export interface RecoveryVault {
    readonly id: string;
    readonly name: string;
    readonly requiresPassword: boolean;
    readonly requiresKeyFile: boolean;
}
export interface RecoveryInput {
    password?: string;
    keyFile?: ArrayBuffer | Uint8Array;
}
export class SessionAccessError extends Error {
    constructor(readonly code: 'access-denied' | 'stale-session' | 'session-changed' | 'credentials-not-ready' |
        'unsupported-recovery' | 'invalid-credentials' | 'incomplete-recovery' | 'invalid-state') {
        super(code);
        this.name = 'SessionAccessError';
    }
}

interface Target {
    file: FileModel;
    id: string;
    db: FileModel['db'];
    credentials: Credentials;
    version: object;
}
interface Reference extends Target {
    sourcePassword?: ProtectedValue;
    sourceKey?: ProtectedValue;
    password?: ProtectedValue;
    key?: ProtectedValue;
}

function detached(value?: ProtectedValue): ProtectedValue | undefined {
    return value && new ProtectedValue(
        ByteUtils.arrayToBuffer(value.value.slice()), ByteUtils.arrayToBuffer(value.salt.slice())
    );
}
function erase(value?: ProtectedValue): void {
    if (value) { ByteUtils.zeroBuffer(value.value); ByteUtils.zeroBuffer(value.salt); }
}
function sameFactor(a?: ProtectedValue, b?: ProtectedValue): boolean {
    if (!a || !b) return a === b;
    const left = a.getBinary();
    let right: Uint8Array | undefined;
    try {
        right = b.getBinary();
        let difference = left.length ^ right.length;
        for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
        return difference === 0;
    } finally { ByteUtils.zeroBuffer(left); if (right) ByteUtils.zeroBuffer(right); }
}
function supported(target: Target): boolean {
    return !target.file.chalResp && isSupportedCredentialShape(target.credentials);
}

/** In-memory access suspension, not a cryptographic lock or proof of persisted credentials. */
export class SessionAccess {
    #phase: SessionAccessState = 'open';
    #generation = 0;
    #targets: Target[] = [];
    #references: Reference[] | undefined;
    #approved = new Set<string>();
    #attempts = new Map<string, object>();
    #invalid = false;
    #invalidationListeners = new Set<() => void>();

    readonly #model: AppModel;
    constructor(model: AppModel) { this.#model = model; }
    get state(): SessionAccessState { return this.#phase; }
    get epoch(): number { return this.#generation; }
    subscribeInvalidation(listener: () => void): () => void {
        this.#invalidationListeners.add(listener);
        return () => { this.#invalidationListeners.delete(listener); };
    }
    #notifyInvalidation(): void {
        for (const listener of [...this.#invalidationListeners]) {
            try { listener(); } catch { console.error('Session access observer failed'); }
        }
    }
    isCurrent(epoch: number): boolean { return epoch === this.#generation; }
    assertOpen(expectedEpoch?: number): void {
        if (this.#phase !== 'open') throw new SessionAccessError('access-denied');
        if (expectedEpoch !== undefined && !this.isCurrent(expectedEpoch)) throw new SessionAccessError('stale-session');
    }

    /** Explicit opt-in by New. Repeated idle/manual requests never replace a gated target set. */
    beginSecuring(): number {
        if (this.#phase !== 'open') return this.#generation;
        this.#phase = 'securing';
        ++this.#generation;
        this.#notifyInvalidation();
        this.#invalid = false;
        this.#targets = this.#activeRealFiles().map((file) => ({
            file, id: file.id, db: file.db, credentials: file.db.credentials,
            version: credentialChangeVersion(file.db.credentials)
        }));
        if (new Set(this.#targets.map((target) => target.id)).size !== this.#targets.length) this.#invalidate();
        return this.#generation;
    }

    /** Invalidates the securing/close epoch before exposing a recovery surface. */
    requireRecovery(epoch: number): number {
        this.#expectEpoch(epoch);
        if (this.#phase === 'recovery-required') return this.#generation;
        if (this.#phase !== 'securing') throw new SessionAccessError('invalid-state');
        this.#phase = 'recovery-required';
        ++this.#generation;
        this.#notifyInvalidation();
        this.#clearReferences();
        return this.#generation;
    }

    async prepareRecovery(epoch: number): Promise<readonly RecoveryVault[]> {
        this.#expectRecovery(epoch);
        this.#checkTargets();
        if (!this.#targets.length || this.#targets.some((target) => !supported(target))) {
            throw new SessionAccessError('unsupported-recovery');
        }
        if (!this.#references) {
            try { await Promise.all(this.#targets.map((target) => waitForCredentialChanges(target.credentials))); }
            catch { this.#expectRecovery(epoch); throw new SessionAccessError('credentials-not-ready'); }
            this.#expectRecovery(epoch);
            this.#checkTargets();
            if (this.#targets.some((target) => !supported(target) ||
                (!target.credentials.passwordHash && !target.credentials.keyFileHash))) {
                throw new SessionAccessError('unsupported-recovery');
            }
            // Another prepare call may have completed during the await.
            if (!this.#references) this.#references = this.#targets.map((target) => ({
                ...target,
                sourcePassword: target.credentials.passwordHash, sourceKey: target.credentials.keyFileHash,
                password: detached(target.credentials.passwordHash), key: detached(target.credentials.keyFileHash)
            }));
        }
        this.#checkReferences();
        return Object.freeze(this.#references!.map((reference) => Object.freeze({
            id: reference.id, name: reference.file.name,
            requiresPassword: !!reference.password, requiresKeyFile: !!reference.key
        })));
    }

    async verifyVault(epoch: number, id: string, input: RecoveryInput): Promise<void> {
        this.#expectRecovery(epoch);
        this.#checkReferences();
        const reference = this.#references?.find((item) => item.id === id);
        if (!reference) throw new SessionAccessError('invalid-credentials');
        this.#approved.delete(id);
        const attempt = {};
        this.#attempts.set(id, attempt);
        if ((input.password !== undefined && typeof input.password !== 'string') ||
            (reference.password && input.password === undefined) ||
            (!reference.password && !!input.password) ||
            (!!reference.key !== (input.keyFile !== undefined)) ||
            (input.keyFile !== undefined && !(input.keyFile instanceof ArrayBuffer) && !(input.keyFile instanceof Uint8Array))) {
            throw new SessionAccessError('invalid-credentials');
        }
        // Empty input is null only for an absent password factor (the existing key-only fallback).
        const password = reference.password ? ProtectedValue.fromString(input.password!) : null;
        const key = input.keyFile?.slice();
        let candidate: Credentials | undefined;
        try {
            candidate = new Credentials(null);
            await candidate.ready;
            // Wait for both components even if one rejects, so no late hash escapes cleanup.
            const results = await Promise.allSettled([candidate.setPassword(password), candidate.setKeyFile(key)]);
            if (results.some((result) => result.status === 'rejected')) throw new SessionAccessError('invalid-credentials');
            this.#expectRecovery(epoch);
            this.#checkReferences();
            if (this.#attempts.get(id) !== attempt) throw new SessionAccessError('stale-session');
            const passwordMatches = sameFactor(reference.password, candidate.passwordHash);
            const keyMatches = sameFactor(reference.key, candidate.keyFileHash);
            if (!passwordMatches || !keyMatches) throw new SessionAccessError('invalid-credentials');
            this.#approved.add(id);
        } catch (error) {
            if (error instanceof SessionAccessError) throw error;
            throw new SessionAccessError('invalid-credentials');
        } finally {
            erase(password ?? undefined);
            erase(candidate?.passwordHash); erase(candidate?.keyFileHash);
            if (key) ByteUtils.zeroBuffer(key);
        }
    }

    /** Never trusts UI completion flags. A successful recovery invalidates every older callback. */
    resumeRecovery(epoch: number): void {
        this.#expectRecovery(epoch);
        this.#checkReferences();
        if (!this.#references?.length || this.#references.some((reference) => !this.#approved.has(reference.id))) {
            throw new SessionAccessError('incomplete-recovery');
        }
        ++this.#generation;
        this.#phase = 'open';
        this.#notifyInvalidation();
        this.#clearReferences();
        this.#targets = [];
    }

    /** Called after the parent has guarded and committed a true close. Does not close models itself. */
    completeClose(epoch: number): void {
        this.#expectEpoch(epoch);
        if (this.#phase !== 'securing' || this.#model.files.some((file) => file.active)) throw new SessionAccessError('invalid-state');
        ++this.#generation;
        this.#phase = 'closed';
        this.#notifyInvalidation();
        this.#clearReferences();
        this.#targets = [];
    }

    /** Allows normal unlock UI only from an empty, truly closed session. Never resumes retained vaults. */
    resetClosedSession(): void {
        if (this.#phase !== 'closed' || this.#model.files.some((file) => file.active)) throw new SessionAccessError('invalid-state');
        ++this.#generation;
        this.#phase = 'open';
        this.#notifyInvalidation();
        this.#invalid = false;
    }

    #activeRealFiles(): FileModel[] { return this.#model.files.filter((file) => file.active && !file.demo); }
    #expectEpoch(epoch: number): void {
        if (!this.isCurrent(epoch)) throw new SessionAccessError('stale-session');
    }
    #expectRecovery(epoch: number): void {
        this.#expectEpoch(epoch);
        if (this.#phase !== 'recovery-required') throw new SessionAccessError('invalid-state');
    }
    #checkTargets(): void {
        if (this.#invalid) throw new SessionAccessError('session-changed');
        const files = this.#activeRealFiles();
        if (files.length !== this.#targets.length || this.#targets.some((target) =>
            !files.includes(target.file) || target.file.id !== target.id || target.file.db !== target.db ||
            target.db.credentials !== target.credentials || credentialChangeVersion(target.credentials) !== target.version)) {
            this.#invalidate();
        }
    }
    #checkReferences(): void {
        this.#checkTargets();
        if (!this.#references) throw new SessionAccessError('incomplete-recovery');
        if (this.#references.some((reference) => !supported(reference) ||
            reference.credentials.passwordHash !== reference.sourcePassword || reference.credentials.keyFileHash !== reference.sourceKey ||
            !sameFactor(reference.password, reference.sourcePassword) || !sameFactor(reference.key, reference.sourceKey))) {
            this.#invalidate();
        }
    }
    #invalidate(): never {
        this.#invalid = true;
        ++this.#generation;
        this.#phase = 'recovery-required';
        this.#notifyInvalidation();
        this.#clearReferences();
        throw new SessionAccessError('session-changed');
    }
    #clearReferences(): void {
        for (const reference of this.#references ?? []) { erase(reference.password); erase(reference.key); }
        this.#references = undefined;
        this.#approved.clear();
        this.#attempts.clear();
    }
}

const sessions = new WeakMap<AppModel, SessionAccess>();
/** Default-open policy preserves Classic until a caller explicitly begins securing this model. */
export function getSessionAccess(model: AppModel): SessionAccess {
    let session = sessions.get(model);
    if (!session) { session = new SessionAccess(model); sessions.set(model, session); }
    return session;
}
