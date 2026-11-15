import { expect, type Page } from '@playwright/test';

export async function openStartTools(page: Page) {
    const tools = page.locator('.start-tools');
    await expect(tools.locator('summary')).toBeVisible();
    if (!await tools.evaluate(element => element.hasAttribute('open'))) await tools.locator('summary').click();
    await expect(tools.getByRole('button', { name: 'Password generator', exact: true })).toBeVisible();
}
