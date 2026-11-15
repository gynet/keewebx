import { activateVaultUtility } from './vault-utilities';
import { test, expect, type Locator } from '@playwright/test';
import { openGroups, password, kdbx } from './mobile-group-fixture';

test.use({ hasTouch: true });
const exact = (name: string) => ({ name, exact: true });
async function targetSize(target: Locator) {
    const box = await target.boundingBox();
    // Firefox may report 44 CSS pixels as 43.999969 after scrolling.
    expect(Math.round(box!.height * 1000) / 1000).toBeGreaterThanOrEqual(44);
    expect(Math.round(box!.width * 1000) / 1000).toBeGreaterThanOrEqual(44);
}
for (const width of [320, 390]) {
    test(`phone groups drill down, scroll and return focus at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 740 }); await openGroups(page);
        await page.getByRole('button', exact('Browse vault')).tap();
        await page.getByRole('navigation', exact('Vault')).getByRole('button', exact('Manage groups')).tap();
        const sheet = page.getByRole('dialog', exact('Groups'));
        await expect(sheet).toBeVisible();
        await expect(sheet.getByRole('button', exact('New group'))).toBeHidden();
        await expect(sheet.getByRole('button', exact('Recycle Bin'))).toHaveCount(0);
        await page.screenshot({ path: test.info().outputPath(`browse-${width}.png`) });
        await sheet.getByRole('button', { name: /Folder 31/ }).tap();
        await page.screenshot({ path: test.info().outputPath(`long-name-${width}.png`) });
        await sheet.getByRole('button', exact('Parent group')).tap();
        await sheet.getByRole('button', exact('Folder 45')).tap();
        await expect(sheet.locator('h3')).toHaveText('Folder 45');
        await sheet.getByRole('button', exact('Parent group')).tap();
        for (const name of ['Projects', 'Operations', 'Europe', 'Customer accounts', 'Production', 'Access and recovery']) {
            const row = sheet.getByRole('button', exact(name)); await targetSize(row); await row.tap();
        }
        await expect(sheet.locator('.phone-groups__path')).toContainText('Projects / Operations / Europe / Customer accounts / Production / Access and recovery');
        await page.screenshot({ path: test.info().outputPath(`deep-${width}.png`) });
        await sheet.getByRole('button', exact('Group actions')).tap();
        await page.screenshot({ path: test.info().outputPath(`actions-${width}.png`) });
        for (const name of ['New group', 'Rename group', 'Delete group', 'Move group', 'Group icon…']) await targetSize(sheet.getByRole('button', exact(name)));
        await sheet.getByRole('button', exact('Delete group')).tap();
        const deletion = page.getByRole('dialog', exact('Move group to trash'));
        await deletion.getByRole('button', exact('Cancel')).tap();
        await expect(sheet.getByRole('button', exact('Delete group'))).toBeFocused();
        await sheet.getByRole('button', exact('Show entries')).tap();
        await expect(sheet).toHaveCount(0);
        await expect(page.locator('.entry-row')).toHaveCount(1);
        await expect(page.locator('.entry-row')).toContainText('Recovery account');
        await page.getByRole('button', exact('Browse vault')).tap();
        const nav = page.getByRole('navigation', exact('Vault'));
        await targetSize(nav.getByRole('button', exact('Expand Projects')));
        for (const name of ['Projects', 'Operations', 'Europe', 'Customer accounts', 'Production']) {
            const toggle = nav.getByRole('button', exact(`Expand ${name}`)); await targetSize(toggle); await toggle.tap();
        }
        await targetSize(nav.getByRole('button', exact('Access and recovery')));
        await page.screenshot({ path: test.info().outputPath(`tree-${width}.png`) });
        await nav.getByRole('button', exact('Manage Access and recovery')).tap();
        await expect(sheet.locator('h3')).toHaveText('Access and recovery');
        await expect(sheet.getByRole('button', exact('Group actions'))).toHaveAttribute('aria-expanded', 'true');
        await sheet.getByRole('button', exact('Close groups')).tap();
        await expect(nav).toBeVisible();
        await expect(nav.getByRole('button', exact('Manage Access and recovery'))).toBeFocused();
        expect(await page.locator('#search').evaluate(element => !!element.closest('[inert]'))).toBe(true);
        await nav.getByRole('button', exact('Collapse Projects')).tap();
        await expect(nav.getByRole('button', exact('Operations'))).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', exact('Browse vault'))).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
    test(`phone group create rename move icon and encrypted reopen at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 740 }); const source = await openGroups(page);
        await page.getByRole('button', exact('Browse vault')).tap();
        await page.getByRole('navigation', exact('Vault')).getByRole('button', exact('Manage groups')).tap();
        const sheet = page.getByRole('dialog', exact('Groups'));
        await sheet.getByRole('button', exact('Projects')).tap();
        await sheet.getByRole('button', exact('Group actions')).tap();
        await sheet.getByRole('button', exact('New group')).tap();
        let edit = page.getByRole('dialog', exact('New group'));
        await edit.getByRole('textbox').fill('Phone subgroup');
        // A reduced visual viewport keeps the keyboard-era dialog actions reachable.
        await page.setViewportSize({ width, height: 430 });
        await edit.getByRole('button', exact('Create group')).tap();
        await page.setViewportSize({ width, height: 740 });
        await expect(sheet.locator('h3')).toHaveText('Phone subgroup');
        await sheet.getByRole('button', exact('Group actions')).tap();
        await sheet.getByRole('button', exact('Rename group')).tap();
        edit = page.getByRole('dialog', exact('Rename group'));
        await edit.getByRole('textbox').fill('Renamed from phone');
        await edit.getByRole('button', exact('Save name')).tap();
        await expect(sheet.locator('h3')).toHaveText('Renamed from phone');
        await sheet.getByRole('button', exact('Group icon…')).tap();
        const icon = page.getByRole('dialog', exact('Group icon'));
        await icon.getByRole('radio', exact('Icon: Star')).tap();
        await icon.getByRole('button', exact('Apply group icon')).tap();
        await sheet.getByRole('button', exact('Move group')).tap();
        const move = page.getByRole('dialog', exact('Move group'));
        const destination = move.getByRole('combobox', exact('Destination group'));
        const leafOption = destination.locator('option').filter({ hasText: /Access and recovery$/ });
        await destination.selectOption((await leafOption.getAttribute('value'))!);
        await move.getByRole('button', exact('Move')).tap();
        await expect(sheet.locator('.phone-groups__path')).toContainText('Access and recovery / Renamed from phone');
        await page.screenshot({ path: test.info().outputPath(`moved-${width}.png`) });
        await sheet.getByRole('button', exact('Show entries')).tap();
        await expect(page.locator('#sync-state')).toHaveText('Up to date');
        await activateVaultUtility(page, 'Settings', { touch: true });
        await page.getByRole('tab', exact('Database')).tap();
        const pending = page.waitForEvent('download'); await page.getByRole('button', exact('Download KDBX')).tap();
        const stream = await (await pending).createReadStream(); const chunks: Buffer[] = [];
        for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const db = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
        const created = [...db.groups[0].allGroups()].filter(group => group.name === 'Renamed from phone');
        expect(created).toHaveLength(1); expect(created[0].icon).toBe(61); expect(created[0].parentGroup!.uuid.id).toBe(source.leaf);
        const preserved = [...db.groups[0].allEntries()].find(entry => entry.uuid.id === source.entry)!;
        expect(preserved.fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
        expect((preserved.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('Synthetic!Secret789');
        expect(preserved.history).toHaveLength(1);
        const fresh = await page.context().newPage(); await fresh.setViewportSize({ width, height: 740 }); await fresh.goto('/next.html');
        // Import downloaded bytes after clearing browser state: persistence cannot come from live model objects.
        await fresh.evaluate(() => localStorage.clear()); await fresh.reload();
        await fresh.locator('#open-file-input').setInputFiles({ name: 'reopened.kdbx', mimeType: 'application/octet-stream', buffer: bytes });
        await fresh.locator('#password').fill(password); await fresh.locator('#unlock').tap();
        await fresh.getByRole('button', exact('Browse vault')).tap();
        await fresh.getByRole('navigation', exact('Vault')).getByRole('button', exact('Manage groups')).tap();
        const reopened = fresh.getByRole('dialog', exact('Groups'));
        for (const name of ['Projects', 'Operations', 'Europe', 'Customer accounts', 'Production', 'Access and recovery', 'Renamed from phone']) await reopened.getByRole('button', exact(name)).tap();
        await expect(reopened.locator('h3')).toHaveText('Renamed from phone');
        await reopened.getByRole('button', exact('Group actions')).tap();
        await reopened.getByRole('button', exact('Delete group')).tap();
        await fresh.getByRole('dialog', exact('Move group to trash')).getByRole('button', exact('Recycle')).tap();
        await expect(reopened.locator('h3')).toHaveText('Access and recovery');
        await expect(reopened.getByRole('button', exact('Renamed from phone'))).toHaveCount(0);
        await reopened.getByRole('button', exact('Show entries')).tap();
        await expect(fresh.locator('#sync-state')).toHaveText('Up to date');
        await fresh.reload(); await fresh.locator('#password').fill(password); await fresh.locator('#unlock').tap();
        await fresh.getByRole('button', exact('Browse vault')).tap();
        await fresh.getByRole('navigation', exact('Vault')).getByRole('button', exact('Manage groups')).tap();
        for (const name of ['Projects', 'Operations', 'Europe', 'Customer accounts', 'Production', 'Access and recovery']) await reopened.getByRole('button', exact(name)).tap();
        await expect(reopened.getByRole('button', exact('Renamed from phone'))).toHaveCount(0);
        await fresh.close();
    });
}

