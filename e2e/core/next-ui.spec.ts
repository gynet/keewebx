import { test, expect, Page } from '@playwright/test';
import path from 'path';

/**
 * The new interface (next.html) and the switch between it and Classic
 * (index.html). Both use the same vaults and settings in one browser.
 */

const KDBX4_FILE = path.resolve(__dirname, '../../packages/db/resources/KDBX4.1.kdbx');
const KDBX4_PASSWORD = 'test';

async function openDemo(page: Page): Promise<void> {
    await page.goto('/next.html');
    await page.click('#open-demo');
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout: 15000 });
}

test.describe('New interface', () => {
    test('opens the demo, shows an entry, copies a field, searches and filters', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await openDemo(page);
        await expect(page.locator('#sync-state')).toHaveText('Up to date');
        await expect(page.locator('.list__meta')).toHaveText('21 items');

        await page.click('.entry-row[data-entry="GitHub"]');
        await expect(page.locator('#entry-title')).toHaveText('GitHub');
        await expect(page.locator('[data-field="user"] .field__value')).toHaveText('demouser');
        await expect(page.locator('[data-field="otp"] .field__value')).toHaveText(/^\d{3} \d{3}$/);

        await page.locator('[data-field="user"] .field__action').click();
        await expect(page.locator('[data-field="user"] .field__action')).toHaveText('Copied');
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('demouser');

        await page.locator('[data-field="password"] .icon-btn').click();
        await expect(page.locator('[data-field="password"] .field__value')).not.toHaveText(/•/);

        await page.fill('#search', 'mail');
        await expect(page.locator('.entry-row').first()).toContainText(/mail/i);
        await page.fill('#search', '');

        await page.getByRole('button', { name: '2fa', exact: true }).click();
        const count = await page.locator('.entry-row').count();
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThan(21);
    });

    test('locks back to the start screen', async ({ page }) => {
        await openDemo(page);
        await page.click('#lock');
        await expect(page.locator('#open-demo')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('.entry-row')).toHaveCount(0);
    });

    test('unlocks a file from this device and remembers it', async ({ page }) => {
        await page.goto('/next.html');
        await page.setInputFiles('#open-file-input', KDBX4_FILE);
        await expect(page.locator('.card__title')).toHaveText('KDBX4.1.kdbx');

        await page.fill('#password', 'wrong');
        await page.click('#unlock');
        await expect(page.locator('#unlock-error')).toHaveText('Wrong password', { timeout: 30000 });

        await page.fill('#password', KDBX4_PASSWORD);
        await page.click('#unlock');
        await expect(page.locator('.entry-row').first()).toBeVisible({ timeout: 30000 });

        // After a reload the vault is in the list and only needs the password.
        await page.reload();
        await expect(page.locator('.vault-row[data-vault="KDBX4.1"]')).toHaveClass(/vault-row--on/, { timeout: 15000 });
        await page.fill('#password', KDBX4_PASSWORD);
        await page.click('#unlock');
        await expect(page.locator('.entry-row').first()).toBeVisible({ timeout: 30000 });
    });

    test('phone layout shows one pane at a time', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openDemo(page);
        await expect(page.locator('.side')).toBeHidden();
        await page.click('.entry-row[data-entry="GitHub"]');
        await expect(page.locator('#entry-title')).toBeVisible();
        await expect(page.locator('.list')).toBeHidden();
    });
});

test.describe('Switching between Classic and New', () => {
    test('Classic settings open the new interface, and New settings go back', async ({ page }) => {
        await page.goto('/');
        await page.click('#open__icon-demo');
        await expect(page.locator('.list__item').first()).toBeVisible({ timeout: 30000 });
        await page.locator('.footer__btn-settings').click();
        await page.selectOption('#settings__general-ui', 'new');
        await page.waitForURL(/next\.html/);

        // Classic now forwards to the new interface.
        await page.goto('/');
        await page.waitForURL(/next\.html/);

        await page.click('#open-demo');
        await page.click('#open-settings');
        await page.click('#use-classic');
        await page.waitForURL(/index\.html/);
        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15000 });

        // And stays Classic.
        await page.goto('/');
        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15000 });
        expect(page.url()).not.toContain('next.html');
    });

    test('index.html?ui=classic always shows Classic and makes it the choice again', async ({ page }) => {
        await page.goto('/next.html');
        await page.click('#open-demo');
        await page.click('#open-settings');
        await page.evaluate(() => {
            // Choose New the way its settings store it.
            const raw = localStorage.getItem('appSettings');
            const s = raw ? JSON.parse(raw) : {};
            s.ui = 'new';
            localStorage.setItem('appSettings', JSON.stringify(s));
        });
        await page.goto('/');
        await page.waitForURL(/next\.html/);
        await page.goto('/?ui=classic');
        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15000 });
        await page.goto('/');
        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15000 });
    });
});
