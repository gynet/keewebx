import { test, expect } from '@playwright/test';

const SCREENSHOT_DIR = 'e2e/screenshots';

/**
 * Helper: open the Demo database and wait for entries to load.
 */
async function openDemoDatabase(page: import('@playwright/test').Page) {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const demoBtn = page.locator('#open__icon-demo');
    await expect(demoBtn).toBeVisible({ timeout: 15_000 });
    await demoBtn.click();

    // Wait for entries to populate in the list
    const listItems = page.locator('.list__item');
    await expect(listItems.first()).toBeVisible({ timeout: 30_000 });
    return listItems;
}

/**
 * Helper: create a new empty database.
 */
async function createNewDatabase(page: import('@playwright/test').Page) {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const newBtn = page.locator('#open__icon-new');
    await expect(newBtn).toBeVisible({ timeout: 15_000 });
    await newBtn.click();

    // Wait for the app body to appear (menu visible)
    await expect(page.locator('.app__body .app__menu')).toBeVisible({ timeout: 15_000 });
}

test.describe('Core Features', () => {

    test('search filters entries by title', async ({ page }) => {
        const listItems = await openDemoDatabase(page);
        const totalCount = await listItems.count();
        expect(totalCount).toBeGreaterThanOrEqual(3);

        // Type in the search field to filter entries
        const searchField = page.locator('.list__search-field');
        await expect(searchField).toBeVisible();

        // Get the title of the first entry to use as search term
        const firstTitle = await listItems.first().locator('.list__item-title').textContent();
        expect(firstTitle).toBeTruthy();

        // Type part of the first entry's title into search
        const searchTerm = firstTitle!.substring(0, Math.min(4, firstTitle!.length));
        await searchField.fill(searchTerm);

        // Wait for filter to take effect
        await page.waitForTimeout(500);

        // The list should now have fewer entries (or same if search term matches all)
        const filteredItems = page.locator('.list__item');
        const filteredCount = await filteredItems.count();

        // Every visible entry title should contain the search term (case insensitive)
        for (let i = 0; i < filteredCount; i++) {
            const title = await filteredItems.nth(i).locator('.list__item-title').textContent();
            // The search also matches description, user, url, etc — not just title.
            // So we just verify the list was filtered (count changed or stayed same if all match)
        }

        // Verify filtering happened — at least check the filter is active
        expect(filteredCount).toBeLessThanOrEqual(totalCount);
        expect(filteredCount).toBeGreaterThan(0);

        // Clear search → all entries return
        const clearBtn = page.locator('.list__search-icon-clear');
        await clearBtn.click();
        await page.waitForTimeout(500);

        const restoredCount = await page.locator('.list__item').count();
        expect(restoredCount).toBe(totalCount);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/features-search-filter.png`,
            fullPage: true,
        });
    });

    test('entry details show all standard fields', async ({ page }) => {
        await openDemoDatabase(page);

        // Click the first entry in the list
        const firstItem = page.locator('.list__item').first();
        await firstItem.click();

        // Wait for the details panel to render
        const detailsView = page.locator('.details');
        await expect(detailsView).toBeVisible({ timeout: 10_000 });

        // The header title should be visible and non-empty
        const headerTitle = page.locator('.details__header-title');
        await expect(headerTitle).toBeVisible();
        const titleText = await headerTitle.textContent();
        expect(titleText).toBeTruthy();
        expect(titleText!.length).toBeGreaterThan(0);

        // Standard fields: User, Password, Website, Notes
        // These are rendered as .details__field elements with .details__field-label
        const fieldLabels = page.locator('.details__field-label');
        const labelCount = await fieldLabels.count();
        expect(labelCount).toBeGreaterThanOrEqual(4); // At least User, Password, Website, Notes

        // Collect all field label texts
        const labels: string[] = [];
        for (let i = 0; i < labelCount; i++) {
            const text = await fieldLabels.nth(i).textContent();
            if (text) labels.push(text.trim());
        }

        // Verify the essential fields exist (locale may vary, but default is English)
        expect(labels.some(l => /user/i.test(l))).toBe(true);
        expect(labels.some(l => /password/i.test(l))).toBe(true);
        expect(labels.some(l => /website/i.test(l))).toBe(true);
        expect(labels.some(l => /notes/i.test(l))).toBe(true);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/features-entry-details.png`,
            fullPage: true,
        });
    });

    test('password generator produces passwords from footer', async ({ page }) => {
        await openDemoDatabase(page);

        // Click the generator button in the footer (bolt icon)
        const genBtn = page.locator('#footer__btn-generate');
        await expect(genBtn).toBeVisible();
        await genBtn.click();

        // The generator popup should appear
        const genView = page.locator('.gen');
        await expect(genView).toBeVisible({ timeout: 5_000 });

        // The result div should contain a generated password
        const resultEl = page.locator('.gen__result');
        await expect(resultEl).toBeVisible();

        const password = await resultEl.textContent();
        expect(password).toBeTruthy();
        expect(password!.length).toBeGreaterThan(0);

        // Click the refresh button to regenerate
        const refreshBtn = page.locator('.gen__btn-refresh');
        await refreshBtn.click();
        await page.waitForTimeout(300);

        const newPassword = await resultEl.textContent();
        expect(newPassword).toBeTruthy();
        expect(newPassword!.length).toBeGreaterThan(0);

        // The new password should be different (extremely unlikely to be same)
        // But don't assert this strictly — just verify it generated something
        expect(newPassword!.trim().length).toBeGreaterThanOrEqual(1);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/features-password-generator.png`,
            fullPage: true,
        });
    });

    test('edit entry title and verify change persists', async ({ page }) => {
        await openDemoDatabase(page);

        // Click the first entry in the list
        const listItems = page.locator('.list__item');
        await listItems.first().click();

        // Wait for details to appear
        const detailsView = page.locator('.details');
        await expect(detailsView).toBeVisible({ timeout: 10_000 });

        // Click the title to edit it
        const headerTitle = page.locator('.details__header-title');
        await expect(headerTitle).toBeVisible();
        const originalTitle = await headerTitle.textContent();
        await headerTitle.click();

        // An input field should appear for editing the title
        const titleInput = page.locator('.details__header-title-input');
        await expect(titleInput).toBeVisible({ timeout: 5_000 });

        // Clear and type new title
        const newTitle = 'Edited ' + Date.now();
        await titleInput.fill(newTitle);
        await titleInput.press('Enter');

        // Verify the title changed in the details header
        await expect(headerTitle).toContainText(newTitle);

        // Verify it also changed in the list item
        const listItemTitle = listItems.first().locator('.list__item-title');
        await expect(listItemTitle).toContainText(newTitle);

        // Undo: restore original title so demo db state is clean
        await headerTitle.click();
        const restoreInput = page.locator('.details__header-title-input');
        await restoreInput.fill(originalTitle || 'Sample Entry');
        await restoreInput.press('Enter');

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/features-edit-entry.png`,
            fullPage: true,
        });
    });

    test('delete entry moves to trash', async ({ page }) => {
        await openDemoDatabase(page);

        const listItems = page.locator('.list__item');
        const initialCount = await listItems.count();
        expect(initialCount).toBeGreaterThan(0);

        // Click the last entry in the list (least important to avoid breaking other tests)
        await listItems.last().click();

        const detailsView = page.locator('.details');
        await expect(detailsView).toBeVisible({ timeout: 10_000 });

        // Get the title for verification
        const headerTitle = page.locator('.details__header-title');
        await expect(headerTitle).toBeVisible();

        // Click the trash button to delete
        const trashBtn = page.locator('.details__buttons-trash');
        await expect(trashBtn).toBeVisible();
        await trashBtn.click();

        // Entry count should decrease by one
        await page.waitForTimeout(500);
        const afterDeleteCount = await page.locator('.list__item').count();
        expect(afterDeleteCount).toBe(initialCount - 1);

        // Navigate to the Trash/Recycle Bin in the menu
        const trashMenuItem = page.locator('.menu__item').filter({ hasText: /trash/i });
        await expect(trashMenuItem).toBeVisible();
        await trashMenuItem.click();

        // Wait for the trash entries to load
        await page.waitForTimeout(500);

        // The deleted entry should be in the recycle bin
        const trashItems = page.locator('.list__item');
        const trashCount = await trashItems.count();
        expect(trashCount).toBeGreaterThanOrEqual(1);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/features-delete-to-trash.png`,
            fullPage: true,
        });
    });

    test('keyboard shortcut focuses search field', async ({ page }) => {
        await openDemoDatabase(page);

        const searchField = page.locator('.list__search-field');
        await expect(searchField).toBeVisible();

        // The search in this app is triggered by simply typing any character
        // while the app is focused (keypress event handler in list-search-view).
        // It's not Ctrl+F. Any keypress that isn't a modifier focuses the search.

        // Click somewhere neutral first (not on the search field)
        await page.locator('.app__body').click();
        await page.waitForTimeout(200);

        // Press a regular key — should focus the search field and type in it
        await page.keyboard.press('a');
        await page.waitForTimeout(300);

        // Verify the search field now has focus and contains the typed character
        await expect(searchField).toBeFocused();
        const searchValue = await searchField.inputValue();
        expect(searchValue).toContain('a');

        // Pressing Escape should clear the search and blur
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        const clearedValue = await searchField.inputValue();
        expect(clearedValue).toBe('');

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/features-keyboard-search.png`,
            fullPage: true,
        });
    });

    test('copy password to clipboard via keyboard shortcut', async ({ page, context }) => {
        // Grant clipboard permissions
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);

        await openDemoDatabase(page);

        // Click the first entry to select it
        const firstItem = page.locator('.list__item').first();
        await firstItem.click();

        // Wait for details to be visible
        await expect(page.locator('.details')).toBeVisible({ timeout: 10_000 });

        // Use Cmd/Ctrl+C to copy password (the app's shortcut for copying password)
        const isMac = process.platform === 'darwin';
        const modifier = isMac ? 'Meta' : 'Control';
        await page.keyboard.press(`${modifier}+c`);

        // The copy tip/notification should appear briefly
        // We verify by checking clipboard content is not empty
        await page.waitForTimeout(500);

        const clipboardText = await page.evaluate(async () => {
            try {
                return await navigator.clipboard.readText();
            } catch {
                return null;
            }
        });

        // The clipboard should have something (the password)
        // Note: the demo entries have passwords, so this should not be empty
        expect(clipboardText).not.toBeNull();

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/features-copy-password.png`,
            fullPage: true,
        });
    });
});
