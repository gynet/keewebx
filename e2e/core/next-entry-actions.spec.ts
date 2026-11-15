import { expect, test } from '@playwright/test';
import { activateEntryAction } from '../entry-actions';

for (const width of [320, 390, 1280]) test.describe(`Entry actions at ${width}px`, () => {
    test.use({ viewport: { width, height: 740 }, hasTouch: width < 400 });
    test('two top actions; bounded overflow, dismissal and child History retain focus', async ({ page }) => {
        const touch = width < 400;
        const activate = (button: ReturnType<typeof page.getByRole>) => touch ? button.tap() : button.click();
        await page.goto('/next.html');
        await page.locator('#open-demo').click();
        await page.locator('.entry-row[data-entry="GitHub"]').click();
        const top = page.locator('.entry-detail__actions');
        const more = page.getByRole('button', { name: 'More actions', exact: true });
        const actions = page.getByRole('group', { name: 'Entry actions', exact: true });
        const panel = page.locator('[role="group"][aria-label="Entry actions"]');
        const history = page.getByRole('dialog', { name: 'Entry history', exact: true });
        const assertBounded = async () => {
            await expect(actions).toBeVisible();
            await expect(more).toHaveAttribute('aria-expanded', 'true');
            await expect.poll(async () => {
                const box = await panel.boundingBox();
                return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 740;
            }).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        };
        await expect(top.getByRole('button').filter({ visible: true })).toHaveCount(2);
        await expect(top.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
        await expect(more).toHaveAttribute('aria-expanded', 'false');
        await expect(actions).toBeHidden();
        for (const name of ['History', 'Clone…', 'Move…', 'Recycle', 'Share password…', 'Download website icon…', 'Show empty fields']) {
            await expect(page.getByRole('button', { name, exact: true })).toBeHidden();
        }

        await more.focus();
        await page.keyboard.press('ArrowDown');
        await assertBounded();
        await expect(actions.getByRole('button', { name: 'Close actions', exact: true })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(actions).toBeHidden();
        await expect(more).toBeFocused();

        await activate(more);
        await assertBounded();
        await page.locator('#entry-title').click();
        await expect(actions).toBeHidden();
        await expect(more).toHaveAttribute('aria-expanded', 'false');

        await activate(more);
        await assertBounded();
        await activate(actions.getByRole('button', { name: 'Close actions', exact: true }));
        await expect(actions).toBeHidden();
        await expect(more).toBeFocused();

        await activateEntryAction(page, 'History', touch);
        await expect(history).toBeVisible();
        await expect(more).toHaveAttribute('aria-expanded', 'true');
        await activate(history.getByRole('button', { name: 'Close History', exact: true }));
        await expect(history).toBeHidden();
        await assertBounded();
        await expect(actions.getByRole('button', { name: 'History', exact: true })).toBeFocused();
        await activateEntryAction(page, 'History', touch);
        await page.keyboard.press('Escape');
        await expect(history).toBeHidden();
        await assertBounded();
        await expect(actions.getByRole('button', { name: 'History', exact: true })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(actions).toBeHidden();
        await expect(more).toBeFocused();

        await activateEntryAction(page, 'Show empty fields', touch);
        await expect(actions.getByRole('button', { name: 'Hide empty fields', exact: true })).toBeVisible();
        await activateEntryAction(page, 'Hide empty fields', touch);
        await more.focus();
        await page.keyboard.press('Shift+Tab');
        await expect(actions).toBeHidden();
        await expect(top.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();

        await activate(top.getByRole('button', { name: 'Edit', exact: true }));
        const editor = page.locator('.entry-editor');
        await expect(editor.getByRole('button', { name: 'History', exact: true })).toBeVisible();
        await expect(more).toHaveCount(0);
        await activateEntryAction(page, 'History', touch);
        await expect(history).toBeVisible();
        await activate(history.getByRole('button', { name: 'Close History', exact: true }));
        await expect(editor.getByRole('button', { name: 'History', exact: true })).toBeFocused();
    });
});
