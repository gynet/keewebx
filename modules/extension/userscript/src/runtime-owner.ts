const RUNTIME = Symbol.for('keewebx.connect.document-runtime.v1');

interface RuntimeOwner {
    document: object;
    duplicate(): void;
}

/** Reserve synchronously, before settings reads can interleave two installers. */
export function claimRuntime(scope: object, document: object): {
    onDuplicate(handler: () => void): void;
} | undefined {
    const current = (scope as Record<symbol, RuntimeOwner | undefined>)[RUNTIME];
    if (current?.document === document) {
        // This marker prevents duplicate work in the script's own world. It is
        // never consulted for website trust, port signatures or vault access.
        current.duplicate();
        return;
    }
    let handler = () => {};
    const owner: RuntimeOwner = { document, duplicate: () => handler() };
    Object.defineProperty(scope, RUNTIME, { value: owner, configurable: true });
    return { onDuplicate: next => { handler = next; } };
}
