import { test, expect, type Page } from '@playwright/test';

async function usableGroups(page: Page) {
    const work = page.locator('.menu__item-title').filter({ hasText: /^Work$/ });
    await work.scrollIntoViewIfNeeded();
    await expect.poll(() => work.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return hit === element || !!hit && element.contains(hit);
    })).toBe(true);
    const groups = page.locator('.menu__section--grow > .scroller');
    expect((await groups.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    const menu = (await page.locator('.menu').boundingBox())!;
    const trash = (await page.locator('.menu__item-title').filter({ hasText: /^Trash$/ }).boundingBox())!;
    expect(trash.y + trash.height).toBeLessThanOrEqual(menu.y + menu.height + 1);
    await work.click();
    await expect(page.locator('.list__item-title').filter({ hasText: /^AWS Console$/ })).toBeVisible();
}

for (const height of [720, 350]) {
    test(`tag pane leaves usable groups at ${height}px, including after resizing and reload`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1280, height });
        await page.goto('/');
        await page.locator('#open__icon-demo').click();
        await expect(page.locator('.list__item').first()).toBeVisible();
        await usableGroups(page);
        const tags = page.locator('.menu__section--drag');
        const divider = page.locator('.menu__drag-section');
        const rect = (await divider.boundingBox())!;
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
        await page.mouse.down();
        await page.mouse.move(rect.x + rect.width / 2, height - 50, { steps: 8 });
        await page.mouse.up();
        // Wait for the actual persisted preference, without setting application state.
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('appSettings') || '{}').tagsViewHeight))
            .toBeGreaterThan(0);
        await usableGroups(page);
        const menu = (await page.locator('.menu').boundingBox())!;
        expect((await tags.boundingBox())!.height).toBeLessThanOrEqual(menu.height / 2 + 20);
        await page.reload();
        // After the first visit, Classic places Demo under More.
        await page.locator('#open__icon-more').click();
        await page.locator('#open__icon-demo').click();
        await expect(page.locator('.list__item').first()).toBeVisible();
        await usableGroups(page);
        await page.screenshot({ path: testInfo.outputPath(`sidebar-${height}.png`) });
    });
}
