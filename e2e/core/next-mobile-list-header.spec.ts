import { test, expect } from '@playwright/test';
for (const [width, height] of [[320, 568], [568, 320]]) test(`mobile list header and entries remain reachable at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await page.goto('/next.html'); await page.locator('#open-demo').click();
    await expect(page.locator('.entry-row').first()).toBeVisible();
    await page.locator('.list').getByText('Search options', { exact: true }).click();
    const last = page.locator('.entry-row').last(); const title = await last.getAttribute('data-entry');
    await last.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`mobile-list-${width}x${height}.png`) });
    await last.click(); await expect(page.locator('#entry-title')).toHaveText(title!);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const first = page.locator('.entry-row').first(); const firstTitle = await first.getAttribute('data-entry');
    await first.click(); await expect(page.locator('#entry-title')).toHaveText(firstTitle!);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
