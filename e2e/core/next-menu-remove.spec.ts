import { test, expect } from '@playwright/test';
import path from 'node:path';

test('removes a browser-local database only after confirmation; original file still opens', async ({ page }) => {
    const fixture = path.resolve(__dirname, '../../modules/db/resources/KDBX4.1.kdbx');
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', fixture);
    await page.fill('#password', 'test');
    await page.click('#unlock');
    await page.click('#lock');
    const remove = page.getByRole('button', { name: 'Remove KDBX4.1.kdbx from this browser', exact: true });
    await page.mouse.move(1000, 50);
    await expect(remove).toHaveCSS('opacity', '0');
    await page.locator('.vault-row-wrap').hover();
    await expect(remove).toHaveCSS('opacity', '1');
    page.once('dialog', (dialog) => dialog.dismiss());
    await remove.click();
    await expect(remove).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await remove.click();
    await expect(remove).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-vault]')).toHaveCount(0);
    await page.setInputFiles('#open-file-input', fixture);
    await page.fill('#password', 'test');
    await page.click('#unlock');
    await expect(page.locator('.entry-row').first()).toBeVisible();
});

test('mobile toolbar collapses to a docked handle and restores its controls', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/next.html');
    await page.click('#open-demo');
    await page.getByRole('button', { name: 'Move menu', exact: true }).click();
    const handle = page.getByRole('button', { name: 'Show menu', exact: true });
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.phone-bar').getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.phone-bar')).toHaveCSS('left', '0px');
    await page.setViewportSize({ width: 740, height: 390 });
    await expect(handle).toBeVisible();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Theme' })).toBeVisible();
});
