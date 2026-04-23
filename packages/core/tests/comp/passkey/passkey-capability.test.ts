import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

/**
 * Tests for `comp/passkey/passkey-capability`.
 *
 * Covers:
 *   - The decision matrix (`decideFromPlatform`) for all OS buckets.
 *   - The UA string parser (`parseOsFromUaString`) covering macOS,
 *     Windows, Linux, iOS, Android, and unknown.
 *   - The browser detector (`detectBrowserFromUa`) covering Chrome,
 *     Firefox, Edge (precedence over Chrome), and Safari.
 *   - The E2E override short-circuit (`readOverride`).
 *   - The async top-level `probePasskeyCapability()` entry point with
 *     mocked `PublicKeyCredential.getClientCapabilities`, mocked
 *     `navigator.userAgentData`, and the override hook.
 *
 * We do NOT use the auto-mock `mock.module` facility here because the
 * module only touches global objects — stubbing `globalThis.navigator`
 * and `globalThis.PublicKeyCredential` is sufficient and a lot simpler
 * to reason about when inspecting failure modes.
 */

const { probePasskeyCapability, __testing__ } = await import(
    '../../../app/scripts/comp/passkey/passkey-capability'
);
const {
    OVERRIDE_GLOBAL,
    decideFromPlatform,
    parseOsFromUaString,
    detectBrowserFromUa,
    normalizeUaDataPlatform,
    isFileProtocolBlocked
} = __testing__;

// ---------------------------------------------------------------------
// Global stash — we mutate `PublicKeyCredential`, `navigator`, and
// `window` on the module scope for tests and must restore them after.
// ---------------------------------------------------------------------

interface Restorable {
    key: string;
    hadBefore: boolean;
    before: unknown;
}
const g = globalThis as unknown as Record<string, unknown>;
const stash: Restorable[] = [];

function setGlobal(key: string, value: unknown): void {
    stash.push({
        key,
        hadBefore: Object.prototype.hasOwnProperty.call(g, key),
        before: g[key]
    });
    g[key] = value;
}

function restoreGlobals(): void {
    while (stash.length) {
        const entry = stash.pop()!;
        if (entry.hadBefore) {
            g[entry.key] = entry.before;
        } else {
            delete g[entry.key];
        }
    }
}

beforeEach(() => {
    // Default: a minimal "window present, navigator present" shape.
    // Individual tests override specific fields.
    setGlobal('window', { });
    setGlobal('navigator', { userAgent: '' });
});

afterEach(() => {
    restoreGlobals();
});

// ---------------------------------------------------------------------
// parseOsFromUaString
// ---------------------------------------------------------------------

describe('parseOsFromUaString', () => {
    test('detects macOS with frozen 10_15_7 — version omitted', () => {
        const { os, osVersion } = parseOsFromUaString(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        );
        expect(os).toBe('macos');
        expect(osVersion).toBeUndefined();
    });

    test('detects macOS with real 14_6_1 (Safari)', () => {
        const { os, osVersion } = parseOsFromUaString(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15'
        );
        expect(os).toBe('macos');
        expect(osVersion).toBe('14.6.1');
    });

    test('detects Windows', () => {
        const { os } = parseOsFromUaString(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        );
        expect(os).toBe('windows');
    });

    test('detects Linux', () => {
        const { os } = parseOsFromUaString(
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
        );
        expect(os).toBe('linux');
    });

    test('detects iOS before macOS on iPad', () => {
        const { os, osVersion } = parseOsFromUaString(
            'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15'
        );
        expect(os).toBe('ios');
        expect(osVersion).toBe('17.5');
    });

    test('detects Android', () => {
        const { os, osVersion } = parseOsFromUaString(
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36'
        );
        expect(os).toBe('android');
        expect(osVersion).toBe('14.0');
    });

    test('returns unknown on empty UA', () => {
        const { os } = parseOsFromUaString('');
        expect(os).toBe('unknown');
    });
});

// ---------------------------------------------------------------------
// detectBrowserFromUa
// ---------------------------------------------------------------------

describe('detectBrowserFromUa', () => {
    test('Chrome without Edge token', () => {
        const b = detectBrowserFromUa(
            'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36'
        );
        expect(b.name).toBe('chrome');
        expect(b.major).toBe(146);
    });

    test('Edge checked before Chrome', () => {
        const b = detectBrowserFromUa(
            'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0.0.0 Edg/130.0.0.0'
        );
        expect(b.name).toBe('edge');
        expect(b.major).toBe(130);
    });

    test('Firefox', () => {
        const b = detectBrowserFromUa(
            'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'
        );
        expect(b.name).toBe('firefox');
        expect(b.major).toBe(128);
    });

    test('Safari (has Version/ token)', () => {
        const b = detectBrowserFromUa(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Version/17.6 Safari/605.1.15'
        );
        expect(b.name).toBe('safari');
        expect(b.major).toBe(17);
    });
});

// ---------------------------------------------------------------------
// normalizeUaDataPlatform
// ---------------------------------------------------------------------

