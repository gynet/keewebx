import { test, expect, Page } from '@playwright/test';

/**
 * Entry clone / duplicate — CRUD coverage gap from issue #40.
 *
 * Tests the clone functionality accessed via the "More..." dropdown
 * in the details view body-fields area.
 *
 * How clone works (from source analysis):
 *   - DetailsAddFieldView renders "More..." label at bottom of fields
 *   - Clicking "More..." label triggers toggleMoreOptions() which
 *     opens a DropdownView with options including "Make a copy"
 *     (value: 'clone', text: loc.detClone = "Make a copy")
 *   - Selecting "Make a copy" calls clone() which does:
 *     newEntry = this.model.cloneEntry(' ' + loc.detClonedName)
 *     where detClonedName = "Copy", so the clone gets title
 *     "Original Title Copy"
 *   - Events.emit('select-entry', newEntry) selects the clone
 *
 * Clone can also be accessed via right-click context menu
 * (value: 'det-clone'), but the "More..." dropdown path is more
 * reliable for Playwright testing.
 */

const SCREENSHOT_DIR = 'e2e/screenshots';

async function openDemoDatabase(page: Page): Promise<void> {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.locator('#open__icon-demo').click();
    await page.waitForSelector('.list__item', { timeout: 20_000 });
}

test.describe('Entry clone / duplicate', () => {
    test('clone entry via More dropdown creates a copy with " Copy" suffix', async ({
        page
    }) => {
        await openDemoDatabase(page);

        // Select "Demo Bank" entry
        const targetTitle = 'Demo Bank';
        const entry = page.locator('.list__item').filter({ hasText: targetTitle }).first();
        await expect(entry).toBeVisible({ timeout: 5_000 });
        await entry.click();

        // Wait for details panel to fully render
        await expect(page.locator('.details')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('.details__header-title')).toContainText(targetTitle, {
            timeout: 5_000
        });

        // Record the initial entry count
        const initialCount = await page.locator('.list__item').count();

        // Find and click the "More..." label in the details body-fields.
        // DetailsAddFieldView renders at bottom of .details__body-fields
        // with label text matching locale key "detMore" = "More" + ellipsis.
        // The label is `.details__field-label` within the last
        // `.details__field--no-select` element.
        const moreLabel = page
            .locator('.details__field--no-select .details__field-label')
            .first();
        await expect(moreLabel).toBeVisible({ timeout: 5_000 });
        await moreLabel.click();

        // The dropdown with clone option should appear
        const dropdown = page.locator('.dropdown');
        await expect(dropdown).toBeVisible({ timeout: 5_000 });

        // Find and click the "Make a copy" option (value='clone')
        const cloneOption = page.locator('.dropdown__item[data-value="clone"]');
        await expect(cloneOption).toBeVisible({ timeout: 5_000 });
        await cloneOption.click();

        // After clone:
        // 1. Entry count increases by 1
        await expect(page.locator('.list__item')).toHaveCount(initialCount + 1, {
            timeout: 10_000
        });

        // 2. The cloned entry should be selected (details view shows it).
        //    Its title should contain the original title + " Copy" suffix.
        //    (detClonedName = "Copy", prepended with space: ' Copy')
        const clonedTitle = page.locator('.details__header-title');
        await expect(clonedTitle).toBeVisible({ timeout: 5_000 });
        const clonedTitleText = await clonedTitle.textContent();
        expect(clonedTitleText).toContain(targetTitle);
        expect(clonedTitleText).toContain('Copy');

        // 3. The clone should appear in the list
        const clonedListItem = page
            .locator('.list__item')
            .filter({ hasText: /Copy/ })
            .first();
        await expect(clonedListItem).toBeVisible({ timeout: 5_000 });

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/entry-clone-01-after-clone.png`,
            fullPage: true
        });
    });

    test('cloned entry has different Created timestamp than original', async ({ page }) => {
        await openDemoDatabase(page);

        // Select "GitHub" entry (pick a different entry from the first test)
        const targetTitle = 'GitHub';
        const entry = page.locator('.list__item').filter({ hasText: targetTitle }).first();
        await expect(entry).toBeVisible({ timeout: 5_000 });
        await entry.click();

        await expect(page.locator('.details')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('.details__header-title')).toContainText(targetTitle, {
            timeout: 5_000
        });

        // Read the original entry's Created timestamp from the aside fields.
        // "Created" is rendered by FieldViewReadOnly in .details__body-aside
        // as a .details__field with label "Created".
        const createdField = page
            .locator('.details__field')
            .filter({ has: page.locator('.details__field-label', { hasText: 'Created' }) })
            .first();
        const originalCreated = await createdField
            .locator('.details__field-value')
            .textContent();
        expect(originalCreated).toBeTruthy();

        // Clone via More... dropdown
        const moreLabel = page
            .locator('.details__field--no-select .details__field-label')
            .first();
        await expect(moreLabel).toBeVisible({ timeout: 5_000 });
        await moreLabel.click();

        const dropdown = page.locator('.dropdown');
        await expect(dropdown).toBeVisible({ timeout: 5_000 });
        await page.locator('.dropdown__item[data-value="clone"]').click();

        // Now viewing the clone — wait for it to be selected
        await expect(page.locator('.details__header-title')).toContainText('Copy', {
            timeout: 5_000
        });

        // Read the clone's Created timestamp
        const cloneCreatedField = page
            .locator('.details__field')
            .filter({ has: page.locator('.details__field-label', { hasText: 'Created' }) })
            .first();
        const cloneCreated = await cloneCreatedField
            .locator('.details__field-value')
            .textContent();
        expect(cloneCreated).toBeTruthy();

        // The clone's created timestamp should be different from (newer
        // than) the original. Both are formatted by DateFormat.dtStr.
        // If they happen to be in the same second, they could match,
        // but for a demo entry created long ago vs. now-cloned entry,
        // they will differ.
        expect(cloneCreated).not.toBe(originalCreated);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/entry-clone-02-different-created.png`,
            fullPage: true
        });
    });
});
