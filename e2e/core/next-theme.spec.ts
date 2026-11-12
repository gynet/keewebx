import { test, expect } from '@playwright/test';

test('one click switches appearance and remembers it without changing Classic preferences', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/next.html');
    const classicTheme = await page.evaluate(() => JSON.parse(localStorage.getItem('appSettings') || '{}').theme ?? null);
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 25, 31)');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();
    await page.click('#open-demo');
    await page.locator('#open-settings').click();
    await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark');
    await page.getByRole('combobox', { name: 'Theme' }).selectOption('light');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await page.getByRole('combobox', { name: 'Theme' }).selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 25, 31)');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    expect(await page.evaluate(() => localStorage.getItem('uiTheme'))).toBe('system');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('appSettings') || '{}').theme ?? null)).toBe(classicTheme);
});

test('phone theme switch stays reachable in entry details and settings can return', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/next.html');
    await page.click('#open-demo');
    await page.click('.entry-row[data-entry="GitHub"]');
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect(page.locator('#entry-title')).toHaveText('GitHub');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 25, 31)');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Theme' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    await expect(page.locator('#entry-title')).toHaveText('GitHub');
});
