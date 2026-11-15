import { activateVaultUtility, revealVaultTheme } from './vault-utilities';
import { test, expect } from '@playwright/test';

const choices = ['dark', 'light', 'sd', 'sl', 'fb', 'bl', 'db', 'lb', 'te', 'lt', 'dc', 'hc'];
for (const width of [1280, 320]) test(`all named palettes persist and remain usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => { if (!localStorage.getItem('app-settings')) localStorage.setItem('app-settings', JSON.stringify({ theme: 'db' })); });
    await page.goto('/next.html'); await page.locator('#open-demo').click(); await expect(page.locator('.entry-row').first()).toBeVisible();
    await activateVaultUtility(page, 'Settings');
    const picker = page.getByRole('combobox', { name: 'Theme', exact: true });
    for (const value of choices) {
        await picker.selectOption(value);
        await expect(page.locator('html')).toHaveAttribute('data-kx-palette', value);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`${value}-${width}.png`) });
        await page.reload(); await page.locator('#open-demo').click(); await expect(page.locator('.entry-row').first()).toBeVisible();
        await activateVaultUtility(page, 'Settings');
        await expect(picker).toHaveValue(value);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('app-settings')!).theme)).toBe('db');
    }
});

test('six system pairs follow the OS and manual choices stay fixed', async ({ page }) => {
    await page.goto('/next.html'); await page.locator('#open-demo').click(); await expect(page.locator('.entry-row').first()).toBeVisible();
    await activateVaultUtility(page, 'Settings');
    const picker = page.getByRole('combobox', { name: 'Theme', exact: true });
    await picker.selectOption('system');
    for (const [pair, dark, light] of [['default', 'dark', 'light'], ['solarized', 'sd', 'sl'], ['blue', 'fb', 'bl'], ['brown', 'db', 'lb'], ['terminal', 'te', 'lt'], ['contrast', 'dc', 'hc']]) {
        await page.getByRole('combobox', { name: 'System palette', exact: true }).selectOption(pair);
        await page.emulateMedia({ colorScheme: 'dark' }); await expect(page.locator('html')).toHaveAttribute('data-kx-palette', dark);
        await page.emulateMedia({ colorScheme: 'light' }); await expect(page.locator('html')).toHaveAttribute('data-kx-palette', light);
    }
    await page.reload(); await page.locator('#open-demo').click(); await expect(page.locator('.entry-row').first()).toBeVisible(); await activateVaultUtility(page, 'Settings');
    await expect(page.getByRole('combobox', { name: 'System palette', exact: true })).toHaveValue('contrast');
    await picker.selectOption('db');
    await page.emulateMedia({ colorScheme: 'light' }); await expect(page.locator('html')).toHaveAttribute('data-kx-palette', 'db');
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    const vaultTheme = await revealVaultTheme(page);
    await vaultTheme.selectOption('lb');
    await page.keyboard.press('Escape');
    await expect(page.locator('html')).toHaveAttribute('data-kx-palette', 'lb');
});
