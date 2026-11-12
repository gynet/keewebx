/**
 * Preemptive WebAuthn PRF capability probe (#9 follow-up).
 *
 * `passkey-prf.isPasskeyPrfSupported()` is a synchronous, best-effort
 * sanity check ("does `PublicKeyCredential` even exist in this tab")
 * that the open view consults at construction time to decide whether
 * to show the "Remember with passkey" checkbox at all.
 *
 * That check is necessary but not sufficient. A user on macOS 14
 * Sonoma + Chrome 146 can pass the basic probe (WebAuthn is present,
 * `crypto.subtle` is present) and walk all the way through Touch ID
 * registration, only to hit `PasskeyPrfNotSupportedError` at the end
 * because Apple's iCloud Keychain / platform authenticator on macOS
 * < 15 does not implement the WebAuthn PRF extension. Apple added PRF
 * support in macOS 15 Sequoia (released 2024-09-16).
 *
 * This module does the DEEP probe up-front, so the UI can:
 *
 *   - Hide the checkbox entirely on known-unsupported environments
 *     (macOS < 15, Linux with no hardware key plugged in, etc.)
 *   - Surface an actionable diagnostic line with OS-specific guidance
 *     (_"Upgrade to macOS 15 Sequoia, or use a YubiKey 5.2.3+"_)
 *   - Still show the checkbox on "unknown" environments so a user with
 *     a hardware key can at least try
 *
 * The probe NEVER throws — all exceptions are caught and downgraded to
 * `prf: 'unknown'`. That is load-bearing: the passkey flow is a quality-
 * of-life feature, not a hard dependency for opening a database, so a
 * browser quirk during detection must not break the open view.
 *
 * Detection strategy (in priority order):
 *
 *   A. `PublicKeyCredential.getClientCapabilities()` — Chrome 133+,
 *      Safari 18+. When present, this is the authoritative answer for
 *      "does the client support the PRF extension". A `false` value
 *      for the `extension:prf` key is conclusive; `true` is conclusive
 *      too. Key missing → fall through to step B.
 *
 *   B. `navigator.userAgentData.getHighEntropyValues(['platformVersion'])`
 *      — Chromium-only, async. For macOS Chromium 93+ this returns the
 *      real Darwin-major-based version string (e.g. "14.0.0", "15.1.0").
 *      The UA string itself is frozen at "10_15_7" on macOS for privacy,
 *      which is why we prefer `getHighEntropyValues` over UA parsing.
 *
 *   C. UA string parsing fallback — used when neither of the above
 *      works (Firefox, Safari, non-Chromium). Because of the frozen
 *      macOS version string the outcome for macOS via UA alone is
 *      usually `unknown`, not `unsupported`.
 *
 * Decision matrix after OS/version is known:
 *
 *   - macOS < 15                         → unsupported (Sonoma or older)
 *   - macOS >= 15                        → supported
 *   - Windows 10/11 (any modern browser) → supported (Windows Hello PRF)
 *   - Linux                              → unknown (hardware-key only)
 *   - iOS/Android                        → unknown (platform-dependent)
 *   - Cannot determine OS                → unknown
 *
 * E2E override hook:
 *
 *   Because the Playwright virtual-authenticator spec installs a
 *   `hasPrf: true` CDP authenticator but does not lie about the OS
 *   version (so on a macOS 14 Sonoma CI runner the probe would
 *   otherwise report `unsupported` and hide the checkbox), the probe
 *   honors a `window.__keewebx_passkey_capability_override` global.
 *   When set, its value is returned verbatim and all other detection
 *   is skipped. The E2E spec sets this to `{ prf: 'supported', ... }`
 *   before calling `page.reload()` to ensure the enable checkbox is
 *   visible regardless of host OS.
 */

/** Tri-state PRF support outcome. */
export type PasskeyPrfSupport = 'supported' | 'unsupported' | 'unknown';

/** OS identifier. `unknown` means the probe could not determine it. */
export type PasskeyOs =
    | 'macos'
    | 'windows'
    | 'linux'
    | 'ios'
    | 'android'
    | 'unknown';

/** Browser identifier. `unknown` means the probe could not determine it. */
export type PasskeyBrowser =
    | 'chrome'
    | 'firefox'
    | 'safari'
    | 'edge'
    | 'unknown';

