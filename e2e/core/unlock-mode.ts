import { expect, type Page } from '@playwright/test';

export async function expectUnlockScreen(page: Page) {
    await expect(page.locator('.unlock-card__action')).toHaveCount(1);
    await expect(page.locator('.unlock-card__action')).toBeVisible();
}

export async function choosePasswordUnlock(page: Page) {
    await expectUnlockScreen(page);
    const fallback = page.getByRole('button', { name: 'Use password', exact: true });
    if (await fallback.isVisible()) await fallback.click();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#unlock')).toBeVisible();
}

export async function choosePasskeyUnlock(page: Page) {
    await expectUnlockScreen(page);
    const passkey = page.getByRole('button', { name: 'Use passkey', exact: true });
    if (await passkey.isVisible()) await passkey.click();
    await expect(page.getByRole('button', { name: 'Unlock with passkey', exact: true })).toBeVisible();
}
