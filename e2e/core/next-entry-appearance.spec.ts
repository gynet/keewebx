import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'Disposable appearance master';
const secret = 'Preserve!ThisSyntheticSecret789';
const colors = { yellow: '#ffff88', green: '#88ff88', red: '#ff8888', orange: '#ffcc88', blue: '#8888ff', violet: '#ff88ff' };
const timeout = 30_000;
async function image(page: Page, fill = 'red', width = 16, height = 16) {
    return Buffer.from(await page.evaluate(({ fill, width, height }) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d')!; ctx.fillStyle = fill; ctx.fillRect(0, 0, width, height);
        return canvas.toDataURL('image/png').split(',')[1];
    }, { fill, width, height }), 'base64');
}
async function open(page: Page, foreground = false) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Appearance');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const icon = kdbx.KdbxUuid.random(), png = await image(page);
    db.meta.customIcons.set(icon.id, { data: new Uint8Array(png).buffer });
    const entry = db.createEntry(db.groups[0]); entry.fields.set('Title', 'Appearance record');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString(secret)); entry.tags = ['Preserved tag'];
    entry.customIcon = icon; if (foreground) entry.fgColor = '#ff0000'; entry.pushHistory();
    const sibling = db.createEntry(db.groups[0]); sibling.fields.set('Title', 'Shared icon sibling'); sibling.customIcon = icon;
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'appearance.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    return { id: entry.uuid.id, sibling: sibling.uuid.id, icon: icon.id, png, history: entry.history.length };
}
async function browse(page: Page) {
    const menu = page.getByRole('button', { name: 'Show menu', exact: true }); if (await menu.isVisible()) await menu.click();
    if (!await page.getByRole('navigation', { name: 'Vault', exact: true }).isVisible()) await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
}
async function select(page: Page) { await page.locator('[data-entry="Appearance record"]').click(); }
async function appearance(page: Page) {
    await page.getByRole('button', { name: 'Appearance…', exact: true }).click();
    return page.getByRole('dialog', { name: 'Entry appearance', exact: true });
}
async function download(page: Page) {
    await browse(page); await page.locator('#open-settings').click(); await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const stream = await (await pending).createReadStream(); if (!stream) throw new Error('Missing encrypted data');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return kdbx.Kdbx.load(new Uint8Array(Buffer.concat(chunks)).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
}
const find = (db: kdbx.Kdbx, id: string) => [...db.groups[0].allEntries()].find(entry => entry.uuid.id === id)!;

for (const width of [1280, 390]) {
    test(`icon and every color flag apply, filter, clear and round-trip at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 }); const original = await open(page); await select(page);
        let dialog = await appearance(page);
        await dialog.getByRole('radio', { name: 'Icon: Star', exact: true }).check();
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.locator('.detail .tile img')).toBeVisible();
        for (const color of Object.keys(colors)) {
            dialog = await appearance(page); await dialog.getByRole('radio', { name: 'Icon: Star', exact: true }).check();
            await dialog.getByRole('combobox', { name: 'Color flag', exact: true }).selectOption(color);
            await dialog.getByRole('button', { name: 'Apply appearance', exact: true }).click();
            await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
            await expect(page.locator('.detail').getByRole('img', { name: `${color[0].toUpperCase()}${color.slice(1)} flag`, exact: true })).toBeVisible();
            if (width < 760) await page.getByRole('button', { name: 'Back', exact: true }).click();
            await page.getByRole('combobox', { name: 'Filter by color', exact: true }).selectOption(color);
            await expect(page.locator('.entry-row')).toHaveCount(1);
            await page.getByRole('combobox', { name: 'Filter by color', exact: true }).selectOption(color === 'red' ? 'blue' : 'red');
            await expect(page.locator('.entry-row')).toHaveCount(0);
            await page.getByRole('combobox', { name: 'Filter by color', exact: true }).selectOption('any');
            await expect(page.locator('.entry-row')).toHaveCount(1);
            await page.getByRole('combobox', { name: 'Filter by color', exact: true }).selectOption(''); await select(page);
        }
        let reopened = await download(page), entry = find(reopened, original.id);
        expect(entry.icon).toBe(61); expect(entry.customIcon).toBeUndefined(); expect(entry.bgColor?.toLowerCase()).toBe(colors.violet);
        expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe(secret); expect(entry.tags).toEqual(['Preserved tag']);
        expect(find(reopened, original.sibling).customIcon?.id).toBe(original.icon);
        expect(Buffer.from(reopened.meta.customIcons.get(original.icon)!.data!)).toEqual(original.png);
        await page.locator('#settings-back:visible, .settings__phone-back:visible').click();
        dialog = await appearance(page); await dialog.getByRole('combobox', { name: 'Color flag', exact: true }).selectOption('');
        await dialog.getByRole('radio', { name: 'Custom icon 1', exact: true }).check();
        await dialog.getByRole('button', { name: 'Apply appearance', exact: true }).click();
        await expect(page.locator('.detail .entry-flag')).toHaveCount(0);
        reopened = await download(page); entry = find(reopened, original.id);
        expect(entry.bgColor || '').toBe(''); expect(entry.customIcon?.id).toBe(original.icon);
    });
    test(`custom upload is local, cancel inert, invalid image rejected and shared icons retained at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 }); const original = await open(page); await select(page);
        const png = await image(page, 'blue', 300, 100);
        let dialog = await appearance(page);
        await dialog.getByLabel('Upload icon', { exact: true }).setInputFiles({ name: 'icon.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
        await expect(dialog.getByRole('alert')).toContainText('PNG, JPEG, or WebP');
        await dialog.getByLabel('Upload icon', { exact: true }).setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: png });
        await expect(dialog.getByRole('img', { name: 'New icon preview', exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        let reopened = await download(page); expect(reopened.meta.customIcons.size).toBe(1);
        expect(find(reopened, original.id).customIcon?.id).toBe(original.icon); expect(find(reopened, original.id).history).toHaveLength(original.history);
        await page.locator('#settings-back:visible, .settings__phone-back:visible').click(); dialog = await appearance(page);
        await dialog.getByLabel('Upload icon', { exact: true }).setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: png });
        await expect(dialog.getByRole('img', { name: 'New icon preview', exact: true })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`appearance-dialog-${width}.png`), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await dialog.getByRole('button', { name: 'Apply appearance', exact: true }).click();
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        reopened = await download(page); const entry = find(reopened, original.id);
        expect(entry.customIcon?.id).not.toBe(original.icon);
        const bytes = Buffer.from(reopened.meta.customIcons.get(entry.customIcon!.id)!.data!);
        expect(bytes.readUInt32BE(16)).toBe(128); expect(bytes.readUInt32BE(20)).toBe(43);
        expect(find(reopened, original.sibling).customIcon?.id).toBe(original.icon);
        expect(Buffer.from(reopened.meta.customIcons.get(original.icon)!.data!)).toEqual(original.png);
        await page.locator('#settings-back:visible, .settings__phone-back:visible').click(); await browse(page); await page.locator('#lock').click();
        await expect(page.locator('#password')).toBeVisible({ timeout }); await page.reload();
        await page.locator('#password').fill(password); await page.locator('#unlock').click(); await select(page);
        await expect(page.locator('.detail .tile img')).toBeVisible();
    });
}

