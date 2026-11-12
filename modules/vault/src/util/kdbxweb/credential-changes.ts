import { Credentials, type ProtectedValue } from 'kdbxweb';

type CredentialPart = 'password' | 'keyFile';
interface Change { promise: Promise<void>; }
interface Version {
    parts: Partial<Record<CredentialPart, Change>>;
    superseded: Promise<void>;
    invalidate: () => void;
}
const changes = new WeakMap<Credentials, Version>();

function version(credentials: Credentials): Version {
    let current = changes.get(credentials);
    if (!current) {
        let invalidate!: () => void;
        const superseded = new Promise<void>((resolve) => { invalidate = resolve; });
        current = { parts: {}, superseded, invalidate };
        changes.set(credentials, current);
    }
    return current;
}

function replace(credentials: Credentials, part: CredentialPart, change: Change): void {
    const previous = version(credentials);
    let invalidate!: () => void;
    const superseded = new Promise<void>((resolve) => { invalidate = resolve; });
    changes.set(credentials, { parts: { ...previous.parts, [part]: change }, superseded, invalidate });
    previous.invalidate();
}

export function credentialChangeVersion(credentials: Credentials): object {
    return version(credentials);
}

/** Hash privately; only the latest operation for this part may publish to live credentials. */
export function changeCredential(
    credentials: Credentials, part: CredentialPart, update: (staged: Credentials) => Promise<void>
): void {
    const change: Change = { promise: Promise.resolve() };
    replace(credentials, part, change);
    change.promise = Promise.resolve().then(async () => {
        const staged = new Credentials(null);
        await Promise.all([credentials.ready, staged.ready]);
        await update(staged);
        if (version(credentials).parts[part] === change) {
            if (part === 'password') credentials.passwordHash = staged.passwordHash;
            else credentials.keyFileHash = staged.keyFileHash;
        }
    });
    // The latest failure remains observable by export/save until retried or reset.
    void change.promise.catch(() => {});
}

/** Reset/removal publishes synchronously and invalidates all older writers for this part. */
export function resetCredentialHash(credentials: Credentials, part: CredentialPart, hash?: ProtectedValue): void {
    const change: Change = { promise: Promise.resolve() };
    replace(credentials, part, change);
    const publish = () => {
        if (version(credentials).parts[part] !== change) return;
        if (part === 'password') credentials.passwordHash = hash;
        else credentials.keyFileHash = hash;
    };
    publish();
    // Construction itself may still be hashing; its result must not undo a reset.
    change.promise = credentials.ready.then(publish);
    void change.promise.catch(() => {});
}

export async function waitForCredentialChanges(credentials: Credentials): Promise<void> {
    for (;;) {
        const current = version(credentials);
        try {
            await Promise.race([
                Promise.all([credentials.ready, current.parts.password?.promise, current.parts.keyFile?.promise]),
                current.superseded
            ]);
        } catch (error) {
            if (current === version(credentials)) throw error;
        }
        if (current === version(credentials)) return;
    }
}

/** Recheck after the await before starting a serializer on the same credential generation. */
export async function withCredentialChanges<T>(credentials: Credentials, action: () => T | Promise<T>): Promise<T> {
    for (;;) {
        const current = version(credentials);
        await waitForCredentialChanges(credentials);
        if (current === version(credentials)) return action();
    }
}
