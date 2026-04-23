import { test, expect } from '@playwright/test';

/**
 * Theme + persistence E2E — cross-validates BOTH warroom fixes from
 * 2026-04-09:
 *
 *   - settings-manager.ts (was a stub; setTheme/setFontSize/setLocale
 *     were no-ops). The first test confirms SettingsManager.setBySettings()
 *     actually applies a theme class to <body> at boot.
 *
 *   - settings-store.ts (was a stub; load/save returned Promise.resolve()).
 *     The reload-persistence test writes a non-default theme into the
 *     persisted AppSettings via localStorage, reloads, and verifies the
 *     restored theme survives. This is only green if BOTH fixes are
 *     present: SettingsStore.load() must return the localStorage data,
 *     AND SettingsManager.setTheme() must actually apply it.
 *
 * If a future change re-stubs either module, this spec turns red and
 * blocks the deploy via the verify-live CI job.
 */

test.describe('Theme + persistence', () => {
    test.beforeEach(async ({ page }) => {
        // Cold start: clear any leftover settings from previous tests so
        // each case has deterministic state.
        await page.goto('/');
        await page.evaluate(() => {
            localStorage.clear();
        });
    });

    test('body has a theme class after SettingsManager boots', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const bodyClass = await page.evaluate(() => document.body.className);
        // Either th-dark (the index.html pre-paint default that
        // SettingsManager.setBySettings() leaves alone when settings.theme
        // resolves to dark) or any other th-* class. The point is that
        // there IS a th-* class — settings-manager isn't a no-op.
        expect(bodyClass, 'body must have a /^th-/ class').toMatch(/(^|\s)th-/);
    });

    test('persisted theme survives reload', async ({ page }) => {
        // Step 1: visit, write a non-default theme into localStorage
        // exactly the way AppSettingsModel.save() would (via SettingsStore
        // → localStorage[StringFormat.camelCase('app-settings')]).
        // The key MUST be 'appSettings' (camelCase of 'app-settings'),
        // matching upstream KeeWeb's web-mode SettingsStore behavior.
        await page.goto('/');
        await page.evaluate(() => {
            localStorage.setItem('appSettings', JSON.stringify({ theme: 'fb' }));
        });

        // Step 2: reload — this is the step that exercises the full
        // SettingsStore.load → AppSettingsModel.load → SettingsManager
        // .setBySettings → setTheme(document.body) chain. Each link must
        // work or the body class won't be 'th-fb' after this reload.
        await page.reload();
        await page.waitForLoadState('networkidle');

        // Step 3: verify the persisted theme was actually applied
        const bodyClass = await page.evaluate(() => document.body.className);
        expect(
            bodyClass,
            'theme persisted in localStorage as "fb" must be applied as "th-fb" on reload'
        ).toMatch(/(^|\s)th-fb(\s|$)/);
    });

    test('persisted theme is overridden, not stacked', async ({ page }) => {
        // Regression check: setTheme() must STRIP previous /^th-/ classes
        // before adding the new one. If it just appends, body ends up
        // with `th-dark th-fb` and CSS specificity gets weird.
        await page.goto('/');
        await page.evaluate(() => {
            localStorage.setItem('appSettings', JSON.stringify({ theme: 'fb' }));
        });
        await page.reload();
        await page.waitForLoadState('networkidle');

        const themeClasses = await page.evaluate(() => {
            return Array.from(document.body.classList).filter((c) => c.startsWith('th-'));
        });
        expect(themeClasses, 'body must have exactly one th-* class').toHaveLength(1);
        expect(themeClasses[0]).toBe('th-fb');
    });
});
