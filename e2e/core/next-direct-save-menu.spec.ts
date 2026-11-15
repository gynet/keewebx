import { revealDatabaseAction } from '../database-actions';
import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';
import { activateVaultUtility } from './vault-utilities';

const password = 'Disposable direct menu password';
const timeout = 30_000;
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Vault', exact: true });
const browse = (page: Page) => page.getByRole('button', { name: 'Browse vault', exact: true });
let first: Buffer, second: Buffer;
async function fixture(name: string) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), name);
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.groups[0]); entry.fields.set('Title', `${name} entry`);
    entry.fields.set('Notes', 'Original notes');
    return Buffer.from(await db.save());
}
async function unlock(page: Page) {
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.getByRole('dialog', { name: 'Open another vault', exact: true })).toHaveCount(0, { timeout });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}
async function openNavigation(page: Page) {
    if (!await navigation(page).isVisible()) {
        await browse(page).focus(); await page.keyboard.press('Enter');
    }
    await expect(navigation(page)).toBeVisible();
}
async function closeNavigation(page: Page, width: number) {
    if (width < 760) {
        const expanded = navigation(page).locator('.entry-more > button[aria-expanded=true]');
        if (await expanded.count()) await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect(browse(page)).toBeFocused();
        await expect(browse(page)).toHaveAttribute('aria-expanded', 'false');
    }
}
test.beforeAll(async () => { first = await fixture('Menu A'); second = await fixture('Menu B'); });

test('collapsed desktop sidebar and phone drawer never introduce a floating duplicate menu', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/next.html'); await page.locator('#open-demo').click();
    const collapse = page.getByRole('button', { name: 'Collapse folders panel', exact: true });
    await collapse.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Expand folders panel', exact: true })).toHaveAttribute('aria-expanded', 'false');
    for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
        await expect(page.locator('.phone-bar')).toHaveCount(0);
        await expect(page.getByRole('button', { name: /^(Move menu|Show menu)$/, includeHidden: true })).toHaveCount(0);
        for (const name of ['Settings', 'Lock', 'Open another vault']) {
            await expect(page.getByRole('button', { name, exact: true, includeHidden: true })).toHaveCount(1);
        }
        if (width < 760) {
            await expect(browse(page)).toHaveCount(1);
            await openNavigation(page);
            await expect(navigation(page).getByRole('button', { name: 'Database actions', exact: true })).toBeInViewport();
            await closeNavigation(page, width);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
});

for (const width of [1280, 390, 320]) {
    test(`single vault database menu save and close are usable and durable at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
        await page.goto('/next.html');
        await page.locator('#open-file-input').setInputFiles({ name: 'Menu A.kdbx', mimeType: 'application/octet-stream', buffer: first });
        await unlock(page); await openNavigation(page);
        await expect(navigation(page).locator('.side__content').getByRole('button', { name: /^Save |^Close / })).toHaveCount(0);
        const save = await revealDatabaseAction(page, /^Save Menu A/);
        const close = navigation(page).getByRole('button', { name: /^Close Menu A/ });
        await expect(save).toHaveText('Save database'); await expect(close).toHaveText('Close database');
        await expect(save).toBeInViewport(); await expect(close).toBeInViewport();
        await expect(page.getByRole('button', { name: 'Save vaults', exact: true })).toHaveCount(0);
        await expect(navigation(page).locator('.side__vault-name')).toHaveCount(1);
        await expect(navigation(page).locator('[role=status], #sync-state')).toHaveCount(1);
        await expect(navigation(page).locator('.open-vaults__select')).toHaveCount(0);
        expect(await navigation(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await closeNavigation(page, width);
        await page.locator('[data-entry="Menu A entry"]').click();
        await page.getByRole('button', { name: 'Edit notes', exact: true }).click();
        await page.locator('.notes__editor').fill(`Saved from database menu at ${width}px`);
        await openNavigation(page); await revealDatabaseAction(page, /^Save Menu A/); await save.focus(); await page.keyboard.press('Enter');
        await expect(save).toBeEnabled({ timeout });
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        await expect.soft(save, 'Saving must retain keyboard focus so Escape still reaches the drawer').toBeFocused();
        // Continue durability/close coverage even if the preceding focus regression fails.
        await save.focus();
        await closeNavigation(page, width);
        await expect(page.locator('.notes__editor')).toHaveValue(`Saved from database menu at ${width}px`);
        await openNavigation(page); await revealDatabaseAction(page, /^Close Menu A/); await close.focus(); await page.keyboard.press('Space');
        const dialog = page.getByRole('dialog', { name: 'Close vault: Menu A', exact: true });
        await expect(dialog).toBeVisible(); await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(width < 760 ? browse(page) : close).toBeFocused();
        await openNavigation(page); await revealDatabaseAction(page, /^Close Menu A/); await close.focus(); await page.keyboard.press('Enter');
        await dialog.getByRole('button', { name: 'Save and close', exact: true }).click();
        await expect(page.locator('.vault')).toHaveCount(0, { timeout });
        await page.reload();
        await page.locator('.vault-row[data-vault="Menu A"]').click(); await unlock(page);
        await page.locator('[data-entry="Menu A entry"]').click();
        await expect(page.locator('.entry-notes')).toContainText(`Saved from database menu at ${width}px`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });

    test(`multiple vault menus preserve per-file actions and return to a single footer menu at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
        await page.goto('/next.html');
        await page.locator('#open-file-input').setInputFiles({ name: 'Menu A.kdbx', mimeType: 'application/octet-stream', buffer: first });
        await unlock(page);
        await activateVaultUtility(page, 'Open another vault');
        await page.locator('#open-file-input').setInputFiles({ name: 'Menu B.kdbx', mimeType: 'application/octet-stream', buffer: second });
        await unlock(page); await openNavigation(page);
        const saveAll = await revealDatabaseAction(page, 'Save vaults');
        await expect(page.getByRole('button', { name: 'Save vaults', exact: true })).toHaveCount(1);
        await expect(saveAll).toBeInViewport();
        await saveAll.focus(); await page.keyboard.press('Space');
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        await expect(navigation(page).locator('.open-vaults__select')).toHaveCount(2);
        const controls = await navigation(page).locator('.entry-more > button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-controls')));
        expect(new Set(controls).size).toBe(3);
        for (const id of controls) await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
        await (await revealDatabaseAction(page, /^Save Menu A/)).click();
        await expect(navigation(page).getByRole('button', { name: /^Save Menu B/ })).toBeHidden();
        await (await revealDatabaseAction(page, /^Close Menu B/)).click();
        await page.getByRole('dialog', { name: 'Close vault: Menu B', exact: true })
            .getByRole('button', { name: 'Save and close', exact: true }).click();
        await openNavigation(page);
        await expect(page.getByRole('button', { name: 'Save vaults', exact: true })).toHaveCount(0);
        await expect(await revealDatabaseAction(page, /^Save Menu A/)).toHaveText('Save database');
        await expect(navigation(page).getByRole('button', { name: /^Close Menu A/ })).toHaveText('Close database');
        await expect(navigation(page).locator('.open-vaults__select')).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
}