describe('normalizeUaDataPlatform', () => {
    test('mac -> macos', () => {
        expect(normalizeUaDataPlatform('macOS')).toBe('macos');
    });
    test('Windows -> windows', () => {
        expect(normalizeUaDataPlatform('Windows')).toBe('windows');
    });
    test('undefined -> unknown', () => {
        expect(normalizeUaDataPlatform(undefined)).toBe('unknown');
    });
});

// ---------------------------------------------------------------------
// isFileProtocolBlocked
// ---------------------------------------------------------------------

describe('isFileProtocolBlocked', () => {
    test('file:// + chrome → blocked', () => {
        expect(isFileProtocolBlocked('file:', 'chrome')).toBe(true);
    });

    test('file:// + edge → blocked', () => {
        expect(isFileProtocolBlocked('file:', 'edge')).toBe(true);
    });

    test('file:// + safari → blocked', () => {
        expect(isFileProtocolBlocked('file:', 'safari')).toBe(true);
    });

    test('file:// + unknown browser → blocked', () => {
        expect(isFileProtocolBlocked('file:', 'unknown')).toBe(true);
    });

    test('file:// + firefox → NOT blocked', () => {
        expect(isFileProtocolBlocked('file:', 'firefox')).toBe(false);
    });

    test('https: + chrome → NOT blocked', () => {
        expect(isFileProtocolBlocked('https:', 'chrome')).toBe(false);
    });

    test('http: + chrome → NOT blocked', () => {
        expect(isFileProtocolBlocked('http:', 'chrome')).toBe(false);
    });

    test('undefined protocol → NOT blocked', () => {
        expect(isFileProtocolBlocked(undefined, 'chrome')).toBe(false);
    });
});

// ---------------------------------------------------------------------
// decideFromPlatform
// ---------------------------------------------------------------------

describe('decideFromPlatform', () => {
    test('macOS 14.x → unsupported with macOS-specific reason', () => {
        const cap = decideFromPlatform({
            os: 'macos',
            osVersion: '14.6.1',
            browser: 'chrome',
            browserMajor: 146
        });
        expect(cap.prf).toBe('unsupported');
        expect(cap.reason).toContain('14');
        expect(cap.reasonKey).toBe('openPasskeyDiagUnsupportedMacOS');
        expect(cap.recommendationKey).toBe('openPasskeyDiagUnsupportedMacOSRec');
    });

    test('macOS 15.1 → supported', () => {
        const cap = decideFromPlatform({
            os: 'macos',
            osVersion: '15.1.0',
            browser: 'chrome',
            browserMajor: 146
        });
        expect(cap.prf).toBe('supported');
    });

    test('macOS with missing version → unknown', () => {
        const cap = decideFromPlatform({ os: 'macos', browser: 'chrome' });
        expect(cap.prf).toBe('unknown');
    });

    test('Windows → supported (Windows Hello)', () => {
        const cap = decideFromPlatform({ os: 'windows', browser: 'edge' });
        expect(cap.prf).toBe('supported');
    });

    test('Linux → unknown with linux-specific reason', () => {
        const cap = decideFromPlatform({ os: 'linux', browser: 'firefox' });
        expect(cap.prf).toBe('unknown');
        expect(cap.reasonKey).toBe('openPasskeyDiagUnsupportedLinux');
    });

    test('iOS → unknown', () => {
        const cap = decideFromPlatform({ os: 'ios', browser: 'safari' });
        expect(cap.prf).toBe('unknown');
    });

    test('unknown OS → unknown', () => {
        const cap = decideFromPlatform({ os: 'unknown', browser: 'unknown' });
        expect(cap.prf).toBe('unknown');
    });
});

// ---------------------------------------------------------------------
// probePasskeyCapability (full integration via globals)
// ---------------------------------------------------------------------

