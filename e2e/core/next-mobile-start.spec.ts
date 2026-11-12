import { test, expect, type Page } from '@playwright/test';

async function fits(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    for (const field of await page.locator('.start input:visible, .start select:visible, .start button:visible').all()) {
        const box = await field.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    }
}

for (const width of [320, 390]) {
    test(`start forms remain reachable at ${width}px with advanced settings and limited height`, async ({ page }) => {
        await page.setViewportSize({ width, height: 740 });
        await page.goto('/next.html');
        await page.click('#create-vault');
        await page.getByText('Advanced', { exact: true }).click();
        await fits(page);
        await page.getByLabel('Vault name', { exact: true }).fill('LongDatabaseName'.repeat(6));
        await page.getByLabel('Default user', { exact: true }).fill('name@example.com');
        await page.getByLabel('Master password', { exact: true }).fill('mobile password');
        await page.getByLabel('Confirm password', { exact: true }).fill('different');
        await page.setViewportSize({ width, height: 350 });
        await fits(page);
        await page.getByRole('button', { name: 'Create vault', exact: true }).click();
        await expect(page.getByRole('alert')).toHaveText('Passwords do not match.');
        await page.getByLabel('Confirm password', { exact: true }).fill('mobile password');
        await page.getByRole('button', { name: 'Create vault', exact: true }).click();
        await page.getByRole('button', { name: 'Lock', exact: true }).click();
        await expect(page.locator('#password')).toBeVisible();
        await fits(page);
        await page.fill('#password', 'wrong password');
        await page.click('#unlock');
        await expect(page.locator('#unlock-error')).toBeVisible();
        await fits(page);
        await page.setViewportSize({ width: 740, height: 320 });
        await fits(page);
        await page.fill('#password', 'mobile password');
        await page.click('#unlock');
        await expect(page.getByRole('button', { name: 'New entry', exact: true })).toBeVisible();
    });
}
