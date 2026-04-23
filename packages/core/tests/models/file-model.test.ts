import { describe, test, expect, afterAll, mock } from 'bun:test';
import {
    installMockedModule,
    restoreAllMockedModules
} from '../helpers/mock-isolation';

// ---------------------------------------------------------------------
// Browser-global shims: `installMockedModule` below *imports the real
// module first* before overriding it, so transitive imports like
// `models/group-model -> util/features` run at snapshot time and
// explode on missing `window` / `navigator`. These shims mirror the
// pattern already used by `tests/comp/settings/settings-manager.test
// .ts`. The file-model.ts code path we actually exercise does NOT read
// any of these values — the shims only exist to let dependency
// modules evaluate without crashing during import.
// ---------------------------------------------------------------------
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
        parent: {},
        top: {},
        opener: null,
        location: { href: 'http://localhost:8085', origin: 'http://localhost:8085' }
    };
}
if (typeof (globalThis as { screen?: unknown }).screen === 'undefined') {
    (globalThis as unknown as { screen: Record<string, unknown> }).screen = {
        width: 1920
    };
}
if (typeof (globalThis as { location?: unknown }).location === 'undefined') {
    (globalThis as unknown as { location: Record<string, unknown> }).location = {
        href: 'http://localhost:8085/',
        origin: 'http://localhost:8085'
    };
}
try {
    const nav = (globalThis as unknown as { navigator: Record<string, unknown> })
        .navigator;
    if (nav && typeof nav === 'object') {
        if (!('languages' in nav) || !nav.languages) {
            Object.defineProperty(nav, 'languages', {
                value: ['en-US'],
                configurable: true,
                writable: true
            });
        }
        if (!('language' in nav) || !nav.language) {
            Object.defineProperty(nav, 'language', {
                value: 'en-US',
                configurable: true,
                writable: true
            });
        }
        if (!('userAgent' in nav) || !nav.userAgent) {
            Object.defineProperty(nav, 'userAgent', {
                value: 'bun-test',
                configurable: true,
                writable: true
            });
        }
    }
} catch {
    /* best-effort; only matters if a transitive import actually reads the value */
}

/**
 * Regression guard for the "chalResp dropped in FileModel.open" bug.
 *
 * Before Passkey Quick Unlock (#9) groundwork, FileModel.open constructed
 *   new kdbxweb.Credentials(password, keyFileData)
 * and silently dropped any challenge-response function stored on
 * `this.chalResp`. The result: `params.chalResp` flowed from
 * `app-model.ts:openFileWithData` into `FileModel` and then went
 * nowhere — dead code from the day YubiKey was stripped.
 *
 * This test mocks `kdbxweb.Credentials` to spy on construction arguments
 * and verifies that `FileModel.open` now forwards a callable
 * `this.chalResp` as the 3rd constructor argument (the
 * `KdbxChallengeResponseFn` slot that the real kdbxweb uses to inject
 * HMAC-SHA1 hardware responses into the credential hash pipeline).
 *
 * FileModel's import tree is the whole app (GroupModel → IconUrlFormat
 * → jQuery, AppSettingsModel → SettingsStore → localStorage, etc.), so
 * we stub every transitive import to a no-op placeholder. The only
 * piece actually exercised is the fix in `open()`.
 */

// ---------------------------------------------------------------------
// Webpack-alias stubs the test runner cannot resolve on its own. These
// cannot be snapshotted by `installMockedModule` (no real module behind
// them) but that's harmless — nothing else in the core test suite
// imports `demo.kdbx` or `hbs` from raw specifier outside file-model.
// ---------------------------------------------------------------------
mock.module('demo.kdbx', () => ({ default: new ArrayBuffer(0) }));
mock.module('hbs', () => ({
    default: { escapeExpression: (s: string) => s, registerHelper: () => {} }
}));

// ---------------------------------------------------------------------
// Restore cross-file isolation on teardown: `kdbxweb` is a SHARED
// module used by many other test files (protocol-impl, storage-webdav,
// crud regression guards). Leaking our stub into those processes
// guarantees cascade failures. `installMockedModule` snapshots the real
// module BEFORE we install the spy and `restoreAllMockedModules`
// re-installs the snapshot in afterAll.
// ---------------------------------------------------------------------
afterAll(restoreAllMockedModules);

/**
 * `installMockedModule` snapshots the real module BEFORE mocking so
 * teardown can restore it. But some modules in FileModel's import tree
 * fail to evaluate in the Bun test context (they rely on `require()` of
 * webpack template aliases that have no Node module behind them). For
 * those, we fall back to plain `mock.module` and silently absorb the
 * snapshot failure — the module was unreachable in tests anyway, so
 * leakage across files is fine.
 */
async function safeInstallMockedModule(
    name: string,
    factory: () => unknown
): Promise<void> {
    try {
        await installMockedModule(name, factory);
    } catch {
        mock.module(name, factory);
    }
}

