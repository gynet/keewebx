import { activateVaultUtility } from './vault-utilities';
import { test, expect } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

for (const width of [1280, 320]) test(`10,000 encrypted entries remain reachable at ${width}px`, async ({ page }) => {
    test.setTimeout(180_000);
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const password = 'Large fixture password';
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Large vault');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const groups = Array.from({ length: 20 }, (_, index) => {
        const parent = db.createGroup(db.getDefaultGroup(), `Parent ${index}`);
        return db.createGroup(parent, `Nested ${index}`);
    });
    for (let index = 0; index < 10_000; index++) {
        const entry = db.createEntry(groups[index % groups.length]);
        entry.fields.set('Title', `Entry ${String(index).padStart(5, '0')}`);
        entry.fields.set('UserName', `user-${index}`); entry.fields.set('URL', `https://example.com/account/${index}`);
        entry.fields.set('Password', kdbx.ProtectedValue.fromString(`large-secret-${index}`));
    }
    await page.setViewportSize({ width, height: 900 }); await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'large.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) });
    await page.locator('#password').fill(password);
    const opened = Date.now(); await page.locator('#unlock').click();
    await expect(page.locator('.list__meta')).toHaveText('10000 items', { timeout: 30_000 });
    await expect(page.locator('.entry-row')).toHaveCount(200);
    const openMs = Date.now() - opened; expect(openMs).toBeLessThan(30_000);
    await activateVaultUtility(page, 'Settings');
    await page.getByLabel('Show entries as a table on desktop', { exact: true }).check();
    await page.getByRole('button', { name: 'Back to vault', exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole('table', { name: 'Entries table' })).toHaveCount(width > 900 ? 1 : 0);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.locator('.entry-row').first()).toHaveAttribute('data-entry', 'Entry 00200');
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(page.locator('.entry-row').first()).toHaveAttribute('data-entry', 'Entry 00000');
    const started = Date.now();
    await page.locator('.entry-row').first().focus(); await page.keyboard.press('End');
    await expect(page.locator('#entry-title')).toHaveText('Entry 09999', { timeout: 15_000 });
    const selectMs = Date.now() - started; expect(selectMs).toBeLessThan(15_000);
    if (width === 320) await page.getByRole('button', { name: 'Back', exact: true }).click();
    const lastRow = page.locator('.entry-row[data-entry="Entry 09999"]');
    if (width === 320) await lastRow.scrollIntoViewIfNeeded();
    await expect(lastRow).toBeInViewport();
    await page.locator('#search').fill('Entry 09999');
    await expect(page.locator('.entry-row')).toHaveCount(1, { timeout: 15_000 });
    await lastRow.click(); await expect(page.locator('#entry-title')).toHaveText('Entry 09999');
    await expect(page.locator('body')).not.toContainText('large-secret-9999');
    await page.screenshot({ path: test.info().outputPath(`large-last-${width}.png`) });
    if (width === 320) await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.locator('#search').fill(''); await expect(page.locator('.list__meta')).toHaveText('10000 items', { timeout: 15_000 });
    await expect(page.locator('.entry-row')).toHaveCount(200);
    await page.locator('.entry-row').first().focus(); await page.keyboard.press('Home');
    await expect(page.locator('#entry-title')).toHaveText('Entry 00000', { timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await test.info().attach('responsiveness.json', { body: JSON.stringify({ count: 10_000, width, openMs, selectMs, budgets: { openMs: 30_000, selectMs: 15_000 } }), contentType: 'application/json' });
});
