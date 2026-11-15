import { activateVaultUtility, revealVaultTheme } from './vault-utilities';
import { test, expect } from '@playwright/test';

const themePanel = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'Theme', exact: true });

for (const width of [1280, 320]) test(`theme picker exposes existing choices and dismisses accessibly at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/next.html');
    const classicTheme = await page.evaluate(() => JSON.parse(localStorage.getItem('appSettings') || '{}').theme ?? null);
    await activateVaultUtility(page, 'Theme', { start: true });
    const panel = themePanel(page), picker = panel.getByRole('combobox', { name: 'Theme', exact: true });
    const trigger = page.getByRole('button', { name: 'Theme', exact: true }).filter({ visible: true });
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(picker).toBeFocused();
    await expect(picker).toHaveValue('system'); // Opening the icon never changes the choice.
    await expect(picker.locator('option')).toHaveText(['System', 'Dark', 'Light', 'Solarized dark', 'Solarized light',
        'Flat blue', 'Light blue', 'Dark brown', 'Light brown', 'Terminal', 'Light terminal', 'Dark high contrast', 'Light high contrast']);
    await picker.selectOption('sd');
    await expect(page.locator('html')).toHaveAttribute('data-kx-palette', 'sd');
    await expect(picker.locator('option:checked')).toHaveText('Solarized dark');
    await expect(panel.getByRole('combobox', { name: 'System palette', exact: true })).toHaveCount(0);
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(740);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`theme-picker-${width}-solarized.png`), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
    await trigger.press('ArrowDown');
    await expect(picker).toBeFocused();
    await expect(picker).toHaveValue('sd');
    // Real outside pointer event; no app handler or preference is invoked directly.
    await page.mouse.click(width - 4, 4);
    await expect(panel).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-kx-palette', 'sd');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('appSettings') || '{}').theme ?? null)).toBe(classicTheme);
    await activateVaultUtility(page, 'Theme', { start: true });
    await expect(picker).toHaveValue('sd');
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
});

test('theme picker and Settings share named themes and system-pair semantics', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/next.html');
    await page.locator('#open-demo').click();
    await activateVaultUtility(page, 'Theme');
    const panel = themePanel(page), picker = panel.getByRole('combobox', { name: 'Theme', exact: true });
    await picker.selectOption('dark');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 25, 31)');
    await page.keyboard.press('Escape');
    await activateVaultUtility(page, 'Settings');
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    const settingsPicker = page.getByRole('combobox', { name: 'Theme', exact: true });
    await expect(settingsPicker).toHaveValue('dark');
    await settingsPicker.selectOption('db');
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await expect(picker).toHaveValue('db');
    await picker.selectOption('system');
    await panel.getByRole('combobox', { name: 'System palette', exact: true }).selectOption('terminal');
    await expect(page.locator('html')).toHaveAttribute('data-kx-palette', 'lt');
    await page.screenshot({ path: test.info().outputPath('theme-picker-system-pair-desktop.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-kx-palette', 'te');
    await page.keyboard.press('Escape');
    await expect(settingsPicker).toHaveValue('system');
    await expect(page.getByRole('combobox', { name: 'System palette', exact: true })).toHaveValue('terminal');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-kx-palette', 'lt');
    expect(await page.evaluate(() => localStorage.getItem('uiTheme'))).toBe('system');
    expect(await page.evaluate(() => localStorage.getItem('uiPalettePair'))).toBe('terminal');
});

test('phone theme picker stays reachable in entry details without replacing the selected entry', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/next.html');
    await page.locator('#open-demo').click();
    await page.locator('.entry-row[data-entry="GitHub"]').click();
    const picker = await revealVaultTheme(page);
    await expect(themePanel(page)).toHaveCount(0);
    await picker.selectOption('hc');
    await expect(page.locator('html')).toHaveAttribute('data-kx-palette', 'hc');
    await expect(page.locator('#entry-title')).toHaveText('GitHub');
    await page.screenshot({ path: test.info().outputPath('theme-picker-mobile-vault.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await activateVaultUtility(page, 'Settings');
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toHaveValue('hc');
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    await expect(page.locator('#entry-title')).toHaveText('GitHub');
});
