import { test, expect } from '@playwright/test';

const SCREENSHOT_DIR = 'e2e/screenshots';

test.describe('App E2E', () => {
    test('app loads with dark theme', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        // The body element has class th-dark by default (set in index.html)
        const body = page.locator('body');
        await expect(body).toHaveClass(/th-dark/);

        // The open screen icons container must be visible (first row, not the hidden lower row)
        const icons = page.locator('.open__icons').first();
        await expect(icons).toBeVisible();

        // Verify the background color is the dark theme value (#1e1e1e)
        const bgColor = await body.evaluate(
            (el) => getComputedStyle(el).backgroundColor
        );
        // #1e1e1e = rgb(30, 30, 30)
        expect(bgColor).toBe('rgb(30, 30, 30)');

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/app-dark-theme.png`,
            fullPage: true,
        });
    });

    test('shows Open, New, Demo, More buttons with correct icons', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        // Wait for UI to be ready
        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });

        // Verify all 4 icon buttons are visible
        const openBtn = page.locator('#open__icon-open');
        const newBtn = page.locator('#open__icon-new');
        const demoBtn = page.locator('#open__icon-demo');
        const moreBtn = page.locator('#open__icon-more');

        await expect(openBtn).toBeVisible();
        await expect(newBtn).toBeVisible();
        await expect(demoBtn).toBeVisible();
        await expect(moreBtn).toBeVisible();

        // Verify each has a FontAwesome icon element
        await expect(openBtn.locator('i.fa.fa-lock')).toBeVisible();
        await expect(newBtn.locator('i.fa.fa-plus')).toBeVisible();
        await expect(demoBtn.locator('i.fa.fa-magic')).toBeVisible();
        await expect(moreBtn.locator('i.fa.fa-ellipsis-h')).toBeVisible();

        // Verify each has text content
        await expect(openBtn.locator('.open__icon-text')).not.toBeEmpty();
        await expect(newBtn.locator('.open__icon-text')).not.toBeEmpty();
        await expect(demoBtn.locator('.open__icon-text')).not.toBeEmpty();
        await expect(moreBtn.locator('.open__icon-text')).not.toBeEmpty();

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/app-four-buttons.png`,
            fullPage: true,
        });
    });

    test('click Demo opens demo database with entries', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const demoBtn = page.locator('#open__icon-demo');
        await expect(demoBtn).toBeVisible({ timeout: 15_000 });
        await demoBtn.click();

        // Wait for the database to load — list items should appear
        const listItems = page.locator('.list__item');
        await expect(listItems.first()).toBeVisible({ timeout: 30_000 });

        // Verify there are multiple entries (demo db has several)
        const count = await listItems.count();
        expect(count).toBeGreaterThanOrEqual(3);

        // Verify the app body structure is present (menu + list + details)
        await expect(page.locator('.app__body .app__menu')).toBeVisible();
        await expect(page.locator('.app__body .app__list')).toBeVisible();

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/app-demo-entries.png`,
            fullPage: true,
        });
    });

    test('click New creates empty database', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const newBtn = page.locator('#open__icon-new');
        await expect(newBtn).toBeVisible({ timeout: 15_000 });
        await newBtn.click();

        // The main app view should appear with menu visible
        await expect(page.locator('.app__body .app__menu')).toBeVisible({ timeout: 15_000 });

        // A new database should have NO entries in the list (it's empty)
        // The list__item elements should not exist or count should be 0
        const listItems = page.locator('.list__item');
        const count = await listItems.count();
        expect(count).toBe(0);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/app-new-empty-db.png`,
            fullPage: true,
        });
    });

    test('password input is readonly until file is selected', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });

        // The password input exists but is readonly (placeholder says "click to open")
        const passwordInput = page.locator('.open__pass-input');
        await expect(passwordInput).toHaveAttribute('readonly', '');

        // The password area is present in the DOM
        const passArea = page.locator('.open__pass-area');
        await expect(passArea).toBeAttached();

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/app-password-readonly.png`,
            fullPage: true,
        });
    });

    test('no JS errors on startup', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));

        const consoleErrors: string[] = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                consoleErrors.push(msg.text());
            }
        });

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        // Verify the app actually loaded (not just a blank page)
        await expect(page.locator('.open__icons').first()).toBeVisible({ timeout: 15_000 });

        expect(errors).toEqual([]);
        expect(consoleErrors).toEqual([]);
    });
});
