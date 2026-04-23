import { test, expect, Page } from '@playwright/test';
import path from 'path';

/**
 * KDBX4 import via fileChooser E2E (issue #30).
 *
 * Reviewer guidance from #4: never interact with the native OS file
 * dialog. Always go through Playwright's `fileChooser` event, and
 * register the promise BEFORE the click that opens the chooser, so the
 * synthetic-event listener is wired up before the renderer dispatches.
 *
 * Test matrix:
 *  - Valid KDBX4 (KDBX4.1.kdbx, password "test") -> entries loaded,
 *    group tree visible.
 *  - Wrong password -> input flagged, app state unchanged (still on
 *    open screen, no entry list rendered).
 *  - Corrupted file -> graceful error, no crash, the open screen stays
 *    visible and no `console.error: Uncaught` rolls past Playwright.
 *
 * Fixtures:
 *  - Real KDBX4: `packages/db/resources/KDBX4.1.kdbx` (already used by
 *    `database-open.spec.ts`). Reusing it avoids generating new files.
 *  - Corrupted: synthesized in-test by handing the file chooser a
 *    `setFiles({ buffer })` payload of garbage bytes. Nothing to commit.
 *
 * The "open" path goes through `OpenView.openFile` which dispatches a
 * "local file" warning modal before showing the password prompt. Each
 * test dismisses that modal explicitly.
 */

const SCREENSHOT_DIR = 'e2e/screenshots';

const KDBX4_FILE = path.resolve(
    __dirname,
    '../../packages/db/resources/KDBX4.1.kdbx'
);
const KDBX4_PASSWORD = 'test';

/**
 * Open the local-file via Open button + chooser, dismiss the modal,
 * and return once the password input is editable. Mirrors the helper
 * in database-open.spec.ts so behaviour stays consistent.
 *
 * Accepts either a filesystem path (real fixture) or an in-memory file
 * payload (used by the corrupted-file test).
 */
