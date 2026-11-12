import { describe, test, expect, afterAll } from 'bun:test';
import {
    installMockedModule,
    restoreMockedModule,
    restoreAllMockedModules,
    listMockedModules,
} from './mock-isolation';

/**
 * Self-tests for the mock-isolation helper. We exercise it against
 * `kdbxweb` because that's the same module that triggered the
 * cross-file pollution in #31.
 *
 * Bun mock semantics that this file pins:
 *  - `mock.module(name, factory)` REPLACES existing exports of the
 *    named module with the factory's return value, but only for keys
 *    that already exist on the real module record. Adding a fresh
 *    `__sentinel` key has no effect — the new key is silently
 *    dropped. We therefore assert by mutating EXISTING keys
 *    (`ByteUtils` is the canonical example).
 *  - Once we have captured a snapshot of the real module, we can
 *    "unmock" by re-installing `mock.module` with a factory returning
 *    that snapshot. The next dynamic import sees the real exports
 *    again.
 *  - Snapshots persist across restore calls so the same name can be
 *    re-mocked and re-restored multiple times in the same run.
 *
 * This file MUST clean up after itself in `afterAll` so it does not
 * pollute other test files in the same Bun run (the very thing the
 * helper exists to prevent).
 */

afterAll(restoreAllMockedModules);

interface KdbxwebShape {
    ByteUtils: {
        bytesToHex?: unknown;
        bytesToBase64?: unknown;
        base64ToBytes?: unknown;
    };
    CryptoEngine: { sha256?: unknown };
}

describe('mock-isolation helper', () => {
    test('installMockedModule replaces existing exports of the named import', async () => {
        await installMockedModule('kdbxweb', () => ({
            CryptoEngine: { sha256: () => Promise.resolve(new ArrayBuffer(0)) },
            // Stub ByteUtils to expose ONLY bytesToHex; bytesToBase64
            // and base64ToBytes from the real module are dropped.
            ByteUtils: { bytesToHex: () => 'STUB-HEX' },
        }));
        const mocked = (await import('kdbxweb')) as unknown as KdbxwebShape;
        // The stub overrode the real ByteUtils — calling bytesToHex
        // returns the constant from the factory, not real hex.
        expect((mocked.ByteUtils.bytesToHex as () => string)()).toBe('STUB-HEX');
        // bytesToBase64 was not provided by the factory, so it is gone.
        expect(mocked.ByteUtils.bytesToBase64).toBeUndefined();
        // The helper tracked the snapshot.
        expect(listMockedModules()).toContain('kdbxweb');
    });

    test('restoreMockedModule re-exposes the real namespace', async () => {
        // Pre-condition: the previous test installed a mock and
        // captured a snapshot of the real module.
        expect(listMockedModules()).toContain('kdbxweb');

        await restoreMockedModule('kdbxweb');

        const real = (await import('kdbxweb')) as unknown as KdbxwebShape;
        // bytesToBase64 — which the previous test intentionally omitted
        // from its stub — is back and callable.
        expect(typeof real.ByteUtils.bytesToBase64).toBe('function');
        const out = (real.ByteUtils.bytesToBase64 as (b: ArrayBuffer) => string)(
            new Uint8Array([0xab, 0xcd]).buffer
        );
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(0);
        // bytesToHex now returns real hex, not the STUB-HEX constant.
        const hex = (real.ByteUtils.bytesToHex as (b: ArrayBuffer) => string)(
            new Uint8Array([0xab, 0xcd]).buffer
        );
        expect(hex).toBe('abcd');
    });

    test('restoreAllMockedModules restores all snapshots', async () => {
        // Re-mock with a fresh stub. The snapshot is still alive so
        // restoreAllMockedModules can put the real module back.
        await installMockedModule('kdbxweb', () => ({
            CryptoEngine: { sha256: () => Promise.resolve(new ArrayBuffer(0)) },
            ByteUtils: { bytesToHex: () => 'STILL-STUB' },
        }));
        const beforeRestore = (await import('kdbxweb')) as unknown as KdbxwebShape;
        expect((beforeRestore.ByteUtils.bytesToHex as () => string)()).toBe('STILL-STUB');

        await restoreAllMockedModules();

        const real = (await import('kdbxweb')) as unknown as KdbxwebShape;
        expect(typeof real.ByteUtils.bytesToBase64).toBe('function');
        const hex = (real.ByteUtils.bytesToHex as (b: ArrayBuffer) => string)(
            new Uint8Array([0xff]).buffer
        );
        expect(hex).toBe('ff');
    });
});
