import { test, expect, Page } from '@playwright/test';

const SCREENSHOT_DIR = 'e2e/screenshots';

/** Native clipboard copy, including protected passwords and a live TOTP code.
 * The current demo's AWS Console entry has no OTP; the OTP case adds one via UI.
 * No spy fallback: a rejected or empty native read must fail the test.
 */
const DEMO_ENTRY_TITLE = 'AWS Console';
const DEMO_USER = 'iam-demouser';
const DEMO_PASSWORD = 'aws.demo.K3y!';
const DEMO_OTP_SECRET = 'JBSWY3DPEHPK3PXP';

async function openDemoDatabase(page: Page) {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const demoBtn = page.locator('#open__icon-demo');
    await expect(demoBtn).toBeVisible({ timeout: 15_000 });
    await demoBtn.click();
    const listItems = page.locator('.list__item');
    await expect(listItems.first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => navigator.clipboard.writeText(''));
    return listItems;
}

// Select by exact title so row usernames cannot affect the match.
async function selectEntryByTitle(page: Page, title: string) {
    // List items concatenate the entry title and the visible UserName,
    // so e.g. the "Sample Entry" item contains text "Sample EntryUser Name".
    // Match the title element directly instead of the whole row to avoid
    // collisions ("Sample Entry" vs "Sample Entry #2").
    const titleEl = page
        .locator('.list__item .list__item-title')
        .filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
        .first();
    await expect(titleEl).toBeVisible({ timeout: 10_000 });
    await titleEl.click();
    const detailsHeading = page.locator('.details__header-title').first();
    await expect(detailsHeading).toHaveText(title, { timeout: 5_000 });
}

/**
 * Locate a field's label inside the currently rendered details view.
 * Field labels are localized via `StringFormat.capFirst(loc.user)` etc.;
 * for the en-US default this yields "User", "Password", "One-time code".
 * We use a case-insensitive exact-text match anchored to the start of
 * the label so "Password" doesn't accidentally match "Password (auto)".
 */
function fieldLabel(page: Page, label: RegExp) {
    return page
        .locator('.details__field-label')
        .filter({ hasText: label })
        .first();
}

async function readClipboard(page: Page): Promise<string> {
    return page.evaluate(() => navigator.clipboard.readText());
}

test.describe('Clipboard copy', () => {
    // Permission name strings are Chromium-only; firefox has no equivalent
    // Native readback has no portable Playwright permission grant on Firefox.
    test.skip(
        ({ browserName }) => browserName !== 'chromium',
        'clipboard-read/write permissions are chromium-only'
    );

    test('copy username writes the entry UserName to the clipboard', async ({ page }) => {
        await openDemoDatabase(page);
        await selectEntryByTitle(page, DEMO_ENTRY_TITLE);

        const userLabel = fieldLabel(page, /^user$/i);
        await expect(userLabel).toBeVisible({ timeout: 5_000 });
        await userLabel.click();

        await expect
            .poll(async () => await readClipboard(page), { timeout: 5_000 })
            .toBe(DEMO_USER);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/clipboard-username.png`,
            fullPage: true,
        });
    });

    test('copy password decrypts ProtectedValue and writes to the clipboard', async ({
        page,
    }) => {
        await openDemoDatabase(page);
        await selectEntryByTitle(page, DEMO_ENTRY_TITLE);

        const passLabel = fieldLabel(page, /^password$/i);
        await expect(passLabel).toBeVisible({ timeout: 5_000 });
        await passLabel.click();

        // The decryption happens inside FieldView.getTextValue via
        // model.password.getText() — if it ever regresses we'll see
        // raw bytes or an empty string here.
        await expect
            .poll(async () => await readClipboard(page), { timeout: 5_000 })
            .toBe(DEMO_PASSWORD);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/clipboard-password.png`,
            fullPage: true,
        });
    });

    test('copy OTP writes a 6-digit TOTP code to the clipboard', async ({ page }) => {
        test.setTimeout(45_000);

        await openDemoDatabase(page);
        await selectEntryByTitle(page, DEMO_ENTRY_TITLE);

        // Add a TOTP secret to the entry first (mirrors otp.spec.ts pattern).
        const moreLabel = page
            .locator('.details__field-label')
            .filter({ hasText: /^more/i })
            .last();
        await expect(moreLabel).toBeVisible({ timeout: 5_000 });
        await moreLabel.click();

        const dropdown = page.locator('.dropdown');
        await expect(dropdown).toBeVisible({ timeout: 5_000 });
        await dropdown.locator('.dropdown__item[data-value="otp"]').click();

        const manualBtn = page.locator('.modal__buttons button[data-result="manually"]');
        await expect(manualBtn).toBeVisible({ timeout: 5_000 });
        await manualBtn.click();

        const otpInput = page
            .locator('.details__field input:focus, .details__field textarea:focus')
            .first();
        await expect(otpInput).toBeVisible({ timeout: 5_000 });
        await otpInput.fill(DEMO_OTP_SECRET);
        await otpInput.press('Enter');

        // Wait for the field to re-render as a "One-time code" field with a
        // numeric value before we try to copy it.
        const otpFieldLabel = page
            .locator('.details__field-label')
            .filter({ hasText: /^one-time code$/i })
            .first();
        await expect(otpFieldLabel).toBeVisible({ timeout: 10_000 });
        const otpField = otpFieldLabel.locator('xpath=..');
        const otpValueEl = otpField.locator('.details__field-value');

        // Wait for the generator to produce a code.
        let displayed = '';
        await expect(async () => {
            const text = (await otpValueEl.textContent()) ?? '';
            displayed = text.replace(/\s+/g, '');
            expect(displayed).toMatch(/^\d{6,8}$/);
        }).toPass({ timeout: 15_000 });

        // Click the label to trigger the copy. The OTP field's getTextValue
        // returns the live numeric code, which is what gets written.
        await otpFieldLabel.click();

        const result = await (async () => {
            // Poll until we see a numeric code on the clipboard. Don't
            // require it to equal `displayed` byte-for-byte: the copy
            // path strips formatting (e.g. the "123 456" mid-space) so
            // we re-strip both sides before comparing.
            let value = '';
            await expect
                .poll(
                    async () => {
                        const r = await readClipboard(page);
                        value = r.replace(/\s+/g, '');
                        return value;
                    },
                    { timeout: 5_000 }
                )
                .toMatch(/^\d{6,8}$/);
            return value;
        })();

        // Sanity: the copied code should equal what was on screen at copy
        // time (ignoring whitespace). Both share the same TOTP generator
        // and 30-second window, so they must agree.
        expect(result).toBe(displayed);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/clipboard-otp.png`,
            fullPage: true,
        });
    });
});
