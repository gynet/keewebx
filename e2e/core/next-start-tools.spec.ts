import { test, expect } from '@playwright/test';

for (const width of [320, 390, 1280]) test(`start Tools keeps independent generator secondary and keyboard accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/next.html');
    const tools = page.locator('.start-tools');
    const menu = tools.locator('summary');
    const generator = page.getByRole('button', { name: 'Password generator', exact: true });
    await expect(page.locator('.entry-row')).toHaveCount(0);
    await expect(generator).toHaveCount(0);
    await expect(page.locator('.start__tools .start-tools')).toHaveCount(1);
    await expect(menu).toBeVisible();
    expect((await menu.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`start-tools-secondary-${width}.png`), fullPage: true });
    await menu.focus(); await menu.press('Enter');
    await expect(generator).toBeVisible();
    await generator.click();
    const dialog = page.getByRole('dialog', { name: 'Generate password', exact: true });
    await expect(dialog.getByLabel('Generated password', { exact: true })).not.toHaveValue('');
    await expect(page.locator('.entry-row')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close generator', exact: true }).click();
    await expect(generator).toBeFocused();
    await menu.click();
    await expect(generator).toHaveCount(0);
    // The standalone shortcut continues to work with the disclosure closed and no vault open.
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('Control+g');
    await expect(dialog).toBeVisible();
    await expect(page.locator('.entry-row')).toHaveCount(0);
});
