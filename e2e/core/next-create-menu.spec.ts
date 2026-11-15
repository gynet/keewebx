import { activateVaultUtility } from './vault-utilities';
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
    await page.locator('.entry-editor').getByLabel('Title', { exact: true }).fill('First saved entry');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await activateVaultUtility(page, 'Lock');
    await expect(page.locator('#password')).toBeVisible();
    await page.reload();
    await page.fill('#password', 'wrong password');
    await page.click('#unlock');
    await expect(page.getByText('Wrong password', { exact: true })).toBeVisible();
    await page.fill('#password', 'new master password');
    await page.click('#unlock');
    await expect(page.locator('.entry-row[data-entry="First saved entry"]')).toBeVisible();
});

test('mobile Browse drawer survives reload and keeps one settings action', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/next.html');
    await page.click('#open-demo');
    await activateVaultUtility(page, 'Settings');
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Theme' })).toBeVisible();
    await page.reload();
    await page.click('#open-demo');
    await expect(page.getByRole('button', { name: 'Browse vault', exact: true })).toHaveCount(1);
    await expect(page.locator('.phone-bar')).toHaveCount(0);
    await activateVaultUtility(page, 'Settings');
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Theme' })).toBeVisible();
});
