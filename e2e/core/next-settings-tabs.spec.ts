import { test, expect, type Page, type Locator } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'Disposable settings tabs password';
const title = 'Keep this tab-switch record';
const secret = 'Preserved tab-switch secret';
const categories = [
    ['appearance', 'Appearance'], ['security', 'Security'], ['saving', 'Saving and content'],
    ['database', 'Database'], ['extensions', 'Browser extension']
] as const;
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const activate = (element: Locator, touch: boolean) => touch ? element.tap() : element.click();

async function open(page: Page) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Tabs fixture');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', title);
    entry.fields.set('Password', kdbx.ProtectedValue.fromString(secret));
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'tabs.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) });
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });
    return entry.uuid.id;
}

for (const mobile of [false, true]) test.describe(mobile ? 'Settings tabs at 320px' : 'Settings tabs on desktop', () => {
    test.use({ viewport: mobile ? { width: 320, height: 568 } : { width: 1280, height: 800 }, hasTouch: mobile });

    test('visible categories support pointer and roving keyboard navigation with one active panel', async ({ page }) => {
        await open(page);
        await activate(page.getByRole('button', { name: 'Settings', exact: true }), mobile);
        await expect(tab(page, 'Appearance')).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toBeVisible();
        await expect(page.getByRole('tablist', { name: 'Settings categories', exact: true })).toBeVisible();
        await expect(page.getByRole('tab')).toHaveCount(categories.length);
        for (const [id, name] of categories) {
            await activate(tab(page, name), mobile);
            await expect(tab(page, name)).toHaveAttribute('id', `settings-tab-${id}`);
            await expect(tab(page, name)).toHaveAttribute('aria-controls', `settings-panel-${id}`);
            await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
            await expect(tab(page, name)).toHaveAttribute('tabindex', '0');
            await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
            await expect(page.getByRole('tabpanel')).toHaveCount(1);
            await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
            for (const [, other] of categories.filter(([, label]) => label !== name)) {
                await expect(tab(page, other)).toHaveAttribute('tabindex', '-1');
                await expect(page.getByRole('tabpanel', { name: other, exact: true, includeHidden: true })).toBeHidden();
            }
        }
        await tab(page, 'Browser extension').focus();
        for (const [key, name] of [
            ['Home', 'Appearance'], ['ArrowRight', 'Security'], ['End', 'Browser extension'],
            ['ArrowRight', 'Appearance'], ['ArrowLeft', 'Browser extension'], ['Home', 'Appearance']
        ]) {
            await page.keyboard.press(key);
            await expect(tab(page, name)).toBeFocused();
            await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
            await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
        }
        await page.keyboard.press('Tab');
        await expect(page.getByRole('radio', { name: 'New', exact: true })).toBeFocused();
    });

    test('database drafts survive all category switches and save/export retains encrypted content', async ({ page }) => {
        const entryId = await open(page);
        await activate(page.getByRole('button', { name: 'Settings', exact: true }), mobile);
        await activate(tab(page, 'Saving and content'), mobile);
        await page.locator('#setting-auto-save').selectOption('0');
        await activate(tab(page, 'Database'), mobile);
        const form = page.getByRole('form', { name: /^Database settings: / });
        await form.getByLabel('Vault name', { exact: true }).fill('Retained tabs draft');
        await form.getByText('Advanced', { exact: true }).click();
        await form.getByLabel('Default user', { exact: true }).fill('draft-user');
        for (const name of ['Appearance', 'Security', 'Saving and content', 'Browser extension']) {
            await activate(tab(page, name), mobile);
            const retained = page.getByRole('form', { name: /^Database settings: /, includeHidden: true });
            await expect(retained).toHaveCount(1);
            await expect(retained).toBeHidden();
            await expect(retained.getByLabel('Vault name', { exact: true })).toHaveValue('Retained tabs draft');
        }
        await activate(tab(page, 'Database'), mobile);
        await expect(form.getByLabel('Vault name', { exact: true })).toHaveValue('Retained tabs draft');
        await expect(form.getByLabel('Default user', { exact: true })).toHaveValue('draft-user');
        await form.getByRole('button', { name: 'Save database settings', exact: true }).click();
        await expect(form.getByRole('status')).toContainText('Saved in browser storage', { timeout: 30_000 });
        const pending = page.waitForEvent('download');
        await form.getByRole('button', { name: 'Download KDBX', exact: true }).click();
        const download = await pending;
        expect(await download.failure()).toBeNull();
        const stream = await download.createReadStream();
        if (!stream) throw new Error('Missing encrypted settings export');
        const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        expect(bytes.includes(Buffer.from(secret))).toBe(false);
        const reopened = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
        expect(reopened.meta.name).toBe('Retained tabs draft');
        expect(reopened.meta.defaultUser).toBe('draft-user');
        const entry = [...reopened.getDefaultGroup().allEntries()].find(value => value.uuid.id === entryId)!;
        expect(entry.fields.get('Title')).toBe(title);
        expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe(secret);
        await activate(page.getByRole('button', { name: 'Back to vault', exact: true }), mobile);
        await page.getByRole('button', { name: 'Lock', exact: true }).click();
        await expect(page.locator('#password')).toBeVisible({ timeout: 30_000 });
        await page.reload();
        await page.locator('#password').fill(password); await page.locator('#unlock').click();
        await activate(page.getByRole('button', { name: 'Settings', exact: true }), mobile);
        await activate(tab(page, 'Database'), mobile);
        await expect(form.getByLabel('Vault name', { exact: true })).toHaveValue('Retained tabs draft');
        await form.getByText('Advanced', { exact: true }).click();
        await expect(form.getByLabel('Default user', { exact: true })).toHaveValue('draft-user');
    });
});
