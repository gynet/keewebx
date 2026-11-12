import { test, expect } from '@playwright/test';

test('creates an encrypted database and reopens it after reload', async ({ page }) => {
    await page.goto('/next.html');
    await page.click('#create-vault');
    await page.getByLabel('Vault name', { exact: true }).fill('Created vault');
    await page.getByLabel('Master password', { exact: true }).fill('new master password');
    await page.getByLabel('Confirm password', { exact: true }).fill('different');
    await page.getByRole('button', { name: 'Create vault', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Passwords do not match.');
    await page.getByLabel('Confirm password', { exact: true }).fill('new master password');
    await page.getByRole('button', { name: 'Create vault', exact: true }).click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30000 });
    await page.getByRole('button', { name: 'New entry', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('First saved entry');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.click('#lock');
    await expect(page.locator('#password')).toBeVisible();
    await page.reload();
    await page.fill('#password', 'wrong password');
    await page.click('#unlock');
    await expect(page.getByText('Wrong password', { exact: true })).toBeVisible();
    await page.fill('#password', 'new master password');
    await page.click('#unlock');
    await expect(page.locator('.entry-row[data-entry="First saved entry"]')).toBeVisible();
});

test('mobile menu drags to either edge and remembers its dock', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/next.html');
    await page.click('#open-demo');
    const handle = page.getByRole('button', { name: 'Move menu', exact: true });
    const bounds = (await handle.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(25, bounds.y + bounds.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('.phone-bar')).toHaveAttribute('data-side', 'left');
    await page.reload();
    await page.click('#open-demo');
    await expect(page.locator('.phone-bar')).toHaveAttribute('data-side', 'left');
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.phone-bar')).toHaveAttribute('data-side', 'right');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Theme' })).toBeVisible();
});
