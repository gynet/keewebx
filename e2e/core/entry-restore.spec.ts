import { test, expect, Page } from '@playwright/test';

/**
 * Entry restore from trash — CRUD coverage gap from issue #40.
 *
 * Investigation results (from source analysis):
 *   - details.hbs:49-53 shows two states for the trash area:
 *     if `deleted` → shows `.details__buttons-trash-del` (permanent delete)
 *     else → shows `.details__buttons-trash` (move to trash)
 *   - There is NO `.details__buttons-restore` class anywhere in the
 *     codebase (confirmed via grep).
 *   - There is no `restoreEntry`, `undelete`, or `restore` method on
 *     the entry model or details view for recovering trashed entries.
 *   - The only way to "restore" a trashed entry in KeeWeb/KeeWebX
 *     is via drag-and-drop: drag the entry from the Trash view back
 *     to a group in the menu sidebar. This uses the same moveHere()
 *     mechanism tested in entry-move.spec.ts.
 *
 * This spec documents the UI gap and tests the drag-based restore
 * workaround. The first test verifies there is no dedicated restore
 * button. The second test exercises the drag-from-trash path.
 */

const SCREENSHOT_DIR = 'e2e/screenshots';

async function openDemoDatabase(page: Page): Promise<void> {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.locator('#open__icon-demo').click();
    await page.waitForSelector('.list__item', { timeout: 20_000 });
}

test.describe('Entry restore from trash', () => {
    test('no dedicated restore button exists for trashed entries (UI gap)', async ({
        page
    }) => {
        test.info().annotations.push({
            type: 'gap',
            description:
                'KeeWebX has no restore/undelete button for trashed entries. ' +
                'The only recovery path is drag-and-drop from Trash back to a group. ' +
                'A dedicated restore button would improve UX for non-power-users.'
        });

        await openDemoDatabase(page);

        // Create an entry and immediately trash it
        await page.locator('.list__search-btn-new').click();
        await expect(page.locator('.dropdown')).toBeVisible({ timeout: 5_000 });
        await page.locator('.dropdown__item[data-value="entry"]').click();

        const titleInput = page.locator('.details__header-title-input');
        await expect(titleInput).toBeVisible({ timeout: 5_000 });
        const entryTitle = `TrashMe-${Date.now()}`;
        await titleInput.fill(entryTitle);
        await titleInput.press('Enter');

        // Trash it
        const trashBtn = page.locator('.details__buttons-trash');
        await expect(trashBtn).toBeVisible();
        await trashBtn.click();

        // Navigate to Trash
        const trashMenuItem = page
            .locator('.menu__item')
            .filter({ hasText: /trash/i })
            .first();
        await expect(trashMenuItem).toBeVisible();
        await trashMenuItem.click();

        // Find the entry in trash
        const trashedEntry = page
            .locator('.list__item')
            .filter({ hasText: entryTitle });
        await expect(trashedEntry).toBeVisible({ timeout: 5_000 });

        // Click the trashed entry to open details
        await trashedEntry.click();
        await expect(page.locator('.details')).toBeVisible({ timeout: 5_000 });

        // Verify: the permanent-delete button exists...
        const permDeleteBtn = page.locator('.details__buttons-trash-del');
        await expect(permDeleteBtn).toBeVisible({ timeout: 5_000 });

        // ...but there is no restore button
        const restoreBtn = page.locator('.details__buttons-restore');
        await expect(restoreBtn).toHaveCount(0);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/entry-restore-01-no-restore-button.png`,
            fullPage: true
        });
    });

    test('drag trashed entry back to a group restores it', async ({ page }) => {
        await openDemoDatabase(page);

        // Create an entry and trash it
        await page.locator('.list__search-btn-new').click();
        await expect(page.locator('.dropdown')).toBeVisible({ timeout: 5_000 });
        await page.locator('.dropdown__item[data-value="entry"]').click();

        const titleInput = page.locator('.details__header-title-input');
        await expect(titleInput).toBeVisible({ timeout: 5_000 });
        const entryTitle = `RestoreMe-${Date.now()}`;
        await titleInput.fill(entryTitle);
        await titleInput.press('Enter');

        // Wait for entry to be confirmed in list
        await expect(
            page.locator('.list__item').filter({ hasText: entryTitle })
        ).toBeVisible({ timeout: 5_000 });

        // Trash it
        const trashBtn = page.locator('.details__buttons-trash');
        await expect(trashBtn).toBeVisible();
        await trashBtn.click();

        // Navigate to Trash to find the entry
        const trashMenuItem = page
            .locator('.menu__item')
            .filter({ hasText: /trash/i })
            .first();
        await expect(trashMenuItem).toBeVisible();
        await trashMenuItem.click();
        await page.waitForTimeout(500);

        const trashedEntry = page
            .locator('.list__item')
            .filter({ hasText: entryTitle });
        await expect(trashedEntry).toBeVisible({ timeout: 5_000 });

        // Find a target group (General) to drag the entry to.
        // Using .menu__item-title to find the group label, then
        // its parent .menu__item as the drop target.
        const generalGroupTitle = page
            .locator('.menu__item-title')
            .filter({ hasText: 'General' })
            .first();
        await expect(generalGroupTitle).toBeVisible({ timeout: 5_000 });
        const generalMenuItem = generalGroupTitle
            .locator('xpath=ancestor::div[contains(@class,"menu__item")]')
            .first();

        // Drag the trashed entry from the list to the General group
        await trashedEntry.dragTo(generalMenuItem);

        // After drag-restore, the entry should no longer be in the
        // Trash list
        await expect(async () => {
            const trashedCount = await page
                .locator('.list__item')
                .filter({ hasText: entryTitle })
                .count();
            expect(trashedCount).toBe(0);
        }).toPass({ timeout: 5_000 });

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/entry-restore-02-after-drag-restore.png`,
            fullPage: true
        });

        // Navigate to General group to verify the entry is there
        await generalMenuItem.click();
        await page.waitForTimeout(500);

        await expect(
            page.locator('.list__item').filter({ hasText: entryTitle }),
            `Entry "${entryTitle}" should appear in the General group after drag-restore`
        ).toBeVisible({ timeout: 10_000 });

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/entry-restore-03-in-general-group.png`,
            fullPage: true
        });
    });
});
