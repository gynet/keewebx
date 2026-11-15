import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'Disposable toolbar fixture';
let source: Buffer;
test.beforeAll(async () => {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Toolbar');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    for (const title of ['Alpha account', 'Bravo account', 'Charlie account', 'Delta account', 'Echo account', 'Foxtrot account']) {
        const entry = db.createEntry(db.groups[0]);
        entry.fields.set('Title', title);
        entry.fields.set('UserName', 'fixture@example.test');
        entry.fields.set('Password', kdbx.ProtectedValue.fromString('toolbar-secret'));
        if (title.startsWith('Alpha')) entry.bgColor = '#ff8888';
    }
    source = Buffer.from(await db.save());
});
async function unlock(page: Page) {
    await page.locator('#open-file-input').setInputFiles({ name: 'Toolbar.kdbx', mimeType: 'application/octet-stream', buffer: source });
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row')).toHaveCount(6);
}
async function browse(page: Page) {
    if (!await page.getByRole('navigation', { name: 'Vault', exact: true }).isVisible()) {
        await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
    }
}

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    test(`compact toolbar and live controls at ${viewport.width}px`, async ({ page }, info) => {
        await page.setViewportSize(viewport);
        await page.goto('/next.html'); await unlock(page);
        const controls = page.locator('.entry-list-controls');
        await expect(page.getByRole('combobox', { name: 'Vault filter', exact: true })).toHaveCount(0);
        await expect(controls.getByRole('button', { name: 'Password generator', exact: true })).toHaveCount(0);
        const measurements = await page.evaluate(() => {
            const bounds = (element: Element) => { const { x, y, width, height, bottom } = element.getBoundingClientRect(); return { x, y, width, height, bottom }; };
            const controls = document.querySelector('.entry-list-controls')!;
            return {
                toolbar: bounds(controls),
                rows: [...document.querySelectorAll('.entry-row')].map(bounds),
                targets: [...controls.querySelectorAll('input, select, button, summary')].filter(element => element.checkVisibility()).map(element => ({ label: element.getAttribute('aria-label') || element.textContent, ...bounds(element) })),
                listScroll: document.querySelector('.list')!.scrollTop,
                overflow: document.documentElement.scrollWidth > innerWidth
            };
        });
        expect(measurements.toolbar.height).toBeLessThanOrEqual(195);
        expect(measurements.listScroll).toBe(0);
        expect(measurements.overflow).toBe(false);
        expect(measurements.rows[2].bottom).toBeLessThan(viewport.height);
        for (const target of measurements.targets) {
            expect(target.height, target.label || '').toBeGreaterThanOrEqual(44);
            expect(target.width, target.label || '').toBeGreaterThanOrEqual(44);
            expect(target.x + target.width).toBeLessThanOrEqual(viewport.width);
        }
        await info.attach('toolbar-measurements', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath(`toolbar-${viewport.width}.png`) });
        await page.locator('#search').fill('Bravo');
        await expect(page.locator('.entry-row__title')).toHaveText(['Bravo account']);
        await page.locator('#search').fill('');
        await page.getByRole('combobox', { name: 'Sort entries', exact: true }).selectOption('-title');
        await expect(page.locator('.entry-row__title').first()).toHaveText('Foxtrot account');
        await page.getByRole('combobox', { name: 'Filter by color', exact: true }).selectOption('red');
        await expect(page.locator('.entry-row__title')).toHaveText(['Alpha account']);
        await page.getByRole('combobox', { name: 'Filter by color', exact: true }).selectOption('');
        await page.locator('.search-options > summary').click();
        await page.locator('#search').fill('toolbar-secret');
        await expect(page.locator('.entry-row')).toHaveCount(0);
        await page.locator('.search-options').getByLabel('Passwords', { exact: true }).check();
        await expect(page.locator('.entry-row')).toHaveCount(6);
        await page.locator('.search-options').getByRole('button', { name: 'Reset search and filters', exact: true }).click();
        await expect(page.locator('#search')).toHaveValue('');
        await expect(page.locator('.search-options').getByLabel('Passwords', { exact: true })).not.toBeChecked();
        await page.locator('.search-options > summary').click();
        await page.getByRole('button', { name: 'Entry templates…', exact: true }).click();
        await page.getByRole('dialog', { name: 'Entry templates', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Entry templates…', exact: true })).toBeFocused();
        await page.getByRole('button', { name: 'New entry', exact: true }).click();
        await expect(page.locator('.entry-editor')).toBeVisible();
        await page.locator('.entry-editor').getByRole('button', { name: 'Cancel', exact: true }).click();
        await browse(page);
        const generator = page.getByRole('navigation', { name: 'Vault', exact: true }).getByRole('button', { name: 'Password generator', exact: true });
        expect((await generator.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await generator.click();
        await expect(page.getByRole('dialog', { name: 'Generate password', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
    });
}

test('multiple vaults expose scope and retain visible rows on the shortest phone', async ({ page }, info) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/next.html'); await unlock(page); await browse(page);
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Open another vault', exact: true });
    await dialog.locator('#open-file-input').setInputFiles({ name: 'Second.kdbx', mimeType: 'application/octet-stream', buffer: source });
    await dialog.locator('#password').fill(password); await dialog.locator('#unlock').click();
    await expect(dialog).toHaveCount(0);
    const filter = page.getByRole('combobox', { name: 'Vault filter', exact: true });
    await expect(filter).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'New entry vault', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New entry', exact: true })).toBeDisabled();
    const first = (await page.locator('.entry-row').first().boundingBox())!;
    expect(first.y + first.height).toBeLessThan(568);
    expect(await page.locator('.list').evaluate(element => element.scrollTop)).toBe(0);
    await page.screenshot({ path: info.outputPath('toolbar-multiple-320.png') });
    const value = await filter.locator('option').nth(2).getAttribute('value');
    await filter.selectOption(value!);
    await expect(page.locator('.entry-row')).toHaveCount(6);
    await expect(page.getByRole('combobox', { name: 'New entry vault', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New entry', exact: true })).toBeEnabled();
});

test('sidebar generator respects configured restrictions', async ({ page }) => {
    await page.route('**/toolbar-policy.json', route => route.fulfill({ json: { settings: { canOpenGenerator: false } } }));
    await page.goto('/next.html?config=/toolbar-policy.json'); await unlock(page);
    await expect(page.getByRole('navigation', { name: 'Vault', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Password generator', exact: true, includeHidden: true })).toHaveCount(0);
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('Control+g');
    await expect(page.getByRole('dialog')).toHaveCount(0);
});
