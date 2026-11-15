import { test, expect } from '@playwright/test';
import { open, download, find, png, back, browse, groupActions, password, timeout } from './presentation-lifecycle-fixture';
for (const width of [1280, 320]) {
    test(`group icons display, cancel, upload, replace and retain shared assets at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 }); const source = await open(page);
        await browse(page); await expect(page.getByRole('navigation', { name: 'Vault', exact: true }).getByRole('button', { name: 'Work', exact: true }).locator('img')).toBeVisible();
        let actions = await groupActions(page); await actions.getByRole('button', { name: 'Group icon…', exact: true }).click();
        let dialog = page.getByRole('dialog', { name: 'Group icon', exact: true });
        await dialog.getByRole('radio', { name: 'Icon: Star', exact: true }).check(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        let db = await download(page); expect(db.getGroup(source.work)?.customIcon?.id).toBe(source.icon);
        await back(page); actions = await groupActions(page); await actions.getByRole('button', { name: 'Group icon…', exact: true }).click();
        dialog = page.getByRole('dialog', { name: 'Group icon', exact: true });
        await dialog.getByLabel('Upload icon', { exact: true }).setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
        await expect(dialog.getByRole('alert')).toContainText('PNG, JPEG, or WebP');
        await dialog.getByLabel('Upload icon', { exact: true }).setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: await png(page) });
        await expect(dialog.getByRole('img', { name: 'New icon preview', exact: true })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`group-icon-${width}.png`), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await dialog.getByRole('button', { name: 'Apply group icon', exact: true }).click();
        db = await download(page); const id = db.getGroup(source.work)!.customIcon!.id;
        expect(id).not.toBe(source.icon); const bytes = Buffer.from(db.meta.customIcons.get(id)!.data!); expect(bytes.readUInt32BE(16)).toBe(128); expect(bytes.readUInt32BE(20)).toBe(41);
        expect(db.getGroup(source.sibling)?.customIcon?.id).toBe(source.icon); expect(find(db, source.entry).customIcon?.id).toBe(source.icon); expect(find(db, source.entry).history).toHaveLength(1);
        expect(Buffer.from(db.meta.customIcons.get(source.icon)!.data!)).toEqual(source.png);
        await page.reload(); await page.locator('#password').fill(password); await page.locator('#unlock').click();
        actions = await groupActions(page); await actions.getByRole('button', { name: 'Group icon…', exact: true }).click();
        dialog = page.getByRole('dialog', { name: 'Group icon', exact: true }); await dialog.getByRole('radio', { name: 'Icon: Star', exact: true }).check();
        await dialog.getByRole('button', { name: 'Apply group icon', exact: true }).click();
        db = await download(page); expect(db.getGroup(source.work)!.customIcon).toBeUndefined(); expect(db.getGroup(source.work)!.icon).toBe(61);
        expect(find(db, source.entry).customIcon?.id).toBe(source.icon); expect(db.meta.customIcons.has(source.icon)).toBe(true);
    });
}
test('idle lock discards a group icon draft and requires authentication', async ({ page }) => {
    await page.clock.install(); const source = await open(page); const actions = await groupActions(page);
    await actions.getByRole('button', { name: 'Group icon…', exact: true }).click();
    await page.getByRole('radio', { name: 'Icon: Star', exact: true }).check();
    await page.clock.fastForward(16 * 60_000); await expect(page.locator('#password')).toBeVisible({ timeout });
    await expect(page.getByRole('dialog', { name: 'Group icon', exact: true })).toHaveCount(0);
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    const db = await download(page); expect(db.getGroup(source.work)?.customIcon?.id).toBe(source.icon);
});

test('group trash and restore retain custom icon and existing entry icons', async ({ page }) => {
    const source = await open(page); const actions = await groupActions(page);
    await actions.getByRole('button', { name: 'Delete group', exact: true }).click();
    await page.getByRole('dialog', { name: 'Move group to trash', exact: true }).getByRole('button', { name: 'Recycle', exact: true }).click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await browse(page); await page.getByRole('navigation', { name: 'Vault', exact: true }).getByRole('button', { name: 'Trash', exact: true }).click();
    const manager = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Manage trash$/ }) });
    if (await manager.getAttribute('open') === null) await manager.locator('summary').click();
    const select = manager.getByRole('combobox', { name: 'Trashed group', exact: true });
    const value = await select.locator('option').filter({ hasText: 'Work' }).getAttribute('value'); await select.selectOption(value!);
    await manager.getByRole('button', { name: 'Restore group', exact: true }).click();
    await page.getByRole('dialog', { name: 'Restore group', exact: true }).getByRole('button', { name: 'Restore', exact: true }).click();
    const db = await download(page); expect(db.getGroup(source.work)?.customIcon?.id).toBe(source.icon);
    expect(db.getGroup(source.work)?.parentGroup?.uuid.id).toBe(db.groups[0].uuid.id);
    expect(find(db, source.entry).customIcon?.id).toBe(source.icon); expect(find(db, source.entry).parentGroup?.uuid.id).toBe(source.work);
});
