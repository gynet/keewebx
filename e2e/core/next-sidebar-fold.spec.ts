import { test, expect } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'sidebar synthetic';
async function fixture() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Sidebar');
    const parent = db.createGroup(db.groups[0], 'Work');
    const child = db.createGroup(parent, 'Projects');
    db.createEntry(child).fields.set('Title', 'Fold keeps selection');
    return Buffer.from(await db.save());
}

test('desktop rails preserve widths, group expansion, selection and independent preferences across reload and mobile', async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/next.html');
    const start = page.getByRole('complementary', { name: 'Your vaults' });
    const startToggle = start.locator('.sidebar-toggle');
    const startResize = page.getByRole('separator', { name: 'Resize Your vaults panel' });
    await startResize.focus(); await page.keyboard.press('ArrowRight');
    await expect(start).toHaveCSS('width', '370px');
    await startToggle.focus(); await page.keyboard.press('Enter');
    await expect(startToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(start).toHaveCSS('width', '64px');
    await expect(startResize).toBeHidden();
    for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
        await page.screenshot({ path: info.outputPath(`locked-${theme}.png`) });
    }
    await page.reload();
    await expect(startToggle).toHaveAttribute('aria-expanded', 'false');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(startToggle).toBeHidden();
    await expect(page.locator('#open-demo')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await startToggle.focus(); await page.keyboard.press('Space');
    await expect(start).toHaveCSS('width', '370px');
    await page.locator('#open-file-input').setInputFiles({ name: 'sidebar.kdbx', mimeType: 'application/octet-stream', buffer: await fixture() });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row')).toContainText('Fold keeps selection');
    const nav = page.getByRole('navigation', { name: 'Vault', exact: true });
    const toggle = nav.locator('.sidebar-toggle');
    const resize = page.getByRole('separator', { name: 'Resize folders panel' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await resize.focus(); await page.keyboard.press('ArrowRight');
    await expect(nav).toHaveCSS('width', '258px');
    // Expand the root before its child, if the root is initially closed.
    if (!await nav.getByRole('button', { name: 'Expand Work', exact: true }).isVisible()) {
        await nav.locator('.group-branch__toggle').first().click();
    }
    await nav.getByRole('button', { name: 'Expand Work', exact: true }).click();
    const expanded = await page.evaluate(() => localStorage.getItem('expandedGroups'));
    await page.locator('.entry-row').click();
    await toggle.focus(); await page.keyboard.press('Space');
    await expect(nav).toHaveCSS('width', '64px');
    await expect(resize).toBeHidden();
    await expect(page.locator('#vault-sidebar-content')).toBeHidden();
    await expect(page.locator('.detail__title')).toContainText('Fold keeps selection');
    for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
        await page.screenshot({ path: info.outputPath(`unlocked-${theme}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
    await expect(nav).toBeVisible();
    await expect(toggle).toBeHidden();
    await expect(page.locator('#vault-sidebar-content')).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Collapse Work', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(nav).toHaveCSS('width', '64px');
    await toggle.click();
    await expect(nav).toHaveCSS('width', '258px');
    expect(await page.evaluate(() => localStorage.getItem('expandedGroups'))).toBe(expanded);
    await page.setViewportSize({ width: 800, height: 900 });
    expect((await page.locator('.detail').boundingBox())!.width).toBeGreaterThanOrEqual(280);
    await page.setViewportSize({ width: 1440, height: 900 });
    await toggle.click();
    await page.reload();
    await expect(startToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(start).toHaveCSS('width', '370px');
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(nav).toHaveCSS('width', '64px');
    await toggle.click();
    await expect(nav).toHaveCSS('width', '258px');
    await expect(nav.getByRole('button', { name: 'Collapse Work', exact: true })).toBeVisible();
    await resize.dblclick();
    await expect(nav).toHaveCSS('width', '248px');
});

test('malformed and unavailable preference storage does not prevent folding', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('startSidebarWidth', '"bad"');
        localStorage.setItem('startSidebarCollapsed', '{');
        Storage.prototype.setItem = () => { throw new Error('storage denied'); };
    });
    await page.goto('/next.html');
    const side = page.locator('.start__side');
    await expect(side).toHaveCSS('width', '360px');
    await side.locator('.sidebar-toggle').click();
    await expect(side).toHaveCSS('width', '64px');
    await side.locator('.sidebar-toggle').click();
    await expect(side).toHaveCSS('width', '360px');
});
