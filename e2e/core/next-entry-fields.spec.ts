import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'Entry fields disposable vault';
const multiline = 'first line\nsecond line\n最后一行';
const reference = '{REF:U@T:Source}';
async function open(page: Page) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Fields');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    db.meta.defaultUser = 'default-user';
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', 'Field lifecycle');
    entry.fields.set('UserName', kdbx.ProtectedValue.fromString(reference));
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Disposable password'));
    entry.fields.set('Private multiline', kdbx.ProtectedValue.fromString(multiline));
    entry.fields.set('Notes', 'Original notes');
    entry.fields.set('URL', 'https://example.com/account');
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'Fields.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) });
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await page.locator('.entry-row').filter({ hasText: 'Field lifecycle' }).click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });
}
async function decryptDownload(page: Page) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const stream = await (await download).createReadStream();
    if (!stream) throw new Error('No encrypted export');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    return { bytes, db: await kdbx.Kdbx.load(new Uint8Array(bytes).buffer,
        new kdbx.Credentials(kdbx.ProtectedValue.fromString(password))) };
}

test.setTimeout(90_000);
test.use({ timezoneId: 'UTC' });
for (const width of [1280, 320]) test(`expiry and protected multiline fields survive encrypted reopen at ${width}px`, async ({ page, browser }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page);
    const custom = page.locator('[data-field="field:Private multiline"]');
    await expect(custom.locator('.field__value')).toContainText('••');
    await custom.getByRole('button', { name: 'Show Private multiline', exact: true }).click();
    await expect(custom.locator('.field__value')).toHaveText(multiline);
    await custom.getByRole('button', { name: 'Hide Private multiline', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = page.locator('.entry-editor');
    const field = form.locator('.entry-editor__custom-row').first();
    await expect(field.getByLabel('Multiline', { exact: true })).toBeChecked();
    await field.getByRole('button', { name: 'Show field', exact: true }).click();
    await expect(field.getByLabel('Field value', { exact: true })).toHaveValue(multiline);
    await field.getByLabel('Field value', { exact: true }).fill(multiline + '\nSaved');
    await form.getByLabel('Expires', { exact: true }).fill('2032-06-15T14:30:20');
    await form.getByLabel('Notes', { exact: true }).fill('Changed notes');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.entry-metadata')).toContainText('2032');
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });
    const { bytes, db } = await decryptDownload(page);
    const entry = db.getDefaultGroup().entries[0];
    expect(entry.fields.get('UserName')).toBeInstanceOf(kdbx.ProtectedValue);
    expect((entry.fields.get('UserName') as kdbx.ProtectedValue).getText()).toBe(reference);
    expect((entry.fields.get('Private multiline') as kdbx.ProtectedValue).getText()).toBe(multiline + '\nSaved');
    expect(entry.times.expires).toBe(true);
    expect(entry.times.expiryTime?.toISOString()).toBe('2032-06-15T14:30:20.000Z');
    const context = await browser.newContext({ timezoneId: 'UTC' });
    try {
        const fresh = await context.newPage();
        await fresh.goto(new URL('/next.html', page.url()).href);
        await fresh.locator('#open-file-input').setInputFiles({ name: 'Fields.kdbx', mimeType: 'application/octet-stream', buffer: bytes });
        await fresh.locator('#password').fill(password); await fresh.locator('#unlock').click();
        await fresh.locator('.entry-row').first().click();
        await fresh.getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(fresh.getByLabel('Expires', { exact: true })).toHaveValue('2032-06-15T14:30:20');
        await fresh.getByLabel('Expires', { exact: true }).fill('');
        await fresh.getByLabel('Protect Username', { exact: true }).uncheck();
        await fresh.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
        const cleared = await decryptDownload(fresh);
        expect(cleared.db.getDefaultGroup().entries[0].times.expires).toBe(false);
        expect(cleared.db.getDefaultGroup().entries[0].fields.get('UserName')).toBe(reference);
    } finally { await context.close(); }
});

test('cancel retains expiry and fields; a new entry starts with the database default username', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = page.locator('.entry-editor');
    await form.getByLabel('Expires', { exact: true }).fill('2031-01-02T03:04');
    await form.getByLabel('Protect Username', { exact: true }).uncheck();
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.entry-metadata')).toContainText('Never');
    await page.getByRole('button', { name: 'New entry', exact: true }).click();
    await expect(form.getByLabel('Username', { exact: true })).toHaveValue('default-user');
    await form.getByLabel('Title', { exact: true }).fill('Created with defaults');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    const { db } = await decryptDownload(page);
    expect(db.getDefaultGroup().entries.find(entry => entry.fields.get('Title') === 'Created with defaults')?.fields.get('UserName')).toBe('default-user');
    const original = db.getDefaultGroup().entries.find(entry => entry.fields.get('Title') === 'Field lifecycle')!;
    expect(original.times.expires).toBeFalsy();
    expect(original.fields.get('UserName')).toBeInstanceOf(kdbx.ProtectedValue);
});