// ---------------------------------------------------------------------
// FileModel's transitive imports — we only need their identifiers to
// exist; none of their logic runs along the `open()` path we're testing
// because `Kdbx.load` and `readModel()` are stubbed below.
//
// Install the stubs for the TRANSITIVE imports before the direct
// FileModel ones. entry-model and group-model both `import` from
// `comp/format/kdbx-to-html` (tsconfig path alias). If the kdbx-to-html
// stub isn't in place when installMockedModule snapshots
// models/group-model, Bun will try to load the real kdbx-to-html and
// fail on a missing `templates/export/db.hbs` webpack alias.
// ---------------------------------------------------------------------
const kdbxToHtmlStub = () => ({
    KdbxToHtml: { entryToHtml: () => '', fileToHtml: () => '' }
});
mock.module('comp/format/kdbx-to-html', kdbxToHtmlStub);
mock.module('../../app/scripts/comp/format/kdbx-to-html', kdbxToHtmlStub);

await safeInstallMockedModule('../../app/scripts/framework/model', () => {
    const modelDefaults = new Map<Function, Record<string, unknown>>();
    class Model {
        constructor(data?: Record<string, unknown>) {
            const defaults = modelDefaults.get(new.target);
            if (defaults) Object.assign(this, defaults);
            if (data) Object.assign(this, data);
        }
        set(props: Record<string, unknown>): void {
            Object.assign(this, props);
        }
        on(): void {}
        once(): void {}
        off(): void {}
        emit(): void {}
        static defineModelProperties(props: Record<string, unknown>): void {
            modelDefaults.set(this, { ...props });
        }
    }
    return { Model };
});

await safeInstallMockedModule('../../app/scripts/framework/events', () => ({
    Events: { emit: () => {}, on: () => {}, off: () => {} }
}));

await safeInstallMockedModule('../../app/scripts/collections/group-collection', () => {
    class GroupCollection extends Array {}
    return { GroupCollection };
});

// Handlebars template aliases used by `kdbx-to-html` via `require()`.
// mock.module on the tsconfig-alias above catches most callers but
// `require()` bypasses the ESM path — stub the webpack template
// specifiers directly as a belt-and-suspenders.
mock.module('templates/export/db.hbs', () => ({ default: () => '' }));
mock.module('templates/export/entry.hbs', () => ({ default: () => '' }));

await safeInstallMockedModule('../../app/scripts/models/group-model', () => {
    class GroupModel {
        static fromGroup(): GroupModel {
            return new GroupModel();
        }
        setGroup(): void {}
    }
    return { GroupModel };
});

await safeInstallMockedModule('../../app/scripts/models/app-settings-model', () => ({
    AppSettingsModel: {}
}));

await safeInstallMockedModule('../../app/scripts/models/entry-model', () => {
    class EntryModel {}
    return { EntryModel };
});

await safeInstallMockedModule('../../app/scripts/util/formatting/icon-url-format', () => ({
    IconUrlFormat: { toDataUrl: () => '' }
}));

await safeInstallMockedModule('../../app/scripts/util/logger', () => {
    class Logger {
        constructor(_name?: string) {}
        info(): void {}
        error(): void {}
        debug(): void {}
        ts(t?: number): number | string {
            return t ? `${Date.now() - t}ms` : Date.now();
        }
    }
    return { Logger };
});

await safeInstallMockedModule('../../app/scripts/util/locale', () => ({ Locale: {} }));

await safeInstallMockedModule('../../app/scripts/util/formatting/string-format', () => ({
    StringFormat: { capFirst: (s: string) => s }
}));

// ---------------------------------------------------------------------
// kdbxweb spy: record the 3rd constructor arg to Credentials and
// short-circuit Kdbx.load so readModel() never actually runs.
// ---------------------------------------------------------------------
type CapturedCredential = {
    password: unknown;
    keyFile: unknown;
    challengeResponse: unknown;
};

const capturedCredentials: CapturedCredential[] = [];

