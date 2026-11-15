import { expect, test } from '@playwright/test';

for (const width of [1280, 390, 320]) test(`New default and essential actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/index.html');
    await page.locator('#open-demo').click();
    await page.locator('.entry-row[data-entry="GitHub"]').click();
    await expect(page.locator('#entry-title')).toHaveText('GitHub');
    await expect(page.getByRole('button', { name: 'Appearance…', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Change icon and color', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Entry appearance', exact: true });
    await expect(appearance).toBeVisible();
    await appearance.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('dialog', { name: 'Entry history', exact: true }).getByRole('button', { name: 'Close History', exact: true }).click();
    await expect(page.getByRole('button', { name: 'History', exact: true })).toBeFocused();
    const nav = page.getByRole('navigation', { name: 'Vault', exact: true });
    if (width < 761) {
        await expect(nav).toBeHidden();
        await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeHidden();
        await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
    }
    await expect(nav.locator('.open-vaults__select')).toHaveCount(0);
    await nav.getByRole('button', { name: /^Save / }).click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date');
    await nav.getByRole('button', { name: 'Manage Work', exact: true }).click();
    const groups = page.getByRole('dialog', { name: 'Groups', exact: true });
    await groups.getByRole('button', { name: 'Rename group', exact: true }).click();
    await page.getByRole('dialog', { name: 'Rename group', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await groups.getByRole('button', { name: 'Close groups', exact: true }).click();
    if (width < 761) {
        await nav.getByRole('button', { name: 'Close navigation', exact: true }).click();
        await expect(nav).toBeHidden();
        await expect(page.locator('.phone-bar, .mobile-menu')).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
});

test('explicit Classic still opens the bundled demo', async ({ page }) => {
    await page.goto('/classic.html');
    await page.locator('#open__icon-demo').click();
    await expect(page.locator('.list__item').first()).toBeVisible();
});
