import { test, expect, Page } from '@playwright/test';

/**
 * Entry & group CRUD regression guard.
 *
 * Fills the gap identified on 2026-04-09: earlier E2E specs covered
 * read (features.spec.ts), partial update (features.spec.ts — title
 * edit), and delete (features.spec.ts — move to trash), but the
 * CREATE path for entries AND groups, plus group rename and group
 * delete, had zero coverage. Without these tests a regression like
 * "the + button stopped working" or "new group always renders as
 * empty" would ship silently.
 *
 * Strategy:
 *   - Use the demo database as the fixture (no upload, no file
 *     chooser — faster + deterministic).
 *   - Each test is self-contained: every mutation is clean-room
 *     (new entries get a unique timestamped title). Test mutations
 *     stay in the in-memory copy of the demo db; a fresh page load
 *     resets state for the next test.
 *
 * Critical implementation details discovered by reading the source
 * (do NOT change these without updating the tests):
 *
 *   1. ENTRY create flow — details-view.ts:490
 *      When `entry.isJustCreated && !entry.title`, showEntry()
 *      calls editTitle() which REPLACES the `.details__header-title`
 *      h1 with a `.details__header-title-input` input. So after
 *      clicking "+ entry", the h1 is GONE — the input is what you
 *      see. Pressing Enter on the input restores the h1 with the
 *      typed title. Pressing Escape deletes the entry.
 *
 *   2. GROUP create flow — list-view.ts:313
 *      Completely different path. createNewGroup() inserts the
 *      group into the tree, then emits 'edit-group' which makes
 *      app-view swap the right panel to GrpView. GrpView uses a
 *      `.grp` container with `#grp__field-title` input (NOT the
 *      details.hbs h1). The input's `input` event fires on every
 *      keystroke → setName(). Empty value with isJustCreated
 *      triggers removeWithoutHistory() — so the title must never
 *      be cleared during typing or the group is destroyed.
 *      No Enter-to-commit; the group is committed on every input.
 *      Click `.back-button` to return to list view.
 *
 *   3. Dropdown items — dropdown-view.ts + dropdown.hbs
 *      `.dropdown__item[data-value=entry|group]` is correct; the
 *      dropdown-view.ts `itemClick` reads data-value and emits
 *      select, which list-search-view.ts createDropdownSelect
 *      translates to create-entry / create-group events.
 */

const SCREENSHOT_DIR = 'e2e/screenshots';

async function openDemoDatabase(page: Page): Promise<void> {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.locator('#open__icon-demo').click();
    await page.waitForSelector('.list__item', { timeout: 20_000 });
}

async function openCreateDropdown(page: Page): Promise<void> {
    // Click the "+" button in the list search header. It opens a
    // dropdown with "new entry" / "new group" options (and any
    // pinned templates from the database).
    await page.locator('.list__search-btn-new').click();
    await expect(page.locator('.dropdown')).toBeVisible({ timeout: 5_000 });
}

