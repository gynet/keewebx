import { test, expect, Page } from '@playwright/test';

/**
 * Entry UPDATE — non-title fields.
 *
 * Covers CRUD update gaps identified in issue #40:
 *   - Edit username (FieldViewAutocomplete → <input>)
 *   - Edit website/URL (FieldViewUrl → <input>)
 *   - Edit notes (FieldViewText multiline → <textarea>)
 *   - Edit tags (FieldViewTags → comma-separated <input>)
 *
 * All tests use the demo database and select an existing entry
 * ("Demo Bank") rather than creating new ones.
 *
 * How field editing works (from source analysis):
 *   - Click `.details__field-value` → FieldView.fieldValueClick()
 *     → FieldView.edit() → subclass.startEdit()
 *   - startEdit() creates an <input> (or <textarea> for multiline)
 *     INSIDE `.details__field-value`, then focuses it.
 *   - Pressing Enter (single-line) or clicking outside (blur)
 *     commits the edit via endEdit(newVal).
 *   - After endEdit, the input is removed and replaced by the
 *     rendered HTML value.
 *
 * Field identification:
 *   - Fields are `.details__field` divs with a `.details__field-label`
 *     (text: "User", "Password", "Website", "Notes", "Tags") and a
 *     `.details__field-value` (the clickable/editable area).
 */

const SCREENSHOT_DIR = 'e2e/screenshots';

async function openDemoDatabase(page: Page): Promise<void> {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.locator('#open__icon-demo').click();
    await page.waitForSelector('.list__item', { timeout: 20_000 });
}

/**
 * Select a specific entry by its title text in the list.
 */
async function selectEntry(page: Page, entryTitle: string): Promise<void> {
    const entry = page.locator('.list__item').filter({ hasText: entryTitle }).first();
    await expect(entry).toBeVisible({ timeout: 5_000 });
    await entry.click();
    await expect(page.locator('.details')).toBeVisible({ timeout: 10_000 });
    // Wait for the details header to show the correct title
    await expect(page.locator('.details__header-title')).toContainText(entryTitle, {
        timeout: 5_000
    });
}

/**
 * Find a field by its label text, click its value to start editing,
 * fill the new value, and commit via Enter (single-line) or blur
 * (multiline). Returns the field container element locator.
 */
async function editFieldByLabel(
    page: Page,
    labelText: string,
    newValue: string,
    options: { multiline?: boolean } = {}
): Promise<ReturnType<Page['locator']>> {
    // Find the field container whose label matches
    const fieldContainer = page
        .locator('.details__field')
        .filter({ has: page.locator('.details__field-label', { hasText: labelText }) })
        .first();
    await expect(fieldContainer).toBeVisible({ timeout: 5_000 });

    // Click the field value area to trigger edit mode
    const fieldValue = fieldContainer.locator('.details__field-value');
    await fieldValue.click();

    // Wait for the edit class to appear on the container
    await expect(fieldContainer).toHaveClass(/details__field--edit/, { timeout: 5_000 });

    // Find the input or textarea that startEdit() created inside the value area
    const inputSelector = options.multiline ? 'textarea' : 'input';
    const inputEl = fieldValue.locator(inputSelector);
    await expect(inputEl).toBeVisible({ timeout: 5_000 });
    await expect(inputEl).toBeFocused({ timeout: 2_000 });

    // Clear and type the new value
    await inputEl.fill(newValue);

    if (options.multiline) {
        // For multiline fields (notes), blur to commit by clicking
        // somewhere neutral. The fieldValueBlur handler in
        // FieldViewText calls endEdit(this.input.val()).
        // We click the details header which is outside the field.
        await page.locator('.details__header-title').click();
    } else {
        // For single-line fields, press Enter to commit
        await inputEl.press('Enter');
    }

    // Wait for edit mode to end. The active-editing class is
    // `details__field--edit` (added by FieldView.edit(), removed
    // by FieldView.endEdit()). Use word-boundary regex to avoid
    // false-matching `details__field--editable` (the static class).
    await expect(fieldContainer).not.toHaveClass(/details__field--edit\b/, { timeout: 5_000 });

    return fieldContainer;
}

test.describe('Entry UPDATE — non-title fields', () => {
    test('edit username field on existing entry', async ({ page }) => {
        await openDemoDatabase(page);
        await selectEntry(page, 'Demo Bank');

        const newUsername = `testuser-${Date.now()}`;
        const field = await editFieldByLabel(page, 'User', newUsername);

        // Verify the field value now shows the new username
        const fieldValue = field.locator('.details__field-value');
        await expect(fieldValue).toContainText(newUsername, { timeout: 5_000 });

        // Verify it also updated in the list sidebar (list items show
        // description which includes the username for some entries)
        // Just verify the field value is correct — list update is
        // an implementation detail that may vary by entry type.

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/entry-update-01-username.png`,
            fullPage: true
        });
    });

    test('edit website/URL field on existing entry', async ({ page }) => {
        await openDemoDatabase(page);
        await selectEntry(page, 'Demo Bank');

        const newUrl = `https://e2e-test-${Date.now()}.example.com`;
        const field = await editFieldByLabel(page, 'Website', newUrl);

        // After edit, FieldViewUrl renders the value as an <a> link.
        // The display strips "https://" prefix, so check for the
        // domain part.
        const fieldValue = field.locator('.details__field-value');
        const link = fieldValue.locator('a');
        await expect(link).toBeVisible({ timeout: 5_000 });
        await expect(link).toHaveAttribute('href', newUrl);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/entry-update-02-website.png`,
            fullPage: true
        });
    });

    test('edit notes field on existing entry (multiline)', async ({ page }) => {
        await openDemoDatabase(page);
        await selectEntry(page, 'Demo Bank');

        const newNotes = `E2E test notes added at ${new Date().toISOString()}`;
        const field = await editFieldByLabel(page, 'Notes', newNotes, { multiline: true });

        // Verify the field value contains the new notes text
        const fieldValue = field.locator('.details__field-value');
        await expect(fieldValue).toContainText(newNotes, { timeout: 5_000 });

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/entry-update-03-notes.png`,
            fullPage: true
        });
    });

    test('edit tags field on existing entry', async ({ page }) => {
        await openDemoDatabase(page);
        await selectEntry(page, 'Demo Bank');

        // Tags field uses FieldViewTags which extends FieldViewText.
        // It renders comma-separated tags. Editing creates an <input>
        // (not textarea — multiline is not set on the tags field model).
        // Type a tag, commit with Enter. The valueToTags() parser
        // splits on semicolons, commas, or colons.
        const tagName = `e2e-tag-${Date.now()}`;
        const field = await editFieldByLabel(page, 'Tags', tagName);

        // After edit, the tags field renders as comma-separated text.
        const fieldValue = field.locator('.details__field-value');
        await expect(fieldValue).toContainText(tagName, { timeout: 5_000 });

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/entry-update-04-tags.png`,
            fullPage: true
        });
    });
});
