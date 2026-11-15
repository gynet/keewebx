import { test, expect } from '@playwright/test';
import { openGroups, password } from './mobile-group-fixture';

const exact = (name: string) => ({ name, exact: true });

test('opening group actions by keyboard or right click postpones idle lock', async ({ page }) => {
    await page.clock.install();
    await openGroups(page);
    const nav = page.getByRole('navigation', exact('Vault'));
    const group = nav.getByRole('button', exact('Projects'));
    const sheet = page.getByRole('dialog', exact('Groups'));
    await page.clock.fastForward(14 * 60_000);
    await group.press('Shift+F10');
    await expect(sheet).toBeVisible();
    await page.clock.fastForward(2 * 60_000);
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', exact('Close groups')).click();
    await page.clock.fastForward(14 * 60_000);
    await group.click({ button: 'right' });
    await expect(sheet).toBeVisible();
    await page.clock.fastForward(2 * 60_000);
    await expect(sheet).toBeVisible();
    await page.clock.fastForward(16 * 60_000);
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await expect(group).toBeVisible();
    await expect(page.locator('.entry-row')).toHaveCount(46);
});

test('desktop group actions open on hover, right click and keyboard with focus returned to the target', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openGroups(page);
    const nav = page.getByRole('navigation', exact('Vault'));
    const group = nav.getByRole('button', exact('Projects'));
    const trigger = nav.getByRole('button', exact('Manage Projects'));
    const sheet = page.getByRole('dialog', exact('Groups'));
    // No center management panel or always-visible desktop action buttons.
    await expect(page.getByRole('button', exact('New group'))).toHaveCount(0);
    await expect(trigger).toHaveCSS('opacity', '0');
    await group.hover();
    await expect(trigger).toHaveCSS('opacity', '1');
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await trigger.click();
    await expect(sheet.locator('h3')).toHaveText('Projects');
    await expect(sheet.getByRole('button', exact('Rename group'))).toBeVisible();
    const bounds = await sheet.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(440);
    expect(Math.abs(bounds!.x + bounds!.width / 2 - 640)).toBeLessThan(2);
    await page.screenshot({ path: test.info().outputPath('desktop-context-actions.png') });
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Right-click another group while focus remains on Projects: return focus
    // must follow the context target, and opening actions must not filter entries.
    const folder = nav.getByRole('button', exact('Folder 01'));
    await folder.click({ button: 'right' });
    await expect(sheet.locator('h3')).toHaveText('Folder 01');
    await expect(page.locator('.entry-row')).toHaveCount(46);
    await sheet.getByRole('button', exact('Close groups')).click();
    await expect(folder).toBeFocused();

    await group.focus();
    await page.mouse.move(1000, 750);
    await expect(trigger).toHaveCSS('opacity', '1');
    await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(sheet.locator('h3')).toHaveText('Projects');
    await sheet.getByRole('button', exact('Rename group')).click();
    const rename = page.getByRole('dialog', exact('Rename group'));
    await expect(rename.getByLabel('Group name', { exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(rename).toHaveCount(0);
    await expect(sheet.getByRole('button', exact('Rename group'))).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();

    for (const key of ['Shift+F10', 'ContextMenu']) {
        await group.focus();
        await page.keyboard.press(key);
        await expect(sheet.locator('h3')).toHaveText('Projects');
        await expect(sheet.getByRole('button', exact('Group actions'))).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Escape');
        await expect(group).toBeFocused();
    }
    await page.keyboard.press('Shift+F10');
    await sheet.getByRole('button', exact('Show entries')).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.entry-row')).toHaveCount(1);
    await expect(page.locator('#search')).toBeFocused();
});

test.describe('phone contextual group actions', () => {
    test.use({ hasTouch: true, viewport: { width: 320, height: 740 } });
    test('always-visible ellipsis opens actions directly and returns to its navigation target', async ({ page }) => {
        await openGroups(page);
        await page.getByRole('button', exact('Browse vault')).tap();
        const nav = page.getByRole('navigation', exact('Vault'));
        const trigger = nav.getByRole('button', exact('Manage Projects'));
        await expect(trigger).toHaveCSS('opacity', '1');
        const bounds = await trigger.boundingBox();
        // Allow Firefox's subpixel serialization of an exact CSS 44px edge.
        expect(bounds!.width).toBeGreaterThanOrEqual(43.99);
        expect(bounds!.height).toBeGreaterThanOrEqual(43.99);
        await trigger.tap();
        const sheet = page.getByRole('dialog', exact('Groups'));
        await expect(sheet.locator('h3')).toHaveText('Projects');
        await expect(sheet.getByRole('button', exact('Group actions'))).toHaveAttribute('aria-expanded', 'true');
        await expect(sheet.getByRole('button', exact('New group'))).toBeVisible();
        await expect(sheet.getByRole('button', exact('Operations'))).toBeHidden();
        await page.screenshot({ path: test.info().outputPath('phone-context-actions.png') });
        await sheet.getByRole('button', exact('Close groups')).tap();
        await expect(nav).toBeVisible();
        await expect(trigger).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', exact('Browse vault'))).toBeFocused();

        await page.getByRole('button', exact('Browse vault')).tap();
        await trigger.tap();
        await sheet.getByRole('button', exact('Delete group')).tap();
        await page.getByRole('dialog', exact('Move group to trash')).getByRole('button', exact('Recycle')).tap();
        await expect(sheet.locator('h3')).toHaveText('team');
        await sheet.getByRole('button', exact('Close groups')).tap();
        await expect(trigger).toHaveCount(0);
        await expect(page.getByRole('button', exact('Browse vault'))).toBeFocused();
    });
});
