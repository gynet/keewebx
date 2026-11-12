import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

// Disposable RFC6238 seed; fixtures and downloads are real encrypted KDBX files.
const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const password = 'Disposable OTP test password';
const title = 'OTP lifecycle entry';
const url = `otpauth://totp/Example%3Aalice?secret=${seed}&digits=8`;
const form = (page: Page) => page.locator('.entry-editor');
const code = (page: Page) => page.locator('[data-field="otp"] .field__value');
const timeout = 30_000;
type Legacy = 'raw' | 'KeeOTP' | 'TrayTOTP';

async function fixture(legacy?: Legacy) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'otp-lifecycle');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', title);
    entry.fields.set('Notes', 'Preserved notes');
    if (legacy === 'raw') entry.fields.set('otp', kdbx.ProtectedValue.fromString(seed));
    if (legacy === 'KeeOTP') entry.fields.set('otp', kdbx.ProtectedValue.fromString(`key=${seed}&step=30&size=8`));
    if (legacy === 'TrayTOTP') {
        entry.fields.set('TOTP Seed', kdbx.ProtectedValue.fromString(seed));
        entry.fields.set('TOTP Settings', '30;8');
    }
    return { bytes: Buffer.from(await db.save()), id: entry.uuid.id };
}
async function open(page: Page, bytes: Buffer) {
    await page.goto('/next.html');
    await page.clock.setFixedTime(new Date(59_000));
    await page.locator('#open-file-input').setInputFiles({ name: 'otp-lifecycle.kdbx', mimeType: 'application/octet-stream', buffer: bytes });
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await page.locator('.entry-row').filter({ hasText: title }).click({ timeout });
}
async function edit(page: Page) {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(form(page)).toBeVisible();
    return form(page);
}
async function save(page: Page) {
    await form(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}
async function exportAndRead(page: Page, id: string) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('form', { name: /^Database settings:/ }).getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const download = await downloaded;
    expect(await download.failure()).toBeNull();
    const stream = await download.createReadStream();
    if (!stream) throw new Error('Missing encrypted download');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    expect(bytes.includes(Buffer.from(seed))).toBe(false);
    const db = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer,
        new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
    const entry = [...db.getDefaultGroup().allEntries()].find((entry) => entry.uuid.id === id)!;
    expect(entry).toBeTruthy();
    expect(entry.fields.get('Title')).toBe(title);
    expect(entry.fields.get('Notes')).toBe('Preserved notes');
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    await page.locator('.entry-row').filter({ hasText: title }).click();
    return { bytes, entry };
}
async function screenshot(page: Page, name: string) {
    const path = test.info().outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true });
    await test.info().attach(name, { path, contentType: 'image/png' });
}

test.setTimeout(90_000);

test('manual setup, URL replacement, cancel and removal survive real encrypted download and reopen', async ({ page }) => {
    const source = await fixture(); await open(page, source.bytes);
    let editor = await edit(page);
    await editor.getByRole('button', { name: 'Set up OTP', exact: true }).click();
    await editor.getByLabel('OTP secret or otpauth URL', { exact: true }).fill(seed.toLowerCase());
    await expect(editor.getByLabel('OTP secret or otpauth URL', { exact: true })).toHaveAttribute('type', 'password');
    await editor.getByRole('button', { name: 'Preview OTP code', exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText('Preview code: 287082');
    await save(page); await expect(code(page)).toHaveText('287 082');
    const first = await exportAndRead(page, source.id);
    expect(first.entry.fields.get('otp')).toBeInstanceOf(kdbx.ProtectedValue);
    expect((first.entry.fields.get('otp') as kdbx.ProtectedValue).getText()).toContain(`secret=${seed}`);

    editor = await edit(page);
    await editor.getByRole('button', { name: 'Edit OTP', exact: true }).click();
    await editor.getByLabel('OTP secret or otpauth URL', { exact: true }).fill(url);
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(code(page)).toHaveText('287 082');
    editor = await edit(page);
    await editor.getByRole('button', { name: 'Edit OTP', exact: true }).click();
    await editor.getByLabel('OTP secret or otpauth URL', { exact: true }).fill(url);
    await save(page); await expect(code(page)).toHaveText('942 87082');
    const replaced = await exportAndRead(page, source.id);
    expect((replaced.entry.fields.get('otp') as kdbx.ProtectedValue).getText()).toBe(url);
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('#password')).toBeVisible({ timeout });
    await open(page, replaced.bytes);
    await expect(code(page)).toHaveText('942 87082');
    await screenshot(page, 'otp-encrypted-reopen');

    editor = await edit(page);
    await editor.getByRole('button', { name: 'Remove OTP', exact: true }).click();
    await save(page); await expect(code(page)).toHaveCount(0);
    const removed = await exportAndRead(page, source.id);
    expect(removed.entry.fields.has('otp')).toBe(false);
    expect(removed.entry.history.some((entry) => entry.fields.has('otp'))).toBe(true);
});

test('malformed input cannot publish unrelated edits; cancel and discard keep saved OTP', async ({ page }) => {
    const source = await fixture('raw'); await open(page, source.bytes);
    const editor = await edit(page);
    await editor.getByLabel('Title', { exact: true }).fill('Must not publish');
    await editor.getByRole('button', { name: 'Edit OTP', exact: true }).click();
    await editor.getByLabel('OTP secret or otpauth URL', { exact: true }).fill(`otpauth://totp/Test?secret=${seed}&period=Infinity`);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('Could not save.');
    await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('Must not publish');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#entry-title')).toHaveText(title);
    const unchanged = await exportAndRead(page, source.id);
    expect((unchanged.entry.fields.get('otp') as kdbx.ProtectedValue).getText()).toBe(seed);
    await edit(page);
    await editor.getByRole('button', { name: 'Remove OTP', exact: true }).click();
    await editor.getByRole('button', { name: 'Discard OTP changes', exact: true }).click();
    await save(page); await expect(code(page)).toHaveText('287 082');
});

test('new entry rejects malformed OTP before creation and can save a corrected draft', async ({ page }) => {
    const source = await fixture(); await open(page, source.bytes);
    const count = await page.locator('.entry-row').count();
    await page.getByRole('button', { name: 'New entry', exact: true }).click();
    const editor = form(page);
    await editor.getByLabel('Title', { exact: true }).fill('Created with OTP');
    await editor.getByRole('button', { name: 'Set up OTP', exact: true }).click();
    await editor.getByLabel('OTP secret or otpauth URL', { exact: true }).fill('invalid!');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('Could not save.');
    await expect(page.locator('.entry-row')).toHaveCount(count);
    await editor.getByLabel('OTP secret or otpauth URL', { exact: true }).fill(url);
    await save(page);
    await expect(page.locator('.entry-row')).toHaveCount(count + 1);
    await expect(code(page)).toHaveText('942 87082');
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('#password')).toBeVisible({ timeout });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await page.locator('.entry-row').filter({ hasText: 'Created with OTP' }).click({ timeout });
    await expect(code(page)).toHaveText('942 87082');
});