async function openFileViaChooser(
    page: Page,
    file:
        | string
        | { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('#open__icon-open').click();
    const fileChooser = await fileChooserPromise;
    if (typeof file === 'string') {
        await fileChooser.setFiles(file);
    } else {
        await fileChooser.setFiles(file);
    }

    // The "Local file" warning modal appears with an entrance animation.
    // Wait for it to settle before clicking OK.
    const modal = page.locator('.modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    const okButton = page.locator('.modal__buttons button[data-result="ok"]');
    await expect(okButton).toBeVisible({ timeout: 5_000 });
    await modal.evaluate((el) => {
        return new Promise<void>((resolve) => {
            const animations = el.getAnimations({ subtree: true });
            if (animations.length === 0) return resolve();
            Promise.all(animations.map((a) => a.finished)).then(() => resolve());
        });
    });
    await okButton.click();
}

/**
 * After the chooser + modal handshake, the password input becomes
 * non-readonly. Returns it once it's editable.
 */
async function waitForPasswordInput(page: Page) {
    const passwordInput = page.locator('.open__pass-input');
    await expect(passwordInput).not.toHaveAttribute('readonly', '', { timeout: 10_000 });
    return passwordInput;
}

test.describe('Import KDBX4 file via fileChooser', () => {
    test('imports a valid KDBX4 file with correct password', async ({ page }) => {
        test.setTimeout(45_000);

        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });

        await openFileViaChooser(page, KDBX4_FILE);

        const passwordInput = await waitForPasswordInput(page);
        await passwordInput.fill(KDBX4_PASSWORD);
        await page.locator('.open__pass-enter-btn').click();

        // Wait for entry list to populate -> proves decrypt + parse worked.
        const listItems = page.locator('.list__item');
        await expect(listItems.first()).toBeVisible({ timeout: 30_000 });
        const count = await listItems.count();
        expect(count).toBeGreaterThan(0);

        // Group tree (sidebar) should also have rendered. The default group
        // becomes the root menu item with `.menu__item--default` (or at least
        // a visible `.menu__item` once the file mounts).
        const menuItems = page.locator('.menu__item');
        await expect(menuItems.first()).toBeVisible({ timeout: 5_000 });
        const menuCount = await menuItems.count();
        expect(menuCount).toBeGreaterThan(0);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/import-01-valid.png`,
            fullPage: true,
        });
    });

    test('rejects KDBX4 import with wrong password and leaves state unchanged', async ({
        page,
    }) => {
        test.setTimeout(45_000);

        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });

        await openFileViaChooser(page, KDBX4_FILE);

        const passwordInput = await waitForPasswordInput(page);
        await passwordInput.fill('definitely-not-the-password');
        await page.locator('.open__pass-enter-btn').click();

        // The input gets the .input--error class on auth failure (the
        // existing wrong-password test in database-open.spec.ts uses
        // exactly this assertion). KDBX4.1.kdbx uses AES-KDF 60K rounds
        // which derives quickly even in CI.
        await expect(passwordInput).toHaveClass(/input--error/, { timeout: 30_000 });

        // App state must be unchanged: no list items rendered, the open
        // view (with the password input) is still visible.
        const listItems = page.locator('.list__item');
        await expect(listItems.first()).toHaveCount(0);
        await expect(passwordInput).toBeVisible();

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/import-02-wrong-password.png`,
            fullPage: true,
        });
    });

    test('handles a corrupted file gracefully without crashing', async ({ page }) => {
        test.setTimeout(45_000);

        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });

        // Capture any uncaught page errors. The KDBX parser should reject
        // the file via a thrown KdbxError that surfaces as a UI alert,
        // NOT as an unhandled exception in the page.
        const pageErrors: Error[] = [];
        page.on('pageerror', (err) => pageErrors.push(err));

        // Synthesise a file with random bytes that:
        //  - is not zero-length (the open path early-returns on empty)
        //  - has the wrong magic header so the very first kdbxweb sniff
        //    rejects it. Using a fixed seed for reproducibility.
        const garbage = Buffer.alloc(2048);
        for (let i = 0; i < garbage.length; i++) {
            garbage[i] = (i * 0x9e3779b1) & 0xff;
        }
        // Make sure the magic does NOT match the KeePass signature
        // (0x9AA2D903 / 0xB54BFB67).
        garbage[0] = 0x00;
        garbage[1] = 0x00;
        garbage[2] = 0x00;
        garbage[3] = 0x00;

        // The corrupted file is rejected by `kdbxweb`'s magic-byte sniff
        // INSIDE `OpenView.readFile`, BEFORE the "local file" warning
        // modal would be shown. So we feed the file chooser directly and
        // wait for the resulting alert modal — we cannot reuse
        // `openFileViaChooser` here, which assumes the local-file modal
        // path.
        const fileChooserPromise = page.waitForEvent('filechooser');
        await page.locator('#open__icon-open').click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles({
            name: 'corrupted.kdbx',
            mimeType: 'application/octet-stream',
            buffer: garbage,
        });

        // An `alerts.error()` modal appears with title "Bad file" and a
        // single OK button. The Alerts.buttons.ok definition in
        // `comp/ui/alerts.ts` uses `result: 'yes'`, so the rendered
        // button has `data-result="yes"` (NOT "ok" — that's the local
        // file warning modal in `OpenView`).
        const errorModal = page.locator('.modal');
        await expect(errorModal).toBeVisible({ timeout: 10_000 });
        const okButton = page
            .locator('.modal__buttons button[data-result="yes"]')
            .first();
        await expect(okButton).toBeVisible({ timeout: 5_000 });

        // Dismiss it and confirm we're back on the open screen with no
        // partial state.
        await okButton.click();
        await expect(errorModal).toBeHidden({ timeout: 5_000 });

        const listItems = page.locator('.list__item');
        await expect(listItems.first()).toHaveCount(0);
        await expect(page.locator('#open__icon-open')).toBeVisible();

        // The parser must have rejected via a structured error, NOT an
        // uncaught exception in the page.
        if (pageErrors.length > 0) {
            throw new Error(
                'Corrupted-file import surfaced uncaught page errors:\n' +
                    pageErrors.map((e) => `  - ${e.message}`).join('\n')
            );
        }

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/import-03-corrupted.png`,
            fullPage: true,
        });
    });
});