test('idle lock with an appearance draft never applies it or bypasses authentication', async ({ page }) => {
    await page.clock.install(); const original = await open(page); await select(page);
    const dialog = await appearance(page); await dialog.getByRole('radio', { name: 'Icon: Star', exact: true }).check();
    await page.clock.fastForward(16 * 60_000); await expect(page.locator('#password')).toBeVisible({ timeout });
    await expect(page.getByRole('dialog', { name: 'Entry appearance', exact: true })).toHaveCount(0);
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    const reopened = await download(page); expect(find(reopened, original.id).customIcon?.id).toBe(original.icon);
    expect(find(reopened, original.id).history).toHaveLength(original.history);
});


test('clearing an imported foreground flag preserves its original value in history', async ({ page }) => {
    const original = await open(page, true); await select(page);
    await expect(page.locator('.detail').getByRole('img', { name: 'Red flag', exact: true })).toBeVisible();
    const dialog = await appearance(page);
    await dialog.getByRole('combobox', { name: 'Color flag', exact: true }).selectOption('');
    await dialog.getByRole('button', { name: 'Apply appearance', exact: true }).click();
    await expect(page.locator('.detail .entry-flag')).toHaveCount(0);
    const reopened = await download(page), entry = find(reopened, original.id);
    expect(entry.bgColor || '').toBe(''); expect(entry.fgColor || '').toBe('');
    expect(entry.history.some(record => record.fgColor?.toLowerCase() === '#ff0000')).toBe(true);
    expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe(secret);
});
