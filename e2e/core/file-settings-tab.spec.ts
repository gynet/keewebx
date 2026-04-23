import { test, expect } from '@playwright/test';

/**
 * Regression guard for the File-settings sidebar entry (#17 UX follow-up).
 *
 * Prior UX: only the dynamic filename entry was rendered in the Settings
 * sidebar under the database's own name, which forces users to realise
 * "the thing labelled `Demo` is actually file-level settings." The fix
 * adds a *static* "File" entry above the filename list that is always
 * named "File" and is visible whenever a database is open.
 *
 * Flow covered here:
 *   1. Open the demo database
 *   2. Open Settings via the footer cog (`#footer__btn-settings`)
 *   3. Assert a sidebar item titled exactly "File" is present
 *   4. Click it -> asserts file settings page rendered
 *      (master password input `#settings__file-master-pass` visible)
 *   5. Return to app, close the file, re-open settings,
 *      assert the "File" entry is no longer in the sidebar.
 *
 * We keep the existing filename-labelled entry intact (that's the dynamic
 * `filesSection`), so a sidebar with "File" AND "Demo" is the correct
 * end state, not a duplicate.
 */
test.describe('File settings sidebar entry', () => {
    test('appears above filename after opening a DB, hides when closed', async ({
        page
    }) => {
        await page.goto('/', { waitUntil: 'networkidle' });

        // Open demo DB.
        const demoBtn = page.locator('#open__icon-demo');
        await expect(demoBtn).toBeVisible({ timeout: 15_000 });
        await demoBtn.click();
        await expect(page.locator('.list__item').first()).toBeVisible({
            timeout: 30_000
        });

        // Open Settings via the footer cog (stable selector).
        const cog = page.locator('#footer__btn-settings');
        await expect(cog).toBeVisible();
        await cog.click();

        // Settings menu renders. The static "File" entry should be
        // present. `filter({ hasText: /^File$/ })` matches the title span
        // exactly so we don't collide with longer labels that happen to
        // contain the word (none today, but futureproofing).
        const fileEntry = page
            .locator('.menu__item-title')
            .filter({ hasText: /^File$/ });
        await expect(fileEntry).toHaveCount(1, { timeout: 10_000 });

        // Clicking "File" lands on the file settings page.
        await fileEntry.first().click();
        const masterPass = page.locator('#settings__file-master-pass');
        await expect(masterPass).toBeVisible({ timeout: 5_000 });

        // Close the file. Lock button is in the footer.
        // Back to main app first so the lock button's click path is clean.
        await page.locator('.settings__back-button').first().click();
        await expect(page.locator('.list__item').first()).toBeVisible({
            timeout: 10_000
        });

        // Close demo file via the footer lock button — this triggers
        // `closeFile` which calls `updateFileSettingsSection(false)` and
        // must dynamically hide the static File entry from the sidebar.
        await page.locator('#footer__btn-lock').click();

        // After lock, the open-view renders. We don't care which open
        // icon is now visible (the demo icon moves between template
        // sections); we just need to confirm we're back on the open
        // screen by looking for the input. Then we re-enter settings.
        await expect(page.locator('.open__pass-area, .open__icons').first()).toBeVisible({
            timeout: 10_000
        });

        // Open settings from the open-view. The settings icon lives in
        // the "lower" row which is hidden until the user clicks "More".
        // (Footer cog is only visible while a file is open.)
        await page.locator('#open__icon-more').click();
        const openSettings = page.locator('#open__icon-settings');
        await expect(openSettings).toBeVisible({ timeout: 5_000 });
        await openSettings.click();
        // The File entry must be *not visible* when no file is open.
        // The section element may linger in the DOM with display:none,
        // so we assert user-visible hidden-ness rather than DOM absence.
        await expect(
            page
                .locator('.menu__item-title:visible')
                .filter({ hasText: /^File$/ })
        ).toHaveCount(0, { timeout: 5_000 });
    });
});
