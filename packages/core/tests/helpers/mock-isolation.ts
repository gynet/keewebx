/**
 * Bun `mock.module` cross-file isolation helper.
 *
 * Why this exists
 * ---------------
 * Bun's `mock.module(name, factory)` installs a process-wide override
 * that persists for the lifetime of the test runner. There is currently
 * NO public API to "unmock" — neither `mock.restore()` nor
 * `mock.clearAllMocks()` undo a `mock.module` call (verified on Bun
 * 1.3.11; both functions only operate on jest-style spies).
 *
 * The practical consequence: if file A installs a partial mock of a
 * shared module like `kdbxweb`, every subsequent test file that
 * imports `kdbxweb` (directly or transitively) sees the partial mock,
 * NOT the real module. SDET R4 hit this when
 * `tests/storage/storage-webdav.test.ts` mocked `kdbxweb` with stub
 * `CryptoEngine` / `ByteUtils` and broke `tests/comp/extension/
 * protocol-impl.test.ts`, which depends on real `bytesToBase64` /
 * `base64ToBytes`.
 *
 * The workaround
 * --------------
 * We cannot delete a mock, but we CAN re-install one with a NEW
 * factory whose return value is a snapshot of the REAL module taken
 * BEFORE any mock was installed. Re-installing the snapshot makes
 * subsequent imports return the real implementation, which is
 * functionally equivalent to "unmocking" for any consumer that reads
 * exports.
 *
 * IMPORTANT subtlety
 * ------------------
 * Bun mutates the underlying module record when `mock.module` is
 * called. So `import * as real from 'name'` taken BEFORE the mock
 * still ends up pointing at the mock's exports later. The fix is to
 * take a SHALLOW COPY (`{ ...realModule }`) at capture time — that
 * fresh object is decoupled from Bun's internal record and survives
 * subsequent re-mocks intact.
 *
 * Workflow
 * --------
 *  1. Test file calls `installMockedModule(name, factory)` instead of
 *     `mock.module(name, factory)`. This snapshots the real module
 *     first, then installs the mock.
 *  2. Test file registers `afterAll(restoreAllMockedModules)`. On
 *     teardown the helper re-installs each mocked name with its
 *     captured snapshot, restoring real exports for the next file.
 *
 * The snapshot map is process-global (module-level) so cross-file
 * ordering does not matter: any test file importing this helper
 * participates in the same restore registry.
 */

import { mock } from 'bun:test';

const realSnapshots = new Map<string, Record<string, unknown>>();

/**
 * Capture a shallow snapshot of a module's namespace BEFORE any mock
 * is installed. Idempotent: subsequent calls for the same name are a
 * no-op so the first (real) snapshot is preserved across re-mocks.
 *
 * Returns the snapshot in case the caller wants to inspect it.
 */
async function captureRealSnapshot(name: string): Promise<Record<string, unknown>> {
    const existing = realSnapshots.get(name);
    if (existing) {
        return existing;
    }
    const real = (await import(name)) as Record<string, unknown>;
    // Shallow copy: detaches the namespace object from Bun's internal
    // module record so future `mock.module` calls cannot mutate it.
    // Each entry that is itself an object (e.g. CryptoEngine) is left
    // by reference; that's fine because consumers do not mutate them.
    const snapshot: Record<string, unknown> = { ...real };
    realSnapshots.set(name, snapshot);
    return snapshot;
}

/**
 * Install a `mock.module` and remember the real namespace so it can
 * be restored later via `restoreAllMockedModules`. Drop-in replacement
 * for `mock.module(name, factory)` for any test that wants its mocks
 * cleaned up between files.
 */
export async function installMockedModule(
    name: string,
    factory: () => unknown
): Promise<void> {
    // Capture the real exports BEFORE we mock, otherwise the snapshot
    // will see the mock and we'll have nothing to restore.
    await captureRealSnapshot(name);
    mock.module(name, factory);
}

/**
 * Restore a single mocked module by re-installing it with a factory
 * that returns the captured real-module snapshot. Throws if no
 * snapshot was registered (i.e. the caller used `mock.module`
 * directly instead of `installMockedModule`).
 */
export async function restoreMockedModule(name: string): Promise<void> {
    const snapshot = realSnapshots.get(name);
    if (!snapshot) {
        // The caller may have used the raw `mock.module` API. Try a
        // best-effort dynamic import — this only works if no other
        // file has mocked the module yet, but at least it's a defined
        // failure mode.
        const real = (await import(name)) as Record<string, unknown>;
        const fallback = { ...real };
        mock.module(name, () => fallback);
        return;
    }
    mock.module(name, () => snapshot);
}

/**
 * Restore every module name registered via `installMockedModule`.
 * Intended for use in `afterAll`:
 *
 * ```ts
 * import { afterAll } from 'bun:test';
 * import { restoreAllMockedModules } from '../helpers/mock-isolation';
 *
 * afterAll(restoreAllMockedModules);
 * ```
 *
 * Errors during restoration are collected and re-thrown as a single
 * AggregateError so a missing real module doesn't silently leave
 * other restorations undone.
 *
 * Note: this restores the real exports but does NOT clear the
 * registry. The snapshots stay alive for the rest of the test run so
 * that any later file which re-installs a mock for the same name can
 * still be cleaned up via the same machinery.
 */
export async function restoreAllMockedModules(): Promise<void> {
    const errors: unknown[] = [];
    const names = Array.from(realSnapshots.keys());
    for (const name of names) {
        try {
            await restoreMockedModule(name);
        } catch (e) {
            errors.push(e);
        }
    }
    if (errors.length > 0) {
        throw new AggregateError(
            errors,
            `Failed to restore ${errors.length} mocked module(s): ` +
                names.join(', ')
        );
    }
}

/**
 * Returns the current set of registered mock names. Exposed for test
 * introspection — production code should not depend on this.
 */
export function listMockedModules(): readonly string[] {
    return Array.from(realSnapshots.keys());
}