/** Platform facts the probe extracted from the user agent. */
export interface PasskeyPlatform {
    os: PasskeyOs;
    /** Dotted OS version e.g. `'14.0.0'` or `'15.1'`. Omitted if unknown. */
    osVersion?: string;
    browser: PasskeyBrowser;
    browserMajor?: number;
}

/**
 * Full probe result. `reasonKey` / `recommendationKey` are locale-key
 * names the view layer can look up in `util/locale`; the raw `reason`
 * / `recommendation` strings are an English fallback for logging.
 */
export interface PasskeyCapability {
    prf: PasskeyPrfSupport;
    /** English fallback reason (always set). */
    reason: string;
    /** Locale-key name for the reason (optional). */
    reasonKey?: string;
    /** English fallback recommendation (optional). */
    recommendation?: string;
    /** Locale-key name for the recommendation (optional). */
    recommendationKey?: string;
    platform: PasskeyPlatform;
}

/** Name of the window-scoped override hook used by E2E tests. */
const OVERRIDE_GLOBAL = '__keewebx_passkey_capability_override';

/** First macOS release that exposes PRF through iCloud Keychain. */
const MACOS_PRF_MIN_MAJOR = 15;

/**
 * Deep probe of the current environment's WebAuthn PRF support.
 *
 * Tolerant: never throws. On any internal failure returns a
 * `prf: 'unknown'` result with a friendly generic reason.
 */
export async function probePasskeyCapability(): Promise<PasskeyCapability> {
    // ------------------------------------------------------------------
    // E2E override short-circuit. Must run before any browser calls so
    // a Playwright spec can pin the result deterministically regardless
    // of the host OS / authenticator combo.
    // ------------------------------------------------------------------
    const override = readOverride();
    if (override) {
        return override;
    }

    // ------------------------------------------------------------------
    // Chrome blocks WebAuthn on file:// origins (SecurityError).
    // Firefox allows it. Hide the passkey checkbox on file:// for
    // browsers that will reject the call.
    // ------------------------------------------------------------------
    if (typeof window !== 'undefined' && window.location?.protocol === 'file:') {
        const platform = await detectPlatform();
        if (isFileProtocolBlocked('file:', platform.browser)) {
            return {
                prf: 'unsupported',
                reason: 'Passkey quick unlock is not available on file:// in this browser.',
                reasonKey: 'openPasskeyDiagFileProtocol',
                recommendation: 'Use http://localhost or https:// for passkey support, or use your master password.',
                recommendationKey: 'openPasskeyDiagFileProtocolRec',
                platform
            };
        }
    }

    // ------------------------------------------------------------------
    // No WebAuthn at all → unsupported, unambiguous.
    // ------------------------------------------------------------------
    if (
        typeof window === 'undefined' ||
        typeof navigator === 'undefined' ||
        typeof PublicKeyCredential === 'undefined'
    ) {
        return {
            prf: 'unsupported',
            reason: 'WebAuthn is not available in this browser.',
            platform: { os: 'unknown', browser: 'unknown' }
        };
    }

    // Detect platform early so we can decorate the capability result
    // even when getClientCapabilities gives an authoritative answer.
    const platform = await detectPlatform();

    // ------------------------------------------------------------------
    // Step A — PublicKeyCredential.getClientCapabilities() (Chrome 133+,
    // Safari 18+). Authoritative when the key is present.
    // ------------------------------------------------------------------
    const clientCaps = await tryGetClientCapabilities();
    if (clientCaps && Object.prototype.hasOwnProperty.call(clientCaps, 'extension:prf')) {
        const prfFlag = clientCaps['extension:prf'];
        if (prfFlag === false) {
            // Browser reports no PRF support for its built-in
            // authenticator, but a FIDO2 hardware key (YubiKey 5.2.3+)
            // may still support PRF via CTAP2 hmac-secret. Return
            // 'unknown' instead of 'unsupported' so the checkbox stays
            // enabled and users with hardware keys can still try.
            return {
                prf: 'unknown',
                reason: 'This browser does not support the WebAuthn PRF extension with its built-in authenticator.',
                recommendation: 'Plug in a YubiKey 5.2.3+ or equivalent FIDO2 key and try again. Alternatively, use Chrome or Safari with iCloud Keychain.',
                platform
            };
        }
        // prfFlag === true means the BROWSER supports PRF, but that is
        // necessary-not-sufficient: our flow uses authenticatorAttachment
        // 'platform', so the platform authenticator must also support it.
        // Chrome on macOS 14 Sonoma reports extension:prf true (it works
        // with YubiKey) but iCloud Keychain on Sonoma does not expose PRF.
        // Cross-check against platform version before trusting the flag.
        if (prfFlag === true) {
            if (platform.os === 'macos') {
                const major = parseMajor(platform.osVersion);
                if (major !== undefined && major < MACOS_PRF_MIN_MAJOR) {
                    return decorateUnsupported(platform, /* fromClientCaps */ false);
                }
            }
            return {
                prf: 'supported',
                reason: 'Browser reports WebAuthn PRF extension support.',
                platform
            };
        }
    }

    // ------------------------------------------------------------------
    // Step B/C — fall back to platform-version-based decision matrix.
    // ------------------------------------------------------------------
    return decideFromPlatform(platform);
}

