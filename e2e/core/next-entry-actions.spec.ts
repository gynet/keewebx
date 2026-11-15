import { expect, test } from '@playwright/test';
import { activateEntryAction } from '../entry-actions';

for (const width of [320, 390, 1280]) test.describe(`Entry actions at ${width}px`, () => {
    test.use({ viewport: { width, height: 740 }, hasTouch: width < 400 });
    test('More appearance cancels safely and saves a color that survives refiltering', async ({ page }) => {
        const activate = (button: ReturnType<typeof page.getByRole>) => width < 400 ? button.tap() : button.click();
        await page.goto('next.html');
        await page.locator('#open-demo').click();
        const github = page.locator('.entry-row[data-entry="GitHub"]');
        await activate(github);
        const more = page.getByRole('button', { name: 'More actions', exact: true });
        const actions = page.getByRole('group', { name: 'Entry actions', exact: true });
        const appearance = page.getByRole('dialog', { name: 'Entry appearance', exact: true });
        const color = appearance.getByRole('combobox', { name: 'Color flag', exact: true });
        const headerIcon = page.locator('.entry-icon-trigger');
        const openAppearance = async () => {
            if (!await actions.isVisible()) await activate(more);
            // The header icon has the same name; use the discoverable menu entry.
            await activate(actions.getByRole('button', { name: 'Change icon and color', exact: true }));
            await expect(appearance).toBeVisible();
            await expect(more).toHaveAttribute('aria-expanded', 'true');
        };
        await openAppearance();
        const original = await color.inputValue();
        const saved = original === 'red' ? 'blue' : 'red';
        await color.selectOption(saved);
        await activate(appearance.getByRole('button', { name: 'Cancel', exact: true }));
        await expect(appearance).toBeHidden();
        await expect(headerIcon).toBeFocused();
        await openAppearance();
        await expect(color).toHaveValue(original);
        await page.keyboard.press('Escape');
        await expect(appearance).toBeHidden();
        await expect(headerIcon).toBeFocused();

        await openAppearance();
        await color.selectOption(saved);
        await activate(appearance.getByRole('button', { name: 'Apply appearance', exact: true }));
        await expect(appearance).toBeHidden();
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });
        await expect(page.locator('.detail').getByRole('img', { name: saved === 'red' ? 'Red flag' : 'Blue flag', exact: true })).toBeVisible();
        if (width < 761) await activate(page.getByRole('button', { name: 'Back', exact: true }));
        const filter = page.getByRole('combobox', { name: 'Filter by color', exact: true });
        await filter.selectOption(saved);
        await expect(github).toHaveCount(1);
        await filter.selectOption(saved === 'red' ? 'blue' : 'red');
        await expect(github).toHaveCount(0);
        await filter.selectOption('any');
        await expect(github).toHaveCount(1);
        await activate(github);
        await openAppearance();
        await expect(color).toHaveValue(saved);
        await activate(appearance.getByRole('button', { name: 'Cancel', exact: true }));
        await expect(appearance).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
    test('two top actions; bounded overflow, dismissal and child History retain focus', async ({ page }) => {
        const touch = width < 400;
        const activate = (button: ReturnType<typeof page.getByRole>) => touch ? button.tap() : button.click();
        await page.addInitScript(() => localStorage.setItem('appSettings', JSON.stringify({ hideEmptyFields: true })));
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
        for (const name of ['History', 'Clone…', 'Move to group…', 'Recycle', 'Share password…', 'Show empty fields']) {
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
