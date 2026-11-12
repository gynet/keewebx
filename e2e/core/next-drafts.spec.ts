import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

const fixture = path.resolve(__dirname, '../../packages/db/resources/KDBX4.1.kdbx');

async function unlock(page: Page) {
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', fixture);
    await page.fill('#password', 'test');
    await page.click('#unlock');
    await page.locator('.entry-row').first().click();
}

async function reopen(page: Page) {
    await expect(page.locator('#password')).toBeVisible();
    await page.reload();
    await page.fill('#password', 'test');
    await page.click('#unlock');
    await expect(page.locator('.entry-row').first()).toBeVisible();
}

test('retains entry drafts across settings and saves them before manual lock', async ({ page }) => {
    await unlock(page);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('.entry-editor');
    await editor.getByLabel('Title', { exact: true }).fill('Draft saved on lock');
    await editor.getByLabel('Password', { exact: true }).fill('Draft protected password');
    await page.click('#open-settings');
    await page.click('#settings-back');
    await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('Draft saved on lock');
    await expect(editor.getByLabel('Password', { exact: true })).toHaveValue('Draft protected password');
    await page.click('#lock');
    await reopen(page);
    await page.locator('.entry-row[data-entry="Draft saved on lock"]').click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor.getByLabel('Password', { exact: true })).toHaveValue('Draft protected password');
});

test('warns before discarding notes on entry navigation', async ({ page }) => {
    await page.goto('/next.html');
    await page.click('#open-demo');
    await page.locator('.entry-row[data-entry="GitHub"]').click();
    const notes = page.getByRole('region', { name: 'Notes', exact: true });
    await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
    await notes.getByRole('textbox', { name: 'Notes', exact: true }).fill('Unsaved source');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.locator('.entry-row[data-entry="Amazon"]').click();
    await expect(page.locator('#entry-title')).toHaveText('GitHub');
    await expect(notes.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Unsaved source');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.entry-row[data-entry="Amazon"]').click();
    await expect(page.locator('#entry-title')).toHaveText('Amazon');
});

test('saves a draft before automatic idle lock', async ({ page }) => {
    await page.clock.install();
    await page.addInitScript(() => localStorage.setItem('appSettings', JSON.stringify({ idleMinutes: 1 })));
    await unlock(page);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('.entry-editor').getByLabel('Title', { exact: true }).fill('Idle saved draft');
    await page.clock.fastForward(125_000);
    await expect(page.locator('#password')).toBeVisible({ timeout: 30_000 });
    await reopen(page);
    await expect(page.locator('.entry-row[data-entry="Idle saved draft"]')).toBeVisible();
});