// ---------------------------------------------------------------------
// E2E override hook
// ---------------------------------------------------------------------

function readOverride(): PasskeyCapability | null {
    try {
        if (typeof window === 'undefined') return null;
        const w = window as unknown as Record<string, unknown>;
        const raw = w[OVERRIDE_GLOBAL];
        if (!raw || typeof raw !== 'object') return null;
        const obj = raw as Partial<PasskeyCapability>;
        if (obj.prf !== 'supported' && obj.prf !== 'unsupported' && obj.prf !== 'unknown') {
            return null;
        }
        return {
            prf: obj.prf,
            reason: obj.reason ?? 'Capability override set by test harness.',
            reasonKey: obj.reasonKey,
            recommendation: obj.recommendation,
            recommendationKey: obj.recommendationKey,
            platform: obj.platform ?? { os: 'unknown', browser: 'unknown' }
        };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------
// Step A helper — PublicKeyCredential.getClientCapabilities
// ---------------------------------------------------------------------

interface ClientCapabilitiesMap {
    [key: string]: boolean | undefined;
}

async function tryGetClientCapabilities(): Promise<ClientCapabilitiesMap | null> {
    try {
        const pkc = PublicKeyCredential as unknown as {
            getClientCapabilities?: () => Promise<ClientCapabilitiesMap>;
        };
        if (typeof pkc.getClientCapabilities !== 'function') {
            return null;
        }
        const result = await pkc.getClientCapabilities();
        if (!result || typeof result !== 'object') return null;
        return result;
    } catch {
        // Some browsers throw on unsupported methods — treat as "no data".
        return null;
    }
}

// ---------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------

interface UserAgentDataLike {
    platform?: string;
    brands?: { brand: string; version: string }[];
    getHighEntropyValues?: (hints: string[]) => Promise<{
        platform?: string;
        platformVersion?: string;
        uaFullVersion?: string;
    }>;
}

async function detectPlatform(): Promise<PasskeyPlatform> {
    try {
        const nav = navigator as unknown as {
            userAgent?: string;
            userAgentData?: UserAgentDataLike;
        };
        const uaData = nav.userAgentData;

        // Prefer userAgentData (Chromium) when available.
        if (uaData && typeof uaData.getHighEntropyValues === 'function') {
            try {
                const high = await uaData.getHighEntropyValues(['platformVersion']);
                const os = normalizeUaDataPlatform(uaData.platform ?? high.platform);
                const browser = detectBrowserFromUa(nav.userAgent ?? '', uaData);
                const platform: PasskeyPlatform = {
                    os,
                    browser: browser.name,
                    browserMajor: browser.major
                };
                if (high.platformVersion) {
                    platform.osVersion = high.platformVersion;
                }
                return platform;
            } catch {
                // fall through to UA string parsing
            }
        }

        // UA string fallback.
        const ua = nav.userAgent ?? '';
        const { os, osVersion } = parseOsFromUaString(ua);
        const browser = detectBrowserFromUa(ua, uaData);
        const platform: PasskeyPlatform = {
            os,
            browser: browser.name,
            browserMajor: browser.major
        };
        if (osVersion) {
            platform.osVersion = osVersion;
        }
        return platform;
    } catch {
        return { os: 'unknown', browser: 'unknown' };
    }
}

function normalizeUaDataPlatform(raw: string | undefined): PasskeyOs {
    if (!raw) return 'unknown';
    const p = raw.toLowerCase();
    if (p.includes('mac')) return 'macos';
    if (p.includes('win')) return 'windows';
    if (p.includes('linux')) return 'linux';
    if (p.includes('ios') || p.includes('iphone') || p.includes('ipad')) return 'ios';
    if (p.includes('android')) return 'android';
    if (p.includes('cros')) return 'linux'; // ChromeOS — closest bucket
    return 'unknown';
}

function parseOsFromUaString(ua: string): { os: PasskeyOs; osVersion?: string } {
    if (!ua) return { os: 'unknown' };

    // iOS must come before Mac OS X because iPad/iPhone UA strings
    // contain both tokens on older iPadOS.
    const iosMatch = ua.match(/(?:iPhone|iPad|iPod)[^)]*OS (\d+)[_.](\d+)/);
    if (iosMatch) {
        return { os: 'ios', osVersion: `${iosMatch[1]}.${iosMatch[2]}` };
    }

    const androidMatch = ua.match(/Android (\d+)(?:\.(\d+))?/);
    if (androidMatch) {
        const minor = androidMatch[2] ?? '0';
        return { os: 'android', osVersion: `${androidMatch[1]}.${minor}` };
    }

    const macMatch = ua.match(/Mac OS X (\d+)[_.](\d+)(?:[_.](\d+))?/);
    if (macMatch) {
        const major = parseInt(macMatch[1], 10);
        const minor = parseInt(macMatch[2], 10);
        // Both Chromium and Firefox freeze the macOS UA version at
        // 10_15_7. When we see 10.15 we know the real version is
        // macOS 11+ but cannot determine the exact release — return
        // os without version so the caller falls back to 'unknown'
        // rather than falsely concluding macOS < 15.
        if (major === 10 && minor === 15) {
            return { os: 'macos' }; // version omitted — frozen
        }
        const ver = `${macMatch[1]}.${macMatch[2]}` + (macMatch[3] ? `.${macMatch[3]}` : '');
        return { os: 'macos', osVersion: ver };
    }

    if (/Windows NT/.test(ua)) {
        return { os: 'windows' };
    }
    if (/Linux/.test(ua) && !/Android/.test(ua)) {
        return { os: 'linux' };
    }
    return { os: 'unknown' };
}

interface DetectedBrowser {
    name: PasskeyBrowser;
    major?: number;
}

function detectBrowserFromUa(ua: string, uaData?: UserAgentDataLike): DetectedBrowser {
    // Edge must be checked before Chrome; both send "Chrome/" tokens.
    if (/Edg\/(\d+)/.test(ua)) {
        const m = ua.match(/Edg\/(\d+)/);
        return { name: 'edge', major: m ? parseInt(m[1], 10) : undefined };
    }
    if (/Firefox\/(\d+)/.test(ua)) {
        const m = ua.match(/Firefox\/(\d+)/);
        return { name: 'firefox', major: m ? parseInt(m[1], 10) : undefined };
    }
    if (/Chrome\/(\d+)/.test(ua)) {
        const m = ua.match(/Chrome\/(\d+)/);
        return { name: 'chrome', major: m ? parseInt(m[1], 10) : undefined };
    }
    if (/Safari\//.test(ua) && /Version\/(\d+)/.test(ua)) {
        const m = ua.match(/Version\/(\d+)/);
        return { name: 'safari', major: m ? parseInt(m[1], 10) : undefined };
    }

    // Fall back to userAgentData.brands if present.
    if (uaData?.brands) {
        for (const b of uaData.brands) {
            const name = (b.brand ?? '').toLowerCase();
            if (name.includes('edge')) return { name: 'edge' };
            if (name.includes('chrome')) return { name: 'chrome' };
            if (name.includes('firefox')) return { name: 'firefox' };
        }
    }
    return { name: 'unknown' };
}

// ---------------------------------------------------------------------
// Decision matrix
// ---------------------------------------------------------------------

function decideFromPlatform(platform: PasskeyPlatform): PasskeyCapability {
    switch (platform.os) {
        case 'macos': {
            const major = parseMajor(platform.osVersion);
            if (major === undefined) {
                return {
                    prf: 'unknown',
                    reason:
                        'Unable to determine macOS version — PRF support depends on macOS 15 Sequoia or newer.',
                    reasonKey: 'openPasskeyDiagUnknown',
                    recommendationKey: 'openPasskeyDiagUnknownRec',
                    recommendation:
                        'If registration fails, use your master password as usual. A YubiKey 5.2.3+ will work reliably.',
                    platform
                };
            }
            if (major < MACOS_PRF_MIN_MAJOR) {
                return decorateUnsupported(platform, /* fromClientCaps */ false);
            }
            return {
                prf: 'supported',
                reason: `macOS ${platform.osVersion ?? major} supports WebAuthn PRF.`,
                platform
            };
        }
        case 'windows':
            return {
                prf: 'supported',
                reason: 'Windows Hello supports the WebAuthn PRF extension.',
                platform
            };
        case 'linux':
            return {
                prf: 'unknown',
                reason:
                    'On Linux, passkey quick unlock requires a hardware security key — no platform authenticator is available.',
                reasonKey: 'openPasskeyDiagUnsupportedLinux',
                recommendation:
                    'Plug in a YubiKey 5.2.3+ or equivalent FIDO2 key, then try again.',
                recommendationKey: 'openPasskeyDiagUnsupportedLinuxRec',
                platform
            };
        case 'ios':
        case 'android':
            return {
                prf: 'unknown',
                reason:
                    'Passkey quick unlock support on mobile browsers depends on the OS version and browser.',
                reasonKey: 'openPasskeyDiagUnknown',
                recommendationKey: 'openPasskeyDiagUnknownRec',
                recommendation:
                    'If registration fails, use your master password as usual.',
                platform
            };
        default:
            return {
                prf: 'unknown',
                reason:
                    'Unable to determine your OS — PRF support depends on platform.',
                reasonKey: 'openPasskeyDiagUnknown',
                recommendationKey: 'openPasskeyDiagUnknownRec',
                recommendation:
                    'If registration fails, use your master password as usual. A YubiKey 5.2.3+ will work reliably.',
                platform
            };
    }
}

function decorateUnsupported(
    platform: PasskeyPlatform,
    fromClientCaps: boolean
): PasskeyCapability {
    // macOS-specific actionable message — by far the most common case
    // for #9 post-ship reports (macOS 14 Sonoma was the world's most
    // common macOS release at ship time).
    if (platform.os === 'macos') {
        const ver = platform.osVersion ?? '14';
        return {
            prf: 'unsupported',
            reason: `macOS ${ver} does not expose the WebAuthn PRF extension through iCloud Keychain or Chrome profile passkeys. Apple added PRF support in macOS 15 Sequoia.`,
            reasonKey: 'openPasskeyDiagUnsupportedMacOS',
            recommendation:
                'Upgrade to macOS 15 Sequoia or newer, or plug in a YubiKey 5.2.3+ (PRF via hardware key works on any OS).',
            recommendationKey: 'openPasskeyDiagUnsupportedMacOSRec',
            platform
        };
    }
    // Generic message used when `getClientCapabilities` reported
    // `extension:prf === false` but we don't have enough OS context
    // to tailor the guidance.
    return {
        prf: 'unsupported',
        reason: fromClientCaps
            ? 'Your browser reports that WebAuthn PRF is not available in this environment.'
            : 'WebAuthn PRF is not supported in this environment.',
        reasonKey: 'openPasskeyDiagUnknown',
        recommendationKey: 'openPasskeyDiagUnknownRec',
        recommendation:
            'Use your master password to open the database. A YubiKey 5.2.3+ will work reliably.',
        platform
    };
}

/**
 * Returns `true` when the given protocol + browser combination is known
 * to block WebAuthn (`navigator.credentials.create()` throws
 * `SecurityError`). Chrome, Edge, and Safari all block WebAuthn on
 * `file://` origins; Firefox does not.
 */
function isFileProtocolBlocked(
    protocol: string | undefined,
    browser: PasskeyBrowser
): boolean {
    if (protocol !== 'file:') return false;
    // Firefox allows WebAuthn on file:// — all others block it.
    return browser !== 'firefox';
}

function parseMajor(version: string | undefined): number | undefined {
    if (!version) return undefined;
    const m = version.match(/^(\d+)/);
    if (!m) return undefined;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------
// Test-only exports. Not consumed by production code — exposed so the
// unit test can exercise the decision matrix and platform parser in
// isolation from the async probe entry point.
// ---------------------------------------------------------------------

export const __testing__ = {
    OVERRIDE_GLOBAL,
    MACOS_PRF_MIN_MAJOR,
    decideFromPlatform,
    parseMajor,
    parseOsFromUaString,
    detectBrowserFromUa,
    normalizeUaDataPlatform,
    readOverride,
    isFileProtocolBlocked
};
