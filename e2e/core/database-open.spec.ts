import { test, expect } from '@playwright/test';
import path from 'path';

const SCREENSHOT_DIR = 'e2e/screenshots';

test.describe('Database Open Operations', () => {
    test.describe('Open screen UI', () => {
        test('open screen shows Open, New, Demo, and More buttons', async ({ page }) => {
            await page.goto('/');
            await page.waitForLoadState('networkidle');

            await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });
            await expect(page.locator('#open__icon-new')).toBeVisible();
            await expect(page.locator('#open__icon-demo')).toBeVisible();
            await expect(page.locator('#open__icon-more')).toBeVisible();

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/01-open-screen.png`,
                fullPage: true,
            });
        });
    });

    test.describe('Demo database', () => {
        test('clicking Demo opens the built-in demo database with entries', async ({ page }) => {
            await page.goto('/');
            await page.waitForLoadState('networkidle');

            // Wait for the Demo button to appear
            const demoButton = page.locator('#open__icon-demo');
            await expect(demoButton).toBeVisible({ timeout: 15_000 });

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/02-before-demo-click.png`,
                fullPage: true,
            });

            // Click the Demo button
            await demoButton.click();

            // The demo database opens without password — the open view closes and
            // the main app view appears with the menu and list panes.
            // Wait for the list view to populate with entries.
            const listItems = page.locator('.list__item');
            await expect(listItems.first()).toBeVisible({ timeout: 30_000 });

            // There should be multiple entries in the demo database
            const count = await listItems.count();
            expect(count).toBeGreaterThan(0);

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/03-demo-database-open.png`,
                fullPage: true,
            });
        });
    });

    test.describe('Open KDBX4 file', () => {
        // KDBX4.1.kdbx requires only a password ("test"), no key file.
        // Argon2.kdbx requires both password + key file, making it harder to test via the UI.
        const kdbxPath = path.resolve(
            __dirname,
            '../../packages/db/resources/KDBX4.1.kdbx'
        );
        const kdbxPassword = 'test';

        /**
         * Helper: open a KDBX file via the Open button -> filechooser -> dismiss local-file modal.
         * Returns after the password input is editable.
         */
        async function openFileViaChooser(page: import('@playwright/test').Page, filePath: string) {
            const [fileChooser] = await Promise.all([
                page.waitForEvent('filechooser'),
                page.locator('#open__icon-open').click(),
            ]);
            await fileChooser.setFiles(filePath);

            // A "Local file" warning modal appears with an entrance animation.
            // Wait for it to be visible and stable before clicking OK.
            const modal = page.locator('.modal');
            await expect(modal).toBeVisible({ timeout: 5_000 });
            const okButton = page.locator('.modal__buttons button[data-result="ok"]');
            await expect(okButton).toBeVisible({ timeout: 5_000 });
            // Wait for the modal animation to complete before clicking
            await modal.evaluate((el) => {
                return new Promise<void>((resolve) => {
                    const animations = el.getAnimations({ subtree: true });
                    if (animations.length === 0) return resolve();
                    Promise.all(animations.map((a) => a.finished)).then(() => resolve());
                });
            });
            await okButton.click();

            // Wait for the password input to become editable
            const passwordInput = page.locator('.open__pass-input');
            await expect(passwordInput).not.toHaveAttribute('readonly', '', { timeout: 10_000 });
            return passwordInput;
        }

        test('opens KDBX4.1 file with correct password', async ({ page }) => {
            test.setTimeout(30_000);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });

            const passwordInput = await openFileViaChooser(page, kdbxPath);

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/04-file-selected.png`,
                fullPage: true,
            });

            // Type the password
            await passwordInput.fill(kdbxPassword);

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/05-password-entered.png`,
                fullPage: true,
            });

            // Click the enter/submit button to open the database
            await page.locator('.open__pass-enter-btn').click();

            // KDBX4.1.kdbx uses AES-KDF with 60,000 rounds (fast via WebCrypto).
            // Wait for the database to fully load — list items should appear.
            const listItems = page.locator('.list__item');
            await expect(listItems.first()).toBeVisible({ timeout: 15_000 });

            const count = await listItems.count();
            expect(count).toBeGreaterThan(0);

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/06-kdbx4-database-open.png`,
                fullPage: true,
            });
        });

        test('rejects KDBX4 file with wrong password', async ({ page }) => {
            test.setTimeout(30_000);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });

            const passwordInput = await openFileViaChooser(page, kdbxPath);

            await passwordInput.fill('wrong-password');
            await page.locator('.open__pass-enter-btn').click();

            // With wrong password, the input should shake (get input--error class)
            // and the open view should remain visible (no list items appear).
            // AES-KDF with 60K rounds completes quickly; error shows within seconds.
            await expect(passwordInput).toHaveClass(/input--error/, { timeout: 15_000 });

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/07-wrong-password-error.png`,
                fullPage: true,
            });
        });
    });

    test.describe('Create new database', () => {
        test('creates a new empty database', async ({ page }) => {
            await page.goto('/');
            await page.waitForLoadState('networkidle');

            // Wait for New button
            const newButton = page.locator('#open__icon-new');
            await expect(newButton).toBeVisible({ timeout: 15_000 });

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/08-before-new-click.png`,
                fullPage: true,
            });

            // Click "New" — this calls createNew() which immediately creates a new
            // database without asking for a password (password is set later via settings).
            await newButton.click();

            // The open view closes and the main app appears.
            // A new database has a default group structure but no entries.
            // Wait for the app body to become the main view (menu visible).
            await expect(page.locator('.app__body .app__menu')).toBeVisible({ timeout: 15_000 });

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/09-new-database-created.png`,
                fullPage: true,
            });
        });
    });
});