test.describe('Entry + group CRUD', () => {
    test('CREATE: new entry appears in list + details opens with editable title input', async ({
        page
    }) => {
        await openDemoDatabase(page);

        const initialCount = await page.locator('.list__item').count();
        expect(initialCount).toBeGreaterThan(0);

        await openCreateDropdown(page);
        await page.locator('.dropdown__item[data-value="entry"]').click();

        // List count increases by one
        await expect(page.locator('.list__item')).toHaveCount(initialCount + 1, {
            timeout: 10_000
        });

        // Details view opens. Because `isJustCreated && !title`, the
        // editTitle() code path runs and the h1 is replaced by an
        // input — so assert on the INPUT, not the h1.
        await expect(page.locator('.details')).toBeVisible();
        const titleInput = page.locator('.details__header-title-input');
        await expect(titleInput).toBeVisible({ timeout: 5_000 });

        // Fill + Enter commits the title. setTitle() then replaces
        // the input back with the h1 bearing the new text.
        const newTitle = `E2E CRUD test entry ${Date.now()}`;
        await titleInput.fill(newTitle);
        await titleInput.press('Enter');

        const titleEl = page.locator('.details__header-title');
        await expect(titleEl).toBeVisible({ timeout: 5_000 });
        await expect(titleEl).toContainText(newTitle);

        // And the list row for the new entry should show that title
        await expect(
            page.locator('.list__item').filter({ hasText: newTitle })
        ).toBeVisible({ timeout: 5_000 });

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/crud-01-create-entry.png`,
            fullPage: true
        });
    });

    test('CREATE: new group opens grp view and accepts a name', async ({ page }) => {
        await openDemoDatabase(page);

        // `.menu__item-title` is the leaf title span per level (see
        // menu-item.hbs:16). Using `.menu__item` for hasText-style
        // filtering hits Playwright strict-mode because `.menu__item`
        // is structurally nested (parent "Demo" contains child groups)
        // and `hasText` matches substrings through children.
        const initialLeafCount = await page.locator('.menu__item-title').count();
        expect(initialLeafCount).toBeGreaterThan(0);

        await openCreateDropdown(page);
        await page.locator('.dropdown__item[data-value="group"]').click();

        // Group is created in the model first; app-view swaps panel
        // to GrpView. Assert on `.grp` + `#grp__field-title`.
        await expect(page.locator('.grp')).toBeVisible({ timeout: 5_000 });
        const nameInput = page.locator('#grp__field-title');
        await expect(nameInput).toBeVisible({ timeout: 5_000 });

        // Type the name. The `input` event commits on every keystroke,
        // so `fill` → single commit of the full string. Do NOT clear
        // first or empty-name-on-just-created will delete the group.
        const groupName = `E2E CRUD group ${Date.now()}`;
        await nameInput.fill(groupName);
        await expect(nameInput).toHaveValue(groupName);

        // Return to the entry list so the menu is re-rendered with
        // the new group's name visible.
        await page.locator('.back-button').click();

        // Leaf-title count has grown (a new group = a new leaf title)
        await expect(async () => {
            const newLeafCount = await page.locator('.menu__item-title').count();
            expect(newLeafCount).toBeGreaterThan(initialLeafCount);
        }).toPass({ timeout: 5_000 });

        // The group's leaf title should be findable in the menu.
        await expect(
            page.locator('.menu__item-title').filter({ hasText: groupName })
        ).toBeVisible({ timeout: 5_000 });

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/crud-02-create-group.png`,
            fullPage: true
        });
    });

    test('UPDATE: rename group via grp view (in-place, single session)', async ({ page }) => {
        await openDemoDatabase(page);

        // Create a group first (fresh demo db has no user-created
        // groups; renaming a built-in group could affect other tests).
        await openCreateDropdown(page);
        await page.locator('.dropdown__item[data-value="group"]').click();
        await expect(page.locator('.grp')).toBeVisible({ timeout: 5_000 });
        const nameInput = page.locator('#grp__field-title');
        await expect(nameInput).toBeVisible({ timeout: 5_000 });

        // First fill — this commits setName("Original...") via the
        // per-keystroke `input` handler. After _groupModified flips
        // isJustCreated=false, subsequent fills won't trigger the
        // "empty name + isJustCreated = delete" path.
        const originalName = `Original ${Date.now()}`;
        await nameInput.fill(originalName);
        await expect(nameInput).toHaveValue(originalName);

        // Second fill in the SAME grp view session — this is the
        // rename. No need to return to list and re-enter; `fill` on
        // a populated input clears + types, firing one input event
        // with the final value. The rename path exercised is
        // changeTitle → setName, same code path a user would take.
        const renamedName = `Renamed ${Date.now()}`;
        await nameInput.fill(renamedName);
        await expect(nameInput).toHaveValue(renamedName);

        // Return to the list and verify menu reflects the new name
        await page.locator('.back-button').click();
        await expect(
            page.locator('.menu__item-title').filter({ hasText: renamedName })
        ).toBeVisible({ timeout: 5_000 });
        // And the old name is gone from any leaf title
        await expect(
            page.locator('.menu__item-title').filter({ hasText: originalName })
        ).toHaveCount(0, { timeout: 5_000 });

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/crud-03-rename-group.png`,
            fullPage: true
        });
    });

    test('DELETE: move newly-created entry to trash + verify count decreases', async ({
        page
    }) => {
        await openDemoDatabase(page);

        // Create an entry specifically for deletion so we don't
        // reduce the demo entry count and affect other tests.
        await openCreateDropdown(page);
        await page.locator('.dropdown__item[data-value="entry"]').click();

        const titleInput = page.locator('.details__header-title-input');
        await expect(titleInput).toBeVisible({ timeout: 5_000 });

        const throwawayTitle = `Delete me ${Date.now()}`;
        await titleInput.fill(throwawayTitle);
        await titleInput.press('Enter');

        const titleEl = page.locator('.details__header-title');
        await expect(titleEl).toContainText(throwawayTitle);

        const countBeforeDelete = await page.locator('.list__item').count();

        // Delete via the trash button in details header buttons row
        const trashBtn = page.locator('.details__buttons-trash');
        await expect(trashBtn).toBeVisible();
        await trashBtn.click();

        // Count in the current view drops by one (entry moved to Trash)
        await expect(async () => {
            const afterCount = await page.locator('.list__item').count();
            expect(afterCount).toBe(countBeforeDelete - 1);
        }).toPass({ timeout: 5_000 });

        // The trashed entry is no longer visible in the current list
        await expect(
            page.locator('.list__item').filter({ hasText: throwawayTitle })
        ).toHaveCount(0);

        // It should now be in the Trash / Recycle Bin menu item
        const trashMenuItem = page
            .locator('.menu__item')
            .filter({ hasText: /trash/i })
            .first();
        await expect(trashMenuItem).toBeVisible();
        await trashMenuItem.click();
        await expect(
            page.locator('.list__item').filter({ hasText: throwawayTitle })
        ).toBeVisible({ timeout: 5_000 });

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/crud-04-delete-entry.png`,
            fullPage: true
        });
    });

    test('DELETE: group via grp trash button removes it from menu', async ({ page }) => {
        await openDemoDatabase(page);

        // Create a group and fill name in-place. Stay in grp view
        // so we can hit `.grp__buttons-trash` without navigating away.
        await openCreateDropdown(page);
        await page.locator('.dropdown__item[data-value="group"]').click();
        await expect(page.locator('.grp')).toBeVisible({ timeout: 5_000 });
        const nameInput = page.locator('#grp__field-title');
        await expect(nameInput).toBeVisible({ timeout: 5_000 });
        const groupName = `DoomedGroup ${Date.now()}`;
        await nameInput.fill(groupName);
        await expect(nameInput).toHaveValue(groupName);

        // Move the group to trash via grp__buttons-trash
        // (grp-view.ts moveToTrash handler, line 114). No need to
        // return to list and re-enter — we're already on grp view.
        const trashBtn = page.locator('.grp__buttons-trash');
        await expect(trashBtn).toBeVisible();
        await trashBtn.click();

        // After deletion, app-view returns to entry list and the
        // group's leaf title is gone from the menu.
        await expect(
            page.locator('.menu__item-title').filter({ hasText: groupName })
        ).toHaveCount(0, { timeout: 5_000 });

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/crud-05-delete-group.png`,
            fullPage: true
        });
    });
});
