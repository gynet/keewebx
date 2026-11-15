import { activateEntryAction } from '../entry-actions';
import { test, expect } from '@playwright/test';
import { open, download, find, kdbx, back, browse, password, timeout } from './presentation-lifecycle-fixture';

for (const width of [1280, 320]) for (const trash of [true, false]) {
    test(`template deletion cancel and ${trash ? 'trash restore' : 'permanent deletion'} preserve created entries at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 }); const source = await open(page, trash);
        await page.getByRole('button', { name: 'Entry templates…', exact: true }).click();
        let list = page.getByRole('dialog', { name: 'Entry templates', exact: true });
        await list.getByRole('button', { name: 'Delete template…', exact: true }).click();
        let confirm = page.getByRole('dialog', { name: 'Delete template', exact: true });
        await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(list.getByText('Account template', { exact: true })).toBeVisible();
        await list.getByRole('button', { name: 'Delete template…', exact: true }).click();
        confirm = page.getByRole('dialog', { name: 'Delete template', exact: true });
        await confirm.getByRole('button', { name: trash ? 'Move template to Trash' : 'Delete template permanently', exact: true }).click();
        await expect(list.getByText('No entry templates yet.', { exact: true })).toBeVisible();
        await list.getByRole('button', { name: 'Close', exact: true }).click();
        let db = await download(page);
        expect(find(db, source.clone).fields.get('Title')).toBe('Created instance');
        expect((find(db, source.clone).fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('Reusable!Secret123');
        expect(db.meta.entryTemplatesGroup?.id).toBe(source.templateGroup);
        if (trash) {
            const removed = find(db, source.template);
            expect(removed.parentGroup?.uuid.id).toBe(db.meta.recycleBinUuid?.id); expect(removed.history).toHaveLength(1); expect(removed.binaries.has('proof.bin')).toBe(true);
            await back(page); await browse(page); await page.getByRole('navigation', { name: 'Vault', exact: true }).getByRole('button', { name: 'Trash', exact: true }).click();
            await page.locator('[data-entry="Account template"]').click(); await activateEntryAction(page, 'Restore');
            const restore = page.getByRole('dialog', { name: 'Restore entry to group', exact: true });
            await restore.getByRole('button', { name: 'Restore', exact: true }).click();
            db = await download(page); expect(find(db, source.template).parentGroup?.uuid.id).toBe(source.templateGroup);
            await back(page); if (width < 760 && await page.getByRole('button', { name: 'Back', exact: true }).isVisible()) await page.getByRole('button', { name: 'Back', exact: true }).click();
            await page.getByRole('button', { name: 'Entry templates…', exact: true }).click(); list = page.getByRole('dialog', { name: 'Entry templates', exact: true });
            await expect(list.getByText('Account template', { exact: true })).toBeVisible();
        } else {
            expect(find(db, source.template)).toBeUndefined(); expect(db.deletedObjects.some(object => object.uuid.id === source.template)).toBe(true);
        }
    });
}
test('idle locking cancels template deletion without deleting the template', async ({ page }) => {
    await page.clock.install(); const source = await open(page, false);
    await page.getByRole('button', { name: 'Entry templates…', exact: true }).click();
    await page.getByRole('button', { name: 'Delete template…', exact: true }).click();
    await page.clock.fastForward(16 * 60_000); await expect(page.locator('#password')).toBeVisible({ timeout });
    await expect(page.getByRole('dialog', { name: 'Delete template', exact: true })).toHaveCount(0);
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    const db = await download(page); expect(find(db, source.template).parentGroup?.uuid.id).toBe(source.templateGroup);
});