test('phone group keyboard activity postpones idle lock and nested delete never commits on lock', async ({ page }) => {
    await page.clock.install(); await page.setViewportSize({ width: 320, height: 740 }); await openGroups(page);
    await activateVaultUtility(page, 'Settings', { touch: true });
    await page.getByRole('tab', exact('Security')).tap(); await page.locator('#setting-auto-lock').selectOption('5');
    await page.locator('#settings-back:visible, .settings__phone-back:visible').tap();
    await page.getByRole('button', exact('Browse vault')).tap();
    const nav = page.getByRole('navigation', exact('Vault'));
    await nav.getByRole('button', exact('Manage Projects')).tap();
    const sheet = page.getByRole('dialog', exact('Groups'));
    await page.clock.fastForward(4 * 60_000);
    await sheet.getByRole('button', exact('Group actions')).focus(); await page.keyboard.press('Tab');
    await page.clock.fastForward(2 * 60_000); await expect(sheet).toBeVisible();
    await sheet.getByRole('button', exact('Delete group')).tap();
    await page.clock.fastForward(6 * 60_000);
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await page.locator('#password').fill(password); await page.locator('#unlock').tap();
    await page.getByRole('button', exact('Browse vault')).tap();
    await nav.getByRole('button', exact('Manage Projects')).tap();
    await expect(sheet.locator('h3')).toHaveText('Projects');
    await sheet.getByRole('button', exact('Group actions')).tap();
    await expect(sheet.getByRole('button', exact('Operations'))).toBeVisible();
});

