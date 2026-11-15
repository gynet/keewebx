import { test, expect } from '@playwright/test';

for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) test.describe(`single mobile menu ${viewport.width}`, () => {
    test.use({ hasTouch: true, viewport });
    test('one Browse control expands and closes the drawer without duplicate utilities', async ({ page }) => {
        await page.goto('/next.html');
        await page.locator('#open-demo').tap();
        const browse = page.getByRole('button', { name: 'Browse vault', exact: true });
        const navigation = page.getByRole('navigation', { name: 'Vault', exact: true });
        await expect(browse).toHaveCount(1);
        await expect(browse).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('.phone-bar')).toHaveCount(0);
        await expect(page.getByRole('button', { name: /^(Move menu|Show menu)$/ })).toHaveCount(0);
        for (let repeat = 0; repeat < 2; repeat++) {
            await browse.tap();
            await expect(navigation).toBeVisible();
            await expect(page.getByRole('button', { name: 'Browse vault', exact: true, includeHidden: true })).toHaveCount(1);
            for (const name of ['Settings', 'Lock', 'Open another vault']) {
                await expect(page.getByRole('button', { name, exact: true, includeHidden: true })).toHaveCount(1);
                await expect(navigation.getByRole('button', { name, exact: true })).toBeVisible();
            }
            await navigation.getByRole('button', { name: 'Close navigation', exact: true }).tap();
            await expect(navigation).not.toBeVisible();
            await expect(browse).toHaveAttribute('aria-expanded', 'false');
            await expect(browse).toBeFocused();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.locator('.entry-row').first().tap();
        await expect(page.locator('#entry-title')).toBeVisible();
        await browse.tap();
        await navigation.getByRole('button', { name: 'Close navigation', exact: true }).tap();
        await expect(page.locator('#entry-title')).toBeVisible();
    });
});
