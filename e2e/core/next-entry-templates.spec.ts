import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'Disposable template master';
const timeout = 30_000;
async function open(page: Page, templates = false) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Templates');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    db.createGroup(db.groups[0], 'Work');
    const work = db.createGroup(db.groups[0], 'Work');
    let source: kdbx.KdbxEntry | undefined;
    if (templates) {
        const group = db.createGroup(db.groups[0], 'Entry templates'); db.meta.entryTemplatesGroup = group.uuid;
        source = db.createEntry(group); source.fields.set('Title', 'Imported template');
        source.fields.set('UserName', 'template-user'); source.fields.set('Password', kdbx.ProtectedValue.fromString('Template!Secret123'));
        source.fields.set('Empty field', ''); source.fields.set('Private field', kdbx.ProtectedValue.fromString('Private template value'));
        source.fields.set('otp', kdbx.ProtectedValue.fromString('otpauth://totp/Template?secret=JBSWY3DPEHPK3PXP&issuer=Template'));
        source.fields.set('Notes', kdbx.ProtectedValue.fromString('Reusable notes\nSecond line'));
        source.times.expires = true; source.times.expiryTime = new Date('2050-01-02T03:04:05Z');
        source.tags = ['Template tag']; source.icon = 61; source.pushHistory();
    }
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'templates.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    return { work: work.uuid.id, source: source?.uuid.id, history: source?.history.length };
}
async function browse(page: Page) {
    const menu = page.getByRole('button', { name: 'Show menu', exact: true }); if (await menu.isVisible()) await menu.click();
    if (!await page.getByRole('navigation', { name: 'Vault', exact: true }).isVisible()) await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
}
async function download(page: Page) {
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await browse(page); await page.locator('#open-settings').click(); await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const stream = await (await pending).createReadStream(); if (!stream) throw new Error('Missing encrypted data');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return kdbx.Kdbx.load(new Uint8Array(Buffer.concat(chunks)).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
}
async function templates(page: Page) {
    await page.getByRole('button', { name: 'Entry templates…', exact: true }).click();
    return page.getByRole('dialog', { name: 'Entry templates', exact: true });
}
for (const width of [1280, 390, 320]) {
    test(`template creation cancel, protected empty fields, edit and reload at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 }); await open(page);
        let dialog = await templates(page);
        await dialog.getByRole('button', { name: 'New template', exact: true }).click();
        await dialog.getByLabel('Title', { exact: true }).fill('Canceled template');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        let db = await download(page);
        expect(db.meta.entryTemplatesGroup?.empty ?? true).toBe(true);
        expect([...db.groups[0].allEntries()]).toHaveLength(0);
        await page.locator('#settings-back:visible, .settings__phone-back:visible').click(); dialog = await templates(page);
        await dialog.getByRole('button', { name: 'New template', exact: true }).click();
        await dialog.getByLabel('Title', { exact: true }).fill('Account template');
        await dialog.getByLabel('Username', { exact: true }).fill('Reusable user');
        await dialog.getByRole('button', { name: 'Add field', exact: true }).click();
        await dialog.getByLabel('Field name', { exact: true }).fill('Account code');
        await dialog.getByLabel('Protected', { exact: true }).check();
        await page.screenshot({ path: test.info().outputPath(`template-editor-${width}.png`), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dialog.getByRole('status')).toHaveText('Template saved.');
        await dialog.getByRole('button', { name: 'Edit template', exact: true }).click();
        await dialog.getByLabel('Username', { exact: true }).fill('Edited reusable user');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        db = await download(page);
        const group = [...db.groups[0].allGroups()].find(group => group.uuid.equals(db.meta.entryTemplatesGroup!))!;
        expect(group.entries).toHaveLength(1);
        expect(group.entries[0].fields.get('Title')).toBe('Account template');
        expect(group.entries[0].fields.get('UserName')).toBe('Edited reusable user');
        const empty = group.entries[0].fields.get('Account code');
        expect(empty).toBeInstanceOf(kdbx.ProtectedValue); expect((empty as kdbx.ProtectedValue).getText()).toBe('');
        await page.reload(); await page.locator('#password').fill(password); await page.locator('#unlock').click();
        dialog = await templates(page); await expect(dialog.getByText('Account template', { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'Edit template', exact: true }).click();
        await expect(dialog.getByLabel('Username', { exact: true })).toHaveValue('Edited reusable user');
        await expect(dialog.getByLabel('Protected', { exact: true })).toBeChecked();
    });
    test(`use imported template in chosen group without modifying source at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 }); const original = await open(page, true);
        const dialog = await templates(page);
        await dialog.getByRole('button', { name: 'Use template', exact: true }).click();
        await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('');
        await expect(dialog.getByLabel('Username', { exact: true })).toHaveValue('template-user');
        await expect(dialog.getByText('An OTP configuration is stored in this entry.', { exact: true })).toBeVisible();
        await dialog.getByRole('combobox', { name: 'Destination group', exact: true }).selectOption({ label: 'templates / Work (2)' });
        await dialog.getByLabel('Title', { exact: true }).fill('Created from template');
        await dialog.getByLabel('Username', { exact: true }).fill('Instance user');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.locator('.detail').getByRole('heading', { name: 'Created from template', exact: true })).toBeVisible();
        const db = await download(page), groups = [...db.groups[0].allGroups()];
        const work = groups.find(group => group.uuid.id === original.work)!;
        expect(work.entries).toHaveLength(1); const entry = work.entries[0];
        expect(entry.uuid.id).not.toBe(original.source); expect(entry.fields.get('UserName')).toBe('Instance user');
        expect(entry.fields.get('Empty field')).toBe(''); expect(entry.fields.get('Private field')).toBeInstanceOf(kdbx.ProtectedValue);
        expect((entry.fields.get('Private field') as kdbx.ProtectedValue).getText()).toBe('Private template value');
        expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('Template!Secret123');
        expect(entry.fields.get('otp')).toBeInstanceOf(kdbx.ProtectedValue);
        expect((entry.fields.get('otp') as kdbx.ProtectedValue).getText()).toBe('otpauth://totp/Template?secret=JBSWY3DPEHPK3PXP&issuer=Template');
        expect(entry.icon).toBe(61); expect(entry.tags).toEqual(['Template tag']);
        expect(entry.times.expires).toBe(true); expect(entry.times.expiryTime?.toISOString()).toBe('2050-01-02T03:04:05.000Z');
        expect(entry.fields.get('Notes')).toBeInstanceOf(kdbx.ProtectedValue);
        expect((entry.fields.get('Notes') as kdbx.ProtectedValue).getText()).toBe('Reusable notes\nSecond line');
        const source = [...db.groups[0].allEntries()].find(entry => entry.uuid.id === original.source)!;
        expect(source.fields.get('Title')).toBe('Imported template'); expect(source.fields.get('UserName')).toBe('template-user');
        expect(source.history).toHaveLength(original.history!);
    });
}

test('idle lock saves a valid template draft before removing the editor', async ({ page }) => {
    await page.clock.install(); await open(page);
    const dialog = await templates(page);
    await dialog.getByRole('button', { name: 'New template', exact: true }).click();
    await dialog.getByLabel('Title', { exact: true }).fill('Saved before locking');
    await dialog.getByLabel('Password', { exact: true }).fill('Template!Draft456');
    await page.clock.fastForward(16 * 60_000);
    await expect(page.locator('#password')).toBeVisible({ timeout });
    await expect(dialog).toHaveCount(0);
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    const db = await download(page);
    const entry = [...db.groups[0].allEntries()].find(entry => entry.fields.get('Title') === 'Saved before locking')!;
    expect(entry).toBeTruthy(); expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('Template!Draft456');
    expect(entry.parentGroup!.uuid.equals(db.meta.entryTemplatesGroup!)).toBe(true);
});