for (const legacy of ['raw', 'KeeOTP', 'TrayTOTP'] as const) {
    test(`${legacy} migration keeps code and protects canonical field in encrypted export`, async ({ page }) => {
        const source = await fixture(legacy); await open(page, source.bytes);
        const expected = legacy === 'raw' ? '287 082' : '942 87082';
        await expect(code(page)).toHaveText(expected);
        const editor = await edit(page);
        await expect(editor.getByText('Legacy OTP configuration. Edit and save to migrate it to a protected OTP field.')).toBeVisible();
        await editor.getByRole('button', { name: 'Edit OTP', exact: true }).click();
        await save(page); await expect(code(page)).toHaveText(expected);
        const migrated = await exportAndRead(page, source.id);
        expect(migrated.entry.fields.get('otp')).toBeInstanceOf(kdbx.ProtectedValue);
        expect((migrated.entry.fields.get('otp') as kdbx.ProtectedValue).getText()).toMatch(/^otpauth:\/\/totp\//);
        expect(migrated.entry.fields.has('TOTP Seed')).toBe(false);
        expect(migrated.entry.fields.has('TOTP Settings')).toBe(false);
    });
}

test('lock flushes a valid OTP draft and encrypted reopen retains it', async ({ page }) => {
    const source = await fixture(); await open(page, source.bytes);
    const editor = await edit(page);
    await editor.getByRole('button', { name: 'Set up OTP', exact: true }).click();
    await editor.getByLabel('OTP secret or otpauth URL', { exact: true }).fill(url);
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('#password')).toBeVisible({ timeout });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await page.locator('.entry-row').filter({ hasText: title }).click({ timeout });
    await expect(code(page)).toHaveText('942 87082');
    const saved = await exportAndRead(page, source.id);
    expect((saved.entry.fields.get('otp') as kdbx.ProtectedValue).getText()).toBe(url);
});

test('invalid OTP draft is hidden on lock and retained through credential recovery without publication', async ({ page }) => {
    const source = await fixture('raw'); await open(page, source.bytes);
    const editor = await edit(page);
    await editor.getByRole('button', { name: 'Edit OTP', exact: true }).click();
    await editor.getByLabel('OTP secret or otpauth URL', { exact: true }).fill('invalid!');
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Verify to recover editing', exact: true })).toBeVisible({ timeout });
    await expect(editor).toBeHidden();
    const recovery = page.getByRole('form', { name: 'Verify database: otp-lifecycle', exact: true });
    await expect(page.getByRole('button', { name: 'Return to unsaved changes', exact: true })).toBeDisabled();
    await recovery.getByLabel('Master password', { exact: true }).fill(password);
    await recovery.getByRole('button', { name: 'Verify', exact: true }).click();
    await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
    await expect(editor.getByLabel('OTP secret or otpauth URL', { exact: true })).toHaveValue('invalid!');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(code(page)).toHaveText('287 082');
    const unchanged = await exportAndRead(page, source.id);
    expect((unchanged.entry.fields.get('otp') as kdbx.ProtectedValue).getText()).toBe(seed);
});
