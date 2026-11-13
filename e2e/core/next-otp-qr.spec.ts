import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const image = resolve(__dirname, '../fixtures/otp-qr.png');
const invalid = resolve(__dirname, '../fixtures/not-otp-qr.png');
const editor = (page: Page) => page.locator('.entry-editor');
async function open(page: Page) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles(resolve(__dirname, '../../modules/db/resources/KDBX4.1.kdbx'));
    await page.locator('#password').fill('test'); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toBeVisible();
    await page.getByRole('button', { name: 'New entry', exact: true }).click();
    await editor(page).getByLabel('Title', { exact: true }).fill('QR fixture');
}
test.setTimeout(90_000);
for (const width of [1280, 320]) test(`real QR image provisions protected OTP and survives encrypted reopen at ${width}px`, async ({ page, browser }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page);
    await expect(editor(page).getByLabel('OTP QR image', { exact: true })).toHaveAttribute('capture', 'environment');
    await editor(page).getByLabel('OTP QR image', { exact: true }).setInputFiles(image);
    const secret = editor(page).getByLabel('OTP secret or otpauth URL', { exact: true });
    await expect(secret).toHaveValue(/secret=JBSWY3DPEHPK3PXP/);
    await expect(secret).toHaveAttribute('type', 'password');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('[data-field="otp"] .field__value')).toHaveText(/\d{3} \d{3}/);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const stream = await (await pending).createReadStream(); if (!stream) throw new Error('No encrypted file');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString('test')));
    const entry = [...db.getDefaultGroup().allEntries()].find(entry => entry.fields.get('Title') === 'QR fixture')!;
    expect(entry.fields.get('otp')).toBeInstanceOf(kdbx.ProtectedValue);
    expect((entry.fields.get('otp') as kdbx.ProtectedValue).getText()).toContain('secret=JBSWY3DPEHPK3PXP');
    const context = await browser.newContext();
    try {
        const fresh = await context.newPage(); await fresh.goto(new URL('/next.html', page.url()).href);
        await fresh.locator('#open-file-input').setInputFiles({ name: 'QR.kdbx', mimeType: 'application/octet-stream', buffer: bytes });
        await fresh.locator('#password').fill('test'); await fresh.locator('#unlock').click();
        await fresh.locator('.entry-row').filter({ hasText: 'QR fixture' }).click();
        await expect(fresh.locator('[data-field="otp"] .field__value')).toHaveText(/\d{3} \d{3}/);
    } finally { await context.close(); }
});

test('non-OTP QR images and canceled scans do not change the staged configuration', async ({ page }) => {
    await open(page);
    await editor(page).getByRole('button', { name: 'Set up OTP', exact: true }).click();
    const secret = editor(page).getByLabel('OTP secret or otpauth URL', { exact: true });
    await secret.fill('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    await editor(page).getByLabel('OTP QR image', { exact: true }).setInputFiles(invalid);
    await expect(editor(page).getByRole('alert')).toContainText('does not contain an otpauth URL');
    await expect(secret).toHaveValue('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    await page.evaluate(() => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
        Object.defineProperty(HTMLImageElement.prototype, 'src', { ...descriptor, set(value: string) {
            if (value.startsWith('blob:')) (window as any).releaseQrImage = () => descriptor.set!.call(this, value);
            else descriptor.set!.call(this, value);
        } });
    });
    await editor(page).getByLabel('OTP QR image', { exact: true }).setInputFiles(image);
    await expect(editor(page).getByRole('button', { name: 'Reading QR image…', exact: true })).toBeVisible();
    await secret.fill('JBSWY3DPEHPK3PXP');
    await page.evaluate(() => (window as any).releaseQrImage());
    await expect(editor(page).getByRole('button', { name: 'Scan QR image', exact: true })).toBeEnabled();
    await expect(secret).toHaveValue('JBSWY3DPEHPK3PXP');
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.entry-row').filter({ hasText: 'QR fixture' })).toHaveCount(0);
});

test('HOTP counter zero has the reference code and no time-based countdown', async ({ page }) => {
    await open(page);
    await editor(page).getByRole('button', { name: 'Set up OTP', exact: true }).click();
    await editor(page).getByLabel('OTP secret or otpauth URL', { exact: true }).fill(
        'otpauth://hotp/fixture?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=0');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('[data-field="otp"] .field__value')).toHaveText('755 224');
    await expect(page.locator('[data-field="otp"]')).toContainText('does not advance its counter');
    await expect(page.locator('[data-field="otp"]')).not.toContainText(/\b\d+ s\b/);
});
