import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

test.skip(({ browserName }) => browserName !== 'chromium', 'Actual clipboard read/write permissions are required');
const master = 'Disposable clipboard expiry master';
const secret = 'Disposable clipboard expiry secret';
const title = 'Clipboard expiry entry';

async function open(page: Page) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(master)), 'Clipboard expiry');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', title);
    entry.fields.set('UserName', 'fixture-user');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString(secret));
    entry.fields.set('Protected custom', kdbx.ProtectedValue.fromString('Custom fixture value'));
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'clipboard-expiry.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) });
    await unlock(page);
}

async function unlock(page: Page) {
    await page.locator('#password').fill(master);
    await page.locator('#unlock').click();
    await page.locator('.entry-row').filter({ hasText: title }).click();
}


async function configure(page: Page, seconds: number) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Security', exact: true }).click();
    await page.locator('#setting-clipboard').selectOption(String(seconds));
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
}
async function copyPassword(page: Page) {
    await page.locator('[data-field="password"]').getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
}
test('clipboard expiry clears the original password without a further user gesture', async ({ page }) => {
    await page.clock.install(); await open(page); await configure(page, 10); await copyPassword(page);
    await page.clock.fastForward(11_000);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('');
});
test('clipboard expiry preserves text copied later outside the vault', async ({ page }) => {
    await page.clock.install(); await open(page); await configure(page, 10); await copyPassword(page);
    await page.evaluate(() => navigator.clipboard.writeText('Unrelated disposable user text'));
    await page.clock.fastForward(11_000);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Unrelated disposable user text');
});
test('clipboard expiry Off keeps the copied value', async ({ page }) => {
    await page.clock.install(); await open(page); await configure(page, 0); await copyPassword(page);
    await page.clock.fastForward(61_000);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
});
test('clipboard expiry read denial cannot erase newer clipboard data or raise an unhandled error', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.clock.install(); await open(page); await configure(page, 10); await copyPassword(page);
    await page.evaluate(() => {
        (window as any).__nativeClipboardRead = navigator.clipboard.readText.bind(navigator.clipboard);
        navigator.clipboard.readText = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
        return navigator.clipboard.writeText('Unrelated disposable user text');
    });
    await page.clock.fastForward(11_000);
    expect(await page.evaluate(() => (window as any).__nativeClipboardRead())).toBe('Unrelated disposable user text');
    expect(errors).toEqual([]);
});