describe('probePasskeyCapability', () => {
    test('getClientCapabilities reports extension:prf=true → supported', async () => {
        setGlobal('PublicKeyCredential', {
            getClientCapabilities: async () => ({ 'extension:prf': true })
        });
        setGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' });
        const cap = await probePasskeyCapability();
        expect(cap.prf).toBe('supported');
    });

    test('getClientCapabilities reports extension:prf=true BUT macOS 14 → unsupported (platform override)', async () => {
        setGlobal('PublicKeyCredential', {
            getClientCapabilities: async () => ({ 'extension:prf': true })
        });
        setGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146.0.7680.178',
            userAgentData: {
                platform: 'macOS',
                brands: [{ brand: 'Google Chrome', version: '146' }],
                getHighEntropyValues: async () => ({
                    platform: 'macOS',
                    platformVersion: '14.0.0'
                })
            }
        });
        const cap = await probePasskeyCapability();
        expect(cap.prf).toBe('unsupported');
        expect(cap.reason).toContain('macOS');
        expect(cap.reason).toContain('Sequoia');
        expect(cap.platform.os).toBe('macos');
        expect(cap.platform.osVersion).toBe('14.0.0');
    });

    test('getClientCapabilities reports extension:prf=false → unknown (hardware key might work)', async () => {
        setGlobal('PublicKeyCredential', {
            getClientCapabilities: async () => ({ 'extension:prf': false })
        });
        setGlobal('navigator', {
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0'
        });
        const cap = await probePasskeyCapability();
        expect(cap.prf).toBe('unknown');
        expect(cap.recommendation).toContain('YubiKey');
    });

    test('getClientCapabilities throws → falls back to UA path (macOS 14 → unsupported)', async () => {
        setGlobal('PublicKeyCredential', {
            getClientCapabilities: () => {
                throw new Error('not supported in this build');
            }
        });
        setGlobal('navigator', {
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 Version/17.6 Safari/605.1.15'
        });
        const cap = await probePasskeyCapability();
        expect(cap.prf).toBe('unsupported');
        expect(cap.reason).toContain('Sequoia');
        expect(cap.platform.os).toBe('macos');
    });

    test('no getClientCapabilities; UA says Chrome on Linux → unknown (linux-specific)', async () => {
        setGlobal('PublicKeyCredential', {});
        setGlobal('navigator', {
            userAgent:
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36'
        });
        const cap = await probePasskeyCapability();
        expect(cap.prf).toBe('unknown');
        expect(cap.platform.os).toBe('linux');
        expect(cap.reasonKey).toBe('openPasskeyDiagUnsupportedLinux');
    });

    test('userAgentData.getHighEntropyValues → macOS 15.1 supported', async () => {
        setGlobal('PublicKeyCredential', {}); // no getClientCapabilities
        setGlobal('navigator', {
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146.0.0.0',
            userAgentData: {
                platform: 'macOS',
                getHighEntropyValues: async () => ({
                    platform: 'macOS',
                    platformVersion: '15.1.0'
                })
            }
        });
        const cap = await probePasskeyCapability();
        expect(cap.prf).toBe('supported');
        expect(cap.platform.os).toBe('macos');
        expect(cap.platform.osVersion).toBe('15.1.0');
    });

    test('userAgentData.getHighEntropyValues → macOS 14.6 unsupported', async () => {
        setGlobal('PublicKeyCredential', {});
        setGlobal('navigator', {
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146.0.0.0',
            userAgentData: {
                platform: 'macOS',
                getHighEntropyValues: async () => ({
                    platform: 'macOS',
                    platformVersion: '14.6.1'
                })
            }
        });
        const cap = await probePasskeyCapability();
        expect(cap.prf).toBe('unsupported');
        expect(cap.reason).toContain('14');
        expect(cap.platform.osVersion).toBe('14.6.1');
    });

    test('PublicKeyCredential entirely missing → unsupported', async () => {
        // Leave PublicKeyCredential undefined. Module must handle this
        // via the `typeof PublicKeyCredential === 'undefined'` guard.
        setGlobal('navigator', { userAgent: 'Mozilla/5.0' });
        // Ensure it's not defined.
        if (Object.prototype.hasOwnProperty.call(g, 'PublicKeyCredential')) {
            setGlobal('PublicKeyCredential', undefined);
        }
        const cap = await probePasskeyCapability();
        expect(cap.prf).toBe('unsupported');
        expect(cap.reason).toContain('WebAuthn');
    });

    test('file:// + Chrome → unsupported with file-protocol reason', async () => {
        setGlobal('window', { location: { protocol: 'file:' } });
        setGlobal('PublicKeyCredential', {});
        setGlobal('navigator', {
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36'
        });
        const cap = await probePasskeyCapability();
        expect(cap.prf).toBe('unsupported');
        expect(cap.reasonKey).toBe('openPasskeyDiagFileProtocol');
        expect(cap.recommendationKey).toBe('openPasskeyDiagFileProtocolRec');
    });

    test('file:// + Firefox → falls through (not blocked)', async () => {
        setGlobal('window', { location: { protocol: 'file:' } });
        setGlobal('PublicKeyCredential', {});
        setGlobal('navigator', {
            userAgent:
                'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'
        });
        const cap = await probePasskeyCapability();
        // Firefox on file:// is allowed — should fall through to
        // normal platform detection (Linux → unknown).
        expect(cap.prf).not.toBe('unsupported');
        expect(cap.reasonKey).not.toBe('openPasskeyDiagFileProtocol');
    });

    test('window override short-circuits all detection', async () => {
        setGlobal('window', {
            [OVERRIDE_GLOBAL]: {
                prf: 'supported',
                reason: 'override',
                platform: { os: 'macos', browser: 'chrome', osVersion: '15.0.0' }
            }
        });
        // Even with a hostile PublicKeyCredential that would throw,
        // the override short-circuits the probe BEFORE it touches it.
        setGlobal('PublicKeyCredential', {
            getClientCapabilities: () => {
                throw new Error('should not be called');
            }
        });
        setGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1)'
        });
        const cap = await probePasskeyCapability();
        expect(cap.prf).toBe('supported');
        expect(cap.reason).toBe('override');
    });
});
