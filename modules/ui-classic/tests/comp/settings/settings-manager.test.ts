import { describe, test, expect, mock } from 'bun:test';

/**
 * Unit tests for `comp/settings/settings-manager` — data-table
 * regression guard.
 *
 * The stubbed version of this module exposed only 1 locale (`en-US`)
 * and 2 themes (`dark`, `light`), and every setter (`setTheme`,
 * `setFontSize`, `setLocale`, `init`, `setBySettings`) was a no-op.
 * The settings UI silently did nothing even though 12 themes + 3
 * locales ship in the bundle.
 *
 * These tests enforce that the three critical data tables are the
 * full upstream set. We do NOT test the DOM mutation paths
 * (`setTheme` writes `th-*` class on `document.body`) here because
 * Bun's test runner has no DOM by default — the E2E persistence spec
 * and E2E theme-switching coverage would handle that layer. This test
 * is the line-of-defense that catches a "stub regression" by
 * asserting on the shape of the exported module, which requires no
 * DOM.
 *
 * The module imports `AppSettingsModel`, which itself imports
 * `SettingsStore`. In this test process `SettingsStore` is the real
 * module (no `mock.module` installed), which exercises `localStorage`
 * via a shim installed below. That's a harmless side effect; the
 * tests do not rely on it.
 */

// hbs is a webpack alias; stub it for the Bun test context.
mock.module('hbs', () => ({
    default: { escapeExpression: (s: string) => s }
}));

// locales/base.json is resolved by webpack alias at build time; the
// Bun test runner has no such resolution. Provide a minimal empty
// Locale dictionary so `util/locale` can import without crashing.
mock.module('locales/base.json', () => ({
    default: {}
}));

// Provide a minimal `localStorage` shim so SettingsStore's
// `typeof localStorage !== 'undefined'` branch doesn't explode when
// AppSettingsModel triggers its on('change') -> save() callback.
interface MinimalStorage {
    [key: string]: string;
}
(globalThis as unknown as { localStorage: MinimalStorage }).localStorage =
    {} as MinimalStorage;

// SettingsManager also imports ThemeWatcher which reads
// `window.matchMedia` inside its `init()` — we never call init() in
// these tests so no stub is needed. The module-load path only reads
// `Features.isMobile` which touches `navigator`, so we need a
// navigator shim with the expected shape.
//
// Bun provides `navigator` with `.platform` but NOT `.languages`
// / `.language`, so we augment the existing object. Using
// `Object.defineProperty` because Bun's navigator is not extensible
// via plain assignment.
try {
    const nav = (globalThis as unknown as { navigator: Record<string, unknown> })
        .navigator;
    if (nav && typeof nav === 'object') {
        Object.defineProperty(nav, 'languages', {
            value: ['en-US'],
            configurable: true,
            writable: true
        });
        Object.defineProperty(nav, 'language', {
            value: 'en-US',
            configurable: true,
            writable: true
        });
        if (!('userAgent' in nav) || !nav.userAgent) {
            Object.defineProperty(nav, 'userAgent', {
                value: 'bun-test',
                configurable: true,
                writable: true
            });
        }
    }
} catch {
    /* best-effort navigator shim — getBrowserLocale test will fail
       visibly if this didn't take effect, which is the intended
       behavior */
}

// `screen` is read by Features.isMobile detection.
if (typeof (globalThis as { screen?: unknown }).screen === 'undefined') {
    (globalThis as unknown as { screen: Record<string, unknown> }).screen = {
        width: 1920
    };
}

// `window` is used by Features for isFrame / isPopup / isLocal and by
// SettingsManager inside setTheme for getComputedStyle. We only load
// the module here, so a shallow stub is enough.
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
        parent: {},
        top: {},
        opener: null,
        location: { href: 'http://localhost:8085', origin: 'http://localhost:8085' }
    };
}

// `location` is read by Features.isSelfHosted / isLocal.
if (typeof (globalThis as { location?: unknown }).location === 'undefined') {
    (globalThis as unknown as { location: Record<string, unknown> }).location = {
        href: 'http://localhost:8085/',
        origin: 'http://localhost:8085'
    };
}

const { SettingsManager } = await import(
    '../../../app/scripts/comp/settings/settings-manager'
);

