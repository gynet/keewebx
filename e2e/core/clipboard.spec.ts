import { test, expect, Page } from '@playwright/test';

const SCREENSHOT_DIR = 'e2e/screenshots';

/**
 * Clipboard copy E2E (issue #29).
 *
 * Strategy
 * --------
 *  1. Grant clipboard-read / clipboard-write permissions in
 *     `playwright.config.ts` so the Chromium-backed `navigator.clipboard.*`
 *     calls in `comp/browser/copy-paste.ts` succeed without prompts.
 *  2. After triggering a copy, read the clipboard back via
 *     `page.evaluate(() => navigator.clipboard.readText())`.
 *  3. Fallback (CI environments that block the clipboard entirely): we
 *     instrument `navigator.clipboard.writeText` from a Playwright init
 *     script BEFORE the app boots, recording the last value passed to it
 *     on `window.__lastClipboardWrite`. If `readText()` returns empty we
 *     assert against the spy instead. Either path proves the copy
 *     handler ran with the right value.
 *
 * What we exercise (real handlers, no mocks)
 * ------------------------------------------
 *  - `DetailsView.copyUserName` -> `FieldView.copyValue` ->
 *    `CopyPaste.copy` -> `navigator.clipboard.writeText` (or
 *    `document.execCommand` fallback).
 *  - The same path for `$Password` (which is a decrypted
 *    `kdbxweb.ProtectedValue`) and the OTP field (live TOTP code).
 *
 * Demo database content (see `packages/core/scripts/create-demo-db.ts`):
 *  - First entry "Sample Entry": UserName "User Name", Password "Password".
 *
 * The clipboard tests are gated to chromium because the
 * `clipboard-read` / `clipboard-write` permission names in
 * `BrowserContext.grantPermissions` are Chromium-only. On firefox
 * `navigator.clipboard.readText` rejects with NotAllowedError, which
 * would force every test into the fallback path even when the user
 * hasn't blocked the clipboard.
 */

const DEMO_OTP_SECRET = 'JBSWY3DPEHPK3PXP';

async function installClipboardSpy(page: Page): Promise<void> {
    // Runs in *every* document loaded by the page, before any other script.
    // We wrap navigator.clipboard.writeText so we can recover the last
    // copied value even if readText is blocked.
    await page.addInitScript(() => {
        const w = window as unknown as {
            __lastClipboardWrite?: string;
            __clipboardWrites?: string[];
        };
        w.__lastClipboardWrite = undefined;
        w.__clipboardWrites = [];
        try {
            const clip = navigator.clipboard;
            if (clip && typeof clip.writeText === 'function') {
                const orig = clip.writeText.bind(clip);
                clip.writeText = (text: string) => {
                    w.__lastClipboardWrite = text;
                    (w.__clipboardWrites as string[]).push(text);
                    return orig(text);
                };
            }
        } catch {
            /* ignore — we still try the readText path */
        }
    });
}

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

/**
 * Click an entry by exact title in the entry list. The demo DB lists
 * entries alphabetically, so blindly grabbing `.list__item:first` lands
 * on "Demo Bank", not the "Sample Entry" we want for known
 * UserName/Password values. `packages/core/scripts/create-demo-db.ts`
 * is the source of truth for entry contents.
 */
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

/**
 * Read the clipboard with a fallback to the writeText spy.
 * Returns the resolved string and the source used so the test can
 * report which path it took if it ever flakes.
 */
async function readClipboard(
    page: Page
): Promise<{ value: string; source: 'navigator' | 'spy' | 'none' }> {
    // Primary: navigator.clipboard.readText (gated by clipboard-read perm).
    const direct = await page
        .evaluate(async () => {
            try {
                return await navigator.clipboard.readText();
            } catch {
                return null;
            }
        })
        .catch(() => null);
    if (direct && direct.length > 0) {
        return { value: direct, source: 'navigator' };
    }
    // Fallback: spy installed via addInitScript before navigation.
    const spied = await page.evaluate(() => {
        const w = window as unknown as { __lastClipboardWrite?: string };
        return w.__lastClipboardWrite ?? null;
    });
    if (spied && spied.length > 0) {
        return { value: spied, source: 'spy' };
    }
    return { value: '', source: 'none' };
}

test.describe('Clipboard copy', () => {
    // Permission name strings are Chromium-only; firefox has no equivalent
    // and would always fall through to the spy path, which would mask real
    // regressions in the navigator.clipboard code path.
    test.skip(
        ({ browserName }) => browserName !== 'chromium',
        'clipboard-read/write permissions are chromium-only'
    );

    test.beforeEach(async ({ page }) => {
        await installClipboardSpy(page);
    });

    test('copy username writes the entry UserName to the clipboard', async ({ page }) => {
        await openDemoDatabase(page);
        // "Sample Entry" has the canonical literal UserName "User Name"
        // (see packages/core/scripts/create-demo-db.ts).
        await selectEntryByTitle(page, 'Sample Entry');

        const userLabel = fieldLabel(page, /^user$/i);
        await expect(userLabel).toBeVisible({ timeout: 5_000 });
        await userLabel.click();

        await expect
            .poll(async () => (await readClipboard(page)).value, { timeout: 5_000 })
            .toBe('User Name');

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/clipboard-username.png`,
            fullPage: true,
        });
    });

    test('copy password decrypts ProtectedValue and writes to the clipboard', async ({
        page,
    }) => {
        await openDemoDatabase(page);
        // "Sample Entry" Password is ProtectedValue("Password").
        await selectEntryByTitle(page, 'Sample Entry');

        const passLabel = fieldLabel(page, /^password$/i);
        await expect(passLabel).toBeVisible({ timeout: 5_000 });
        await passLabel.click();

        // The decryption happens inside FieldView.getTextValue via
        // model.password.getText() — if it ever regresses we'll see
        // raw bytes or an empty string here.
        await expect
            .poll(async () => (await readClipboard(page)).value, { timeout: 5_000 })
            .toBe('Password');

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/clipboard-password.png`,
            fullPage: true,
        });
    });

    test('copy OTP writes a 6-digit TOTP code to the clipboard', async ({ page }) => {
        test.setTimeout(45_000);

        await openDemoDatabase(page);
        await selectEntryByTitle(page, 'Sample Entry');

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
                        value = r.value.replace(/\s+/g, '');
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
