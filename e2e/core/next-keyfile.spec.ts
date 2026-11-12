import { test, expect, type Page } from '@playwright/test';
import * as kdbxweb from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const secret = 'password plus key';
const title = 'Key-file protected record';
const keyPayload = (key: Uint8Array, name = 'vault.keyx') => ({
    name, mimeType: 'application/octet-stream', buffer: Buffer.from(key)
});

async function fixture(password: string | null) {
    kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    const key = await kdbxweb.Credentials.createRandomKeyFile(2);
    const credentials = new kdbxweb.Credentials(password === null ? null : kdbxweb.ProtectedValue.fromString(password), key);
    const db = kdbxweb.Kdbx.create(credentials, 'Key file vault');
    const entry = db.createEntry(db.groups[0]);
    entry.fields.set('Title', title);
    entry.fields.set('UserName', 'key-file-user');
    return { key, file: { name: 'key-file-vault.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) } };
}

async function upload(page: Page, file: Awaited<ReturnType<typeof fixture>>['file']) {
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', file);
    await expect(page.locator('#password')).toBeVisible();
}

async function selectKey(page: Page, key: Uint8Array, name = 'vault.keyx') {
    await page.setInputFiles('#unlock-key-file', keyPayload(key, name));
    await expect(page.getByRole('button', { name: `Key file: ${name}`, exact: true })).toBeVisible();
}

async function expectRejected(page: Page) {
    await page.locator('#unlock').click();
    await expect(page.locator('#unlock-error')).toHaveText('Wrong password', { timeout: 30_000 });
    await expect(page.locator('.entry-row')).toHaveCount(0);
    await expect(page.locator('#password')).toBeEnabled();
}

test('password plus key file rejects missing/wrong credentials, opens with the correct key and reopens from cache', async ({ page }) => {
    test.setTimeout(90_000);
    const data = await fixture(secret);
    const wrongKey = await kdbxweb.Credentials.createRandomKeyFile(2);
    await upload(page, data.file);
    await page.locator('#password').fill(secret);
    await expectRejected(page);
    await selectKey(page, wrongKey, 'wrong.keyx');
    await expectRejected(page);
    await selectKey(page, data.key);
    await page.locator('#password').fill('wrong password');
    await expectRejected(page);
    await page.locator('#password').fill(secret);
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('#password')).toBeVisible();
    await page.reload();
    await page.locator('#password').fill(secret);
    await selectKey(page, data.key);
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout: 30_000 });
    await page.locator('.entry-row').filter({ hasText: title }).click();
    await expect(page.locator('[data-field="user"] .field__value')).toHaveText('key-file-user');
});

test('key-only vault opens and reopens with an empty password', async ({ page }) => {
    const data = await fixture(null);
    await upload(page, data.file);
    await expect(page.locator('#password')).toHaveValue('');
    await expectRejected(page);
    await selectKey(page, data.key);
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('#password')).toBeVisible();
    await page.reload();
    await expect(page.locator('#password')).toHaveValue('');
    await selectKey(page, data.key);
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout: 30_000 });
});

test.describe('touch key-file controls', () => {
    test.use({ hasTouch: true, viewport: { width: 320, height: 740 } });
    test('long key filename stays within the 320px unlock card and can be removed and reselected', async ({ page }) => {
        const data = await fixture(secret);
        const name = `${'long-key-filename-'.repeat(10)}.keyx`;
        await upload(page, data.file);
        const choose = async () => {
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', { name: 'Use a key file', exact: true }).tap();
            await (await chooser).setFiles(keyPayload(data.key, name));
            await expect(page.getByRole('button', { name: `Key file: ${name}`, exact: true })).toBeVisible();
        };
        await choose();
        for (const selector of ['.start', '.start__main', '.card', '.unlock-key-file']) {
            const panel = page.locator(selector);
            expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        }
        for (const button of await page.locator('.unlock-key-file button').all()) {
            const box = (await button.boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(321);
        }
        await page.getByRole('button', { name: 'Remove key file', exact: true }).tap();
        await expect(page.getByRole('button', { name: `Key file: ${name}`, exact: true })).toHaveCount(0);
        await choose();
        await page.locator('#password').fill(secret);
        await page.locator('#unlock').tap();
        await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout: 30_000 });
    });
});