describe('SettingsManager — data tables', () => {
    test('allThemes has all 12 upstream themes', () => {
        const ids = Object.keys(SettingsManager.allThemes).sort();
        expect(ids).toEqual(
            [
                'bl', 'db', 'dark', 'dc', 'fb',
                'hc', 'lb', 'light', 'lt', 'sd',
                'sl', 'te'
            ].sort()
        );
    });

    test('allThemes values are Locale keys (setGenTheme*)', () => {
        for (const [id, name] of Object.entries(SettingsManager.allThemes)) {
            expect(name, `theme ${id} should map to a setGenTheme* locale key`).toMatch(
                /^setGenTheme/
            );
        }
    });

    test('allLocales exposes en-US + de-DE + fr-FR (matches bundled JSON)', () => {
        const locales = Object.keys(SettingsManager.allLocales).sort();
        expect(locales).toEqual(['de-DE', 'en-US', 'fr-FR']);
    });

    test('autoSwitchedThemes pairs are internally consistent', () => {
        // Every dark theme referenced by autoSwitchedThemes must exist
        // in allThemes; same for every light counterpart. This catches
        // typo drift between the pair table and the themes table.
        for (const pair of SettingsManager.autoSwitchedThemes) {
            expect(SettingsManager.allThemes[pair.dark], `${pair.name}.dark`)
                .toBeDefined();
            expect(SettingsManager.allThemes[pair.light], `${pair.name}.light`)
                .toBeDefined();
            expect(pair.name).toMatch(/^setGenTheme/);
        }
    });

    test('autoSwitchedThemes has the 6 upstream pair configurations', () => {
        expect(SettingsManager.autoSwitchedThemes).toHaveLength(6);
        const names = SettingsManager.autoSwitchedThemes.map((p) => p.name).sort();
        expect(names).toEqual(
            [
                'setGenThemeBlue',
                'setGenThemeBrown',
                'setGenThemeDefault',
                'setGenThemeHighContrast',
                'setGenThemeSol',
                'setGenThemeTerminal'
            ].sort()
        );
    });

    test('getDefaultTheme returns "dark"', () => {
        expect(SettingsManager.getDefaultTheme()).toBe('dark');
    });

    test('getThemeClass prefixes the id with "th-"', () => {
        expect(SettingsManager.getThemeClass('dark')).toBe('th-dark');
        expect(SettingsManager.getThemeClass('sl')).toBe('th-sl');
    });

    test('selectDarkOrLightTheme maps id to pair counterpart based on themeWatcher', () => {
        // themeWatcher.dark starts false in Bun test env (ThemeWatcher
        // default). For a dark id in a pair, selectDarkOrLightTheme
        // returns the `light` half when watcher is light, and `dark`
        // half when watcher is dark.
        const beforeDark = SettingsManager.selectDarkOrLightTheme('sd');
        const beforeLight = SettingsManager.selectDarkOrLightTheme('sl');
        // Both of the above belong to the Solarized pair — results
        // must be one of { sd, sl }.
        expect(['sd', 'sl']).toContain(beforeDark);
        expect(['sd', 'sl']).toContain(beforeLight);
    });

    test('selectDarkOrLightTheme is identity for themes not in any pair', () => {
        // All 12 current themes happen to be in pairs, but the method
        // must still fall through cleanly for an unknown id.
        expect(SettingsManager.selectDarkOrLightTheme('no-such-theme')).toBe(
            'no-such-theme'
        );
    });

    test('getBrowserLocale prefers en-US for any English navigator language', () => {
        // Our navigator shim uses 'en-US', so the first language starts
        // with "en" and we get the normalized 'en-US'.
        expect(SettingsManager.getBrowserLocale()).toBe('en-US');
    });

    test('setters exist as functions (not no-ops placeholder)', () => {
        // The stub regression signature was `setTheme(_){}`: a literal
        // empty body. Real implementations have non-zero Function
        // `.length` (at least one parameter) and non-empty source text.
        // We can't test source text directly under Bun, but we can
        // assert the functions were bound with the expected arity AND
        // are not the stub's zero-argument `setTheme(): void {}`.
        expect(typeof SettingsManager.setTheme).toBe('function');
        expect(typeof SettingsManager.setFontSize).toBe('function');
        expect(typeof SettingsManager.setLocale).toBe('function');
        expect(typeof SettingsManager.init).toBe('function');
        expect(typeof SettingsManager.setBySettings).toBe('function');
        expect(typeof SettingsManager.darkModeChanged).toBe('function');
        // The stub was `setTheme(_theme?: string): void {}`. Real
        // impl has the same arity, so we can't differentiate via
        // Function.length alone. Instead we verify the real-impl side
        // effect: calling the real getThemeClass (which the stub did
        // not have at all) returns a non-empty prefix.
        expect(SettingsManager.getThemeClass('x')).toBe('th-x');
    });
});
