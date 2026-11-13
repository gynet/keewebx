import { test, expect, type Page } from '@playwright/test';
async function start(page: Page) { await page.goto('/next.html'); await page.getByRole('button', {name: 'Example storage', exact: true}).click(); }
async function connect(page: Page, account = 'account') {
    await page.getByLabel('Account', {exact: true}).fill(account);
    await page.getByLabel('Connection password').fill('connection-secret');
    await page.getByRole('button', {name: 'Connect', exact: true}).click();
}
test('registered config errors, nested listing, file filter and parent navigation', async ({page}) => {
    await start(page);
    await page.getByLabel('Account', {exact: true}).fill('account');
    await page.getByLabel('Connection password').fill('wrong');
    await page.getByRole('button', {name: 'Connect', exact: true}).click();
    await expect(page.getByRole('alert')).toHaveText('Connection rejected');
    await connect(page);
    await page.getByRole('button', {name: 'Folder: Folder', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Nested.kdbx'})).toBeVisible();
    await expect(page.getByRole('button', {name: 'notes.txt'})).toHaveCount(0);
    await page.getByLabel('Show other files').check();
    await expect(page.getByRole('button', {name: 'notes.txt'})).toBeVisible();
    await page.getByRole('button', {name: 'Parent folder'}).click();
    await expect(page.getByRole('button', {name: 'Vault.kdbx'})).toBeVisible();
});
test('cancel configuration ignores a delayed callback', async ({page}) => {
    await start(page); await connect(page, 'delayed');
    await page.getByRole('button', {name: 'Cancel', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Example storage', exact: true})).toHaveCount(0);
    await page.waitForTimeout(1200); // Deliberately cross the fixture callback deadline.
    await expect(page.getByRole('button', {name: 'Vault.kdbx'})).toHaveCount(0);
});
test('cancel listing ignores a provider that delivers after cancellation', async ({page}) => {
    await start(page); await connect(page);
    await page.getByRole('button', {name: 'Folder: Pending'}).click();
    await page.getByRole('button', {name: 'Cancel', exact: true}).click();
    await page.waitForTimeout(700); // Deliberately cross the fixture callback deadline.
    await expect(page.getByRole('button', {name: 'Late.kdbx'})).toHaveCount(0);
});
test('selected provider file opens through the ordinary password gate', async ({page}) => {
    await start(page); await connect(page);
    await page.getByRole('button', {name: 'Vault.kdbx'}).click();
    await page.locator('#password').fill('wrong');
    await page.getByRole('button', {name: 'Unlock', exact: true}).click();
    await expect(page.getByRole('alert')).toHaveText('Wrong password');
    await page.locator('#password').fill('demo');
    await page.getByRole('button', {name: 'Unlock', exact: true}).click();
    await expect(page.locator('.entry-row').first()).toBeVisible();
});
