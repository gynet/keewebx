import { test, expect } from '@playwright/test';
import path from 'node:path';

test.use({ hasTouch: true });
test('touch swipe reveals and hides local deletion without opening or deleting a vault', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native touch injection requires Chromium CDP Input.dispatchTouchEvent.');
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', path.resolve(__dirname, '../../modules/db/resources/KDBX4.1.kdbx'));
    await page.fill('#password', 'test');
    await page.click('#unlock');
    await page.click('#lock');
    await page.setViewportSize({ width: 390, height: 844 });
    const row = page.locator('.vault-row-wrap');
    const remove = row.getByRole('button', { name: 'Remove KDBX4.1.kdbx from this browser', exact: true });
    await expect(remove).toBeHidden();
    const session = await context.newCDPSession(page);
    const swipe = async (left: boolean) => {
        await row.scrollIntoViewIfNeeded();
        const rect = (await row.boundingBox())!;
        const from = rect.x + (left ? rect.width - 70 : 30);
        const to = rect.x + (left ? 30 : rect.width - 70);
        const y = rect.y + rect.height / 2;
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] });
        for (let i = 1; i <= 8; i++) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from + (to - from) * i / 8, y }] });
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe(true);
    await expect(remove).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await swipe(false);
    await expect(remove).toBeHidden();
    await swipe(true);
    // Chromium suppresses taps briefly after a native scroll gesture. Let that
    // gesture finish before testing the separate destructive-button interaction.
    await page.waitForTimeout(500);
    const dismissed = page.waitForEvent('dialog').then(async dialog => {
        expect(dialog.type()).toBe('confirm');
        expect(dialog.message()).toContain('Remove KDBX4.1.kdbx from this browser?');
        await dialog.dismiss();
    });
    await remove.tap();
    await dismissed;
    await expect(row).toBeVisible();
    const accepted = page.waitForEvent('dialog').then(async dialog => {
        expect(dialog.type()).toBe('confirm');
        await dialog.accept();
    });
    await remove.tap();
    await accepted;
    await expect(row).toHaveCount(0);
});
