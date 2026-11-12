import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

test.skip(({ browserName }) => browserName !== 'chromium', 'Actual clipboard read/write permissions are required');
const master = 'Disposable copy policy master';
const secret = 'Disposable copied password';
const title = 'Copy policy entry';

async function open(page: Page) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(master)), 'Copy policy');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', title);
    entry.fields.set('UserName', 'fixture-user');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString(secret));
    entry.fields.set('Protected custom', kdbx.ProtectedValue.fromString('Custom fixture value'));
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'copy-policy.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) });
    await unlock(page);
}

async function unlock(page: Page) {
    await page.locator('#password').fill(master);
    await page.locator('#unlock').click();
    await page.locator('.entry-row').filter({ hasText: title }).click();
}

async function setting(page: Page, enabled: boolean) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Lock after copying a password', { exact: true }).setChecked(enabled);
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
}

async function copy(page: Page, field: string) {
    await page.locator(`[data-field="${field}"]`).getByRole('button', { name: 'Copy', exact: true }).click();
}

for (const [width, theme] of [[1280, 'light'], [320, 'dark']] as const) {
    test(`${width}px ${theme}: only password copy locks, preserving notes and the persisted preference`, async ({ page }) => {
        await page.setViewportSize({ width, height: 700 });
        await page.emulateMedia({ colorScheme: theme });
        await page.clock.install();
        await open(page);
        await setting(page, true);
        await page.reload();
        await unlock(page);
        for (const field of ['user', 'field:Protected custom']) {
            await copy(page, field);
            await page.clock.fastForward(2500);
            await expect(page.locator('#entry-title')).toHaveText(title);
        }
        const notes = page.getByRole('region', { name: 'Notes', exact: true });
        await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
        await notes.getByRole('textbox', { name: 'Notes', exact: true }).fill('Draft saved before copy lock');
        await copy(page, 'password');
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
        await page.clock.fastForward(2500);
        await expect(page.locator('#password')).toBeVisible();
        await page.reload();
        await unlock(page);
        await expect(notes.locator('.notes')).toHaveText('Draft saved before copy lock');
        await setting(page, false);
        await copy(page, 'password');
        await page.clock.fastForward(2500);
        await expect(page.locator('#entry-title')).toHaveText(title);
    });
}

test('copying the historical Password follows the same lock policy', async ({ page }) => {
    await page.clock.install();
    await open(page); await setting(page, true);
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: 'Copy Password', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
    await page.clock.fastForward(2500);
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy Password', exact: true })).toHaveCount(0);
});

test('a rejected clipboard write does not lock the vault', async ({ page }) => {
    await page.clock.install();
    await open(page); await setting(page, true);
    await page.evaluate(() => {
        navigator.clipboard.writeText = async () => { throw new DOMException('Simulated write denial', 'NotAllowedError'); };
    });
    await copy(page, 'password');
    await page.clock.fastForward(2500);
    await expect(page.locator('#entry-title')).toHaveText(title);
    await expect(page.locator('[data-field="password"]').getByRole('button', { name: 'Copied', exact: true })).toHaveCount(0);
});

test('a held clipboard write finishing after reauthentication cannot lock the new session', async ({ page }) => {
    await page.clock.install();
    await open(page); await setting(page, true);
    await page.evaluate(() => {
        const write = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async text => {
            await new Promise<void>(resolve => { (window as any).__releaseCopy = resolve; });
            await write(text);
            (window as any).__copyWritten = true;
        };
    });
    await copy(page, 'password');
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseCopy)).toBe('function');
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('#password')).toBeVisible();
    await unlock(page);
    await page.evaluate(() => (window as any).__releaseCopy());
    await expect.poll(() => page.evaluate(() => (window as any).__copyWritten)).toBe(true);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
    await page.clock.fastForward(2500);
    await expect(page.locator('#entry-title')).toHaveText(title);
});
