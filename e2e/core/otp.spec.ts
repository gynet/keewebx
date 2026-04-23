import { test, expect, Page } from '@playwright/test';

const SCREENSHOT_DIR = 'e2e/screenshots';

/**
 * OTP / TOTP end-to-end tests.
 *
 * These exercise the full TOTP lifecycle in the browser:
 *   1. Open the demo database (password 'demo')
 *   2. Select an entry
 *   3. Use the "more…" menu to add a One-time codes field
 *   4. Enter a raw base32 secret manually (skipping QR / file path)
 *   5. Verify the rendered field shows a 6-digit TOTP code
 *
 * The secret 'JBSWY3DPEHPK3PXP' is the classic RFC 4648 test vector
 * ("Hello!\xde\xad\xbe\xef" base32-encoded); it's widely used in TOTP
 * test suites and produces deterministic output given the current time.
 *
 * Regression coverage: this exercises entry-model.setOtpUrl,
 * FieldViewOtp render/tick loop, Otp.fromBase32, Otp.next (HMAC-SHA1),
 * and the dropdown / modal / field-view event wiring end-to-end.
 */

const DEMO_OTP_SECRET = 'JBSWY3DPEHPK3PXP';

async function openDemoDatabase(page: Page) {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const demoBtn = page.locator('#open__icon-demo');
    await expect(demoBtn).toBeVisible({ timeout: 15_000 });
    await demoBtn.click();
    const listItems = page.locator('.list__item');
    await expect(listItems.first()).toBeVisible({ timeout: 30_000 });
    return listItems;
}

async function selectFirstEntry(page: Page) {
    const firstItem = page.locator('.list__item').first();
    await firstItem.click();
    const detailsView = page.locator('.details');
    await expect(detailsView).toBeVisible({ timeout: 10_000 });
    return detailsView;
}

async function openMoreOptionsDropdown(page: Page) {
    // The "more..." pseudo-field sits at the bottom of the field list.
    // Clicking its label triggers the moreOptions dropdown.
    // It is the last .details__field-label with text matching 'more' (Locale.detMore).
    const moreLabel = page
        .locator('.details__field-label')
        .filter({ hasText: /^more/i })
        .last();
    await expect(moreLabel).toBeVisible({ timeout: 5_000 });
    await moreLabel.click();

    const dropdown = page.locator('.dropdown');
    await expect(dropdown).toBeVisible({ timeout: 5_000 });
    return dropdown;
}

test.describe('OTP / TOTP', () => {
    test('add TOTP secret to entry and verify a 6-digit code renders', async ({ page }) => {
        await openDemoDatabase(page);
        await selectFirstEntry(page);

        // Open the "more..." dropdown
        const dropdown = await openMoreOptionsDropdown(page);

        // Click the "One-time codes" item (data-value="otp")
        const otpMenuItem = dropdown.locator('.dropdown__item[data-value="otp"]');
        await expect(otpMenuItem).toBeVisible({ timeout: 5_000 });
        await otpMenuItem.click();

        // An alert modal appears prompting to scan a QR code or enter manually.
        // Click the "Enter code manually" button (data-result="manually").
        const manualBtn = page.locator('.modal__buttons button[data-result="manually"]');
        await expect(manualBtn).toBeVisible({ timeout: 5_000 });
        await manualBtn.click();

        // A new editable OTP field is created and auto-focused. It is a custom
        // field with title "otp" (raw field key before TOTP parsing). Find the
        // currently-focused input inside .details__field-value.
        const otpInput = page.locator('.details__field input:focus, .details__field textarea:focus').first();
        await expect(otpInput).toBeVisible({ timeout: 5_000 });

        // Type the base32 secret. On blur/Enter this gets converted to an
        // otpauth:// URL, stored in the entry, and re-rendered as a FieldViewOtp.
        await otpInput.fill(DEMO_OTP_SECRET);
        await otpInput.press('Enter');

        // After commit, the field re-renders as a TOTP field with label
        // matching Locale.detOtpField ("One-time code"). The value is the
        // generated 6-digit code.
        const otpFieldLabel = page
            .locator('.details__field-label')
            .filter({ hasText: /^one-time code$/i })
            .first();
        await expect(otpFieldLabel).toBeVisible({ timeout: 10_000 });

        // The field value element should contain a 6-digit code (possibly
        // with a space in the middle, e.g. "123 456" — KeeWeb formats for
        // readability). We accept 6-8 digits with optional whitespace.
        const otpField = otpFieldLabel.locator('xpath=..');
        const otpValueEl = otpField.locator('.details__field-value');

        // Wait for the OTP generator to produce a code (generation is async).
        await expect(async () => {
            const text = (await otpValueEl.textContent()) ?? '';
            const stripped = text.replace(/\s+/g, '');
            expect(stripped).toMatch(/^\d{6,8}$/);
        }).toPass({ timeout: 10_000 });

        const finalText = (await otpValueEl.textContent()) ?? '';
        const digits = finalText.replace(/\s+/g, '');
        expect(digits.length).toBeGreaterThanOrEqual(6);
        expect(digits.length).toBeLessThanOrEqual(8);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/otp-field-rendered.png`,
            fullPage: true,
        });
    });

    test('TOTP code updates over time (generator tick)', async ({ page }) => {
        await openDemoDatabase(page);
        await selectFirstEntry(page);

        // Set up an OTP field as in the previous test.
        const dropdown = await openMoreOptionsDropdown(page);
        await dropdown.locator('.dropdown__item[data-value="otp"]').click();
        await page.locator('.modal__buttons button[data-result="manually"]').click();
        const otpInput = page
            .locator('.details__field input:focus, .details__field textarea:focus')
            .first();
        await expect(otpInput).toBeVisible({ timeout: 5_000 });
        await otpInput.fill(DEMO_OTP_SECRET);
        await otpInput.press('Enter');

        // Wait for the first code to appear.
        const otpFieldLabel = page
            .locator('.details__field-label')
            .filter({ hasText: /^one-time code$/i })
            .first();
        await expect(otpFieldLabel).toBeVisible({ timeout: 10_000 });
        const otpField = otpFieldLabel.locator('xpath=..');
        const otpValueEl = otpField.locator('.details__field-value');

        let firstCode = '';
        await expect(async () => {
            const text = (await otpValueEl.textContent()) ?? '';
            firstCode = text.replace(/\s+/g, '');
            expect(firstCode).toMatch(/^\d{6,8}$/);
        }).toPass({ timeout: 10_000 });

        // The tick interval redraws every 300ms to fade the field near expiry.
        // We don't assert the code changes (a 30-second TOTP window rarely
        // rolls during a 2-second wait), but we verify the field stays valid
        // and the tick loop doesn't crash the OTP view.
        await page.waitForTimeout(1500);

        const secondText = (await otpValueEl.textContent()) ?? '';
        const secondCode = secondText.replace(/\s+/g, '');
        expect(secondCode).toMatch(/^\d{6,8}$/);

        // After 1.5s the code is almost certainly the same (same 30s window),
        // but must still be a valid TOTP code — proves the render loop survives.
        expect(secondCode.length).toBe(firstCode.length);
    });
});