test('phone group draft recovery restores nested dialogs and navigation', async ({ page }) => {
    await page.clock.install(); await page.setViewportSize({ width: 390, height: 740 }); await openGroups(page);
    await page.getByRole('button', exact('Browse vault')).tap();
    await page.getByRole('navigation', exact('Vault')).getByRole('button', exact('Manage Projects')).tap();
    const sheet = page.getByRole('dialog', exact('Groups'));
    await sheet.getByRole('button', exact('New group')).tap();
    const edit = page.getByRole('dialog', exact('New group'));
    await edit.getByLabel('Group name', { exact: true }).fill('   ');
    await page.clock.fastForward(16 * 60_000);
    const recovery = page.getByRole('form', exact('Verify database: team'));
    await expect(recovery).toBeVisible(); await expect(page.locator('dialog[open]')).toHaveCount(0);
    await recovery.getByLabel('Master password', { exact: true }).fill(password);
    await recovery.getByLabel('Master password', { exact: true }).press('Enter');
    await page.getByRole('button', exact('Return to unsaved changes')).tap();
    await expect(edit).toBeVisible(); await expect(edit.getByLabel('Group name', { exact: true })).toHaveValue('   ');
    await edit.getByRole('button', exact('Cancel')).tap();
    await expect(sheet.getByRole('button', exact('New group'))).toBeFocused();
    await sheet.getByRole('button', exact('Show entries')).tap();
    await expect(sheet).toHaveCount(0); await expect(page.locator('.entry-row')).toHaveCount(1);
});