await safeInstallMockedModule('kdbxweb', () => {
    class ProtectedValue {
        byteLength = 0;
        textLength = 0;
        static fromString(_s: string): ProtectedValue {
            return new ProtectedValue();
        }
    }
    class Credentials {
        constructor(password: unknown, keyFile?: unknown, challengeResponse?: unknown) {
            capturedCredentials.push({ password, keyFile, challengeResponse });
        }
    }
    // A stub Kdbx "db" shaped just enough for FileModel.readModel's
    // `this.db.*` access patterns to traverse without crashing.
    const stubDb = {
        header: {
            versionMajor: 4,
            kdfParameters: null,
            keyEncryptionRounds: 0
        },
        meta: {
            defaultUser: '',
            recycleBinEnabled: false,
            historyMaxItems: 10,
            historyMaxSize: 1024,
            keyChangeForce: -1,
            keyChanged: new Date()
        },
        groups: [],
        credentials: {
            passwordHash: undefined,
            keyFileHash: undefined
        },
        getDefaultGroup(): { uuid: { toString(): string } } {
            return { uuid: { toString: () => 'root' } };
        }
    };
    const Kdbx = {
        load: (_data: unknown, _credentials: unknown) => Promise.resolve(stubDb)
    };
    return {
        ProtectedValue,
        Credentials,
        Kdbx,
        Consts: {
            ErrorCodes: { InvalidKey: 'InvalidKey' },
            KdfId: {
                Aes: 'aes',
                Argon2d: 'argon2d',
                Argon2id: 'argon2id'
            }
        },
        ByteUtils: {
            zeroBuffer: (_b: unknown) => {},
            bytesToBase64: (_b: unknown) => '',
            bytesToHex: (_b: unknown) => '',
            base64ToBytes: (_s: string) => new Uint8Array(0),
            stringToBytes: (_s: string) => new Uint8Array(0)
        }
    };
});

// ---------------------------------------------------------------------
// Import FileModel AFTER all mocks are installed.
// ---------------------------------------------------------------------
const { FileModel } = (await import('../../app/scripts/models/file-model')) as {
    FileModel: new (data?: Record<string, unknown>) => {
        chalResp: unknown;
        entryMap: Record<string, unknown>;
        groupMap: Record<string, unknown>;
        buildObjectMap(): void;
        resolveFieldReferences(): void;
        open(
            password: unknown,
            fileData: ArrayBuffer,
            keyFileData: ArrayBuffer | null,
            callback: (err?: unknown) => void
        ): void;
    };
};

describe('FileModel.open — chalResp forwarding (#9 groundwork)', () => {
    test('forwards a challenge-response function to kdbxweb.Credentials', async () => {
        capturedCredentials.length = 0;

        let chalRespCalls = 0;
        const mockChalResp = async (
            _challenge: ArrayBuffer
        ): Promise<Uint8Array> => {
            chalRespCalls++;
            // Return a deterministic 20-byte HMAC-SHA1-shaped response so
            // any downstream hashing that inspects length behaves sanely.
            return new Uint8Array(20).fill(42);
        };

        const file = new FileModel({ id: 'test', name: 'test' });
        file.chalResp = mockChalResp as unknown;
        // Avoid running the stub readModel's downstream GroupCollection
        // push path — FileModel.open calls readModel() inside its .then
        // chain and we only care about what the Credentials constructor
        // received. Monkey-patch the methods readModel touches so it
        // returns cleanly without exercising real GroupModel logic.
        file.entryMap = {};
        file.groupMap = {};
        file.buildObjectMap = () => {};
        file.resolveFieldReferences = () => {};

        await new Promise<void>((resolve, reject) => {
            file.open(null, new ArrayBuffer(0), null, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        expect(capturedCredentials.length).toBeGreaterThanOrEqual(1);
        const first = capturedCredentials[0];
        expect(typeof first.challengeResponse).toBe('function');
        // The forwarded function must be the *same* reference that was
        // installed on the FileModel — not a wrapper, not null.
        expect(first.challengeResponse).toBe(mockChalResp);

        // Unused here (readModel short-circuit), but documented for the
        // #9 follow-up: once FileModel actually invokes kdbxweb hash
        // paths under test, this counter should be > 0.
        expect(chalRespCalls).toBe(0);
    });

    test('omits challengeResponse when chalResp is null', async () => {
        capturedCredentials.length = 0;

        const file = new FileModel({ id: 'test', name: 'test' });
        file.chalResp = null;
        file.entryMap = {};
        file.groupMap = {};
        file.buildObjectMap = () => {};
        file.resolveFieldReferences = () => {};

        await new Promise<void>((resolve, reject) => {
            file.open(null, new ArrayBuffer(0), null, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        expect(capturedCredentials.length).toBeGreaterThanOrEqual(1);
        expect(capturedCredentials[0].challengeResponse).toBeUndefined();
    });

    test('ignores legacy descriptor-shaped chalResp (Record<string, unknown>)', async () => {
        capturedCredentials.length = 0;

        const file = new FileModel({ id: 'test', name: 'test' });
        // Legacy YubiKey descriptor metadata that used to be written
        // here. The fix guards against passing this to kdbxweb, which
        // would type-error (KdbxChallengeResponseFn is a function).
        file.chalResp = { vid: 0x1050, pid: 0x0407, serial: 12345, slot: 2 };
        file.entryMap = {};
        file.groupMap = {};
        file.buildObjectMap = () => {};
        file.resolveFieldReferences = () => {};

        await new Promise<void>((resolve, reject) => {
            file.open(null, new ArrayBuffer(0), null, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        expect(capturedCredentials.length).toBeGreaterThanOrEqual(1);
        expect(capturedCredentials[0].challengeResponse).toBeUndefined();
    });
});
