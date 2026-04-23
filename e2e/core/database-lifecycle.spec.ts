import { test, expect } from '@playwright/test';

test.describe('Database Lifecycle', () => {
  test('app loads and renders main UI', async ({ page }) => {
    await page.goto('/');

    // Wait for the page to be fully loaded
    await page.waitForLoadState('networkidle');

    // Verify the page has a title
    const title = await page.title();
    expect(title).toBeTruthy();

    // Verify the body has content (app has rendered something)
    const body = page.locator('body');
    await expect(body).not.toBeEmpty();

    // Take a screenshot for visual verification
    await page.screenshot({ path: 'e2e/screenshots/app-loaded.png', fullPage: true });
  });
});
