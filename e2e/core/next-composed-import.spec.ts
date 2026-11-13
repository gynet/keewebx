import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const picker = (page: Page) => page.getByRole('dialog', { name: 'Open another vault', exact: true });
async function open(page: Page) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles(resolve(__dirname, '../../modules/db/resources/KDBX4.1.kdbx'));
    await page.locator('#password').fill('test'); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toBeVisible();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await picker(page).getByRole('button', { name: 'Import XML or CSV', exact: true }).click();
}
async function choose(page: Page) {
    const chooser = page.waitForEvent('filechooser');
    await picker(page).getByRole('button', { name: 'Choose XML or CSV', exact: true }).click();
    await (await chooser).setFiles({ name: 'Imported.csv', mimeType: 'text/csv',
        buffer: Buffer.from('Title,UserName,Password\nImported entry,import-user,disposable-secret') });
}

test('importing another vault closes its picker and retains both databases', async ({ page }) => {
    await open(page); await choose(page);
    await picker(page).getByLabel('Import master password', { exact: true }).fill('New import password');
    await picker(page).getByLabel('Confirm import password', { exact: true }).fill('New import password');
    await picker(page).getByRole('button', { name: 'Import', exact: true }).click();
    await expect(picker(page)).toHaveCount(0);
    await expect(page.locator('.entry-row').filter({ hasText: 'Imported entry' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    await expect(page.getByRole('form', { name: /^Database settings:/ })).toHaveCount(2);
    await expect(page.getByRole('form', { name: 'Database settings: KDBX4.1', exact: true })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Database settings: Imported', exact: true })).toBeVisible();
});

test('canceling the additional-vault picker revokes an unfinished import read', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
        const read = File.prototype.text;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        (window as any).releaseImport = release;
        File.prototype.text = async function () { const text = await read.call(this); await gate; return text; };
    });
    await choose(page);
    await expect(picker(page).getByRole('status')).toContainText('Preparing import');
    await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(() => (window as any).releaseImport());
    await expect(picker(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    await expect(page.getByRole('form', { name: /^Database settings:/ })).toHaveCount(1);
    await expect(page.getByRole('form', { name: 'Import preview', exact: true })).toHaveCount(0);
});
