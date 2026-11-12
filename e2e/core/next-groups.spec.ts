import { test, expect } from '@playwright/test';
import * as kdbxweb from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

test('nested groups expand, filter descendants and retain new entries in the selected child', async ({ page }) => {
    kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('groups password')), 'Nested vault');
    const parent = db.createGroup(db.groups[0], 'Parent');
    const child = db.createGroup(parent, 'Child');
    const leaf = db.createGroup(child, 'Leaf');
    const sibling = db.createGroup(db.groups[0], 'Sibling');
    for (const [group, title] of [[parent, 'Parent entry'], [leaf, 'Leaf entry'], [sibling, 'Sibling entry']] as const) {
        db.createEntry(group).fields.set('Title', title);
    }
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', { name: 'nested.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) });
    await page.fill('#password', 'groups password');
    await page.click('#unlock');
    const nav = page.getByRole('navigation', { name: 'Vault', exact: true });
    const branch = (name: string) => nav.getByRole('button', { name, exact: true });
    await expect(branch('Leaf')).toBeVisible();
    await branch('Collapse Parent').click();
    await expect(branch('Child')).toHaveCount(0);
    await expect(branch('Leaf')).toHaveCount(0);
    await branch('Expand Parent').click();
    await branch('Parent').click();
    await expect(page.locator('.entry-row')).toHaveCount(2);
    await branch('Leaf').click();
    await expect(page.locator('.entry-row')).toHaveCount(1);
    await expect(page.locator('.entry-row')).toContainText('Leaf entry');
    await page.getByRole('button', { name: 'New entry', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Created inside leaf');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.click('#lock');
    await expect(page.locator('#password')).toBeVisible();
    await page.reload();
    await page.fill('#password', 'groups password');
    await page.click('#unlock');
    await branch('Leaf').click();
    await expect(page.locator('.entry-row')).toHaveCount(2);
    await expect(page.locator('.entry-row[data-entry="Created inside leaf"]')).toBeVisible();
    await branch('Sibling').click();
    await expect(page.locator('.entry-row')).toHaveCount(1);
    await expect(page.locator('.entry-row')).toContainText('Sibling entry');
});
