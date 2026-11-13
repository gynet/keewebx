import { test, expect, type Page } from '@playwright/test';
test.use({ serviceWorkers: 'block' });
const generator = (page: Page) => page.getByRole('region', { name: 'Password generator', exact: true });
const manager = (page: Page) => generator(page).locator('.generator-presets');
async function open(page: Page) {
    await page.goto('/next.html');
    await page.getByRole('button', { name: 'Password generator', exact: true }).click();
    await expect(generator(page)).toBeVisible();
}
async function manage(page: Page) { await manager(page).locator('summary').click(); }
async function pattern(page: Page) {
    await generator(page).getByLabel('Length', { exact: true }).fill('10');
    await generator(page).getByLabel('Pattern', { exact: true }).fill('AA-11');
    await expect(generator(page).getByLabel('Generated password', { exact: true })).toHaveValue(/^[A-Z]{2}-[1-9]{2}[A-Z]{2}-[1-9]{2}$/);
}
async function create(page: Page, name: string) {
    await manager(page).getByLabel('Preset name', { exact: true }).fill(name);
    await manager(page).getByRole('button', { name: 'Save as new preset', exact: true }).click();
    await expect(manager(page).getByRole('status')).toHaveText('Preset settings saved.');
}
for (const width of [1280, 320]) test.describe(`${width}px generator presets`, () => {
    test.use({ viewport: { width, height: 740 } });
    test('create, rename, default, enable, disable and delete persist through reload without altering other presets', async ({ page }) => {
        await open(page); await pattern(page); await manage(page); await create(page, 'Startup pattern');
        await manager(page).getByLabel('Preset name', { exact: true }).fill('Renamed pattern');
        await manager(page).getByRole('button', { name: 'Save preset changes', exact: true }).click();
        await expect(generator(page).getByLabel('Preset', { exact: true }).locator('option:checked')).toHaveText('Renamed pattern');
        await manager(page).getByRole('button', { name: 'Make default', exact: true }).click();
        await expect(manager(page).getByRole('button', { name: 'Make default', exact: true })).toBeDisabled();
        await manager(page).getByRole('button', { name: 'Disable preset', exact: true }).click();
        await expect(manager(page).getByRole('status')).toContainText('another enabled default');
        const saved = await page.evaluate(() => JSON.parse(localStorage.appSettings).generatorPresets);
        expect(saved.user).toHaveLength(1); expect(saved.user[0].pattern).toBe('AA-11');
        await open(page);
        await expect(generator(page).getByLabel('Preset', { exact: true }).locator('option:checked')).toHaveText('Renamed pattern');
        await expect(generator(page).getByLabel('Generated password', { exact: true })).toHaveValue(/^[A-Z]{2}-[1-9]{2}[A-Z]{2}-[1-9]{2}$/);
        await manage(page); await manager(page).getByLabel('Manage preset', { exact: true }).selectOption('Default');
        await manager(page).getByRole('button', { name: 'Make default', exact: true }).click();
        const custom = saved.user[0].name;
        await manager(page).getByLabel('Manage preset', { exact: true }).selectOption(custom);
        await manager(page).getByRole('button', { name: 'Disable preset', exact: true }).click();
        await expect(generator(page).getByLabel('Preset', { exact: true }).locator(`option[value="${custom}"]`)).toHaveCount(0);
        await open(page); await manage(page);
        await manager(page).getByLabel('Manage preset', { exact: true }).selectOption(custom);
        await expect(manager(page).getByRole('button', { name: 'Make default', exact: true })).toBeDisabled();
        await manager(page).getByRole('button', { name: 'Enable preset', exact: true }).click();
        await expect(generator(page).getByLabel('Preset', { exact: true }).locator(`option[value="${custom}"]`)).toHaveCount(1);
        page.once('dialog', dialog => dialog.dismiss()); await manager(page).getByRole('button', { name: 'Delete preset', exact: true }).click();
        await expect(manager(page).getByLabel('Manage preset', { exact: true })).toHaveValue(custom);
        page.once('dialog', dialog => dialog.accept()); await manager(page).getByRole('button', { name: 'Delete preset', exact: true }).click();
        await expect(manager(page).getByRole('status')).toHaveText('Preset settings saved.');
        await open(page); await expect(generator(page).getByLabel('Preset', { exact: true }).locator(`option[value="${custom}"]`)).toHaveCount(0);
        await expect(generator(page).getByLabel('Preset', { exact: true }).locator('option[value="Pin4"]')).toHaveCount(1);
        expect(await page.evaluate(() => JSON.parse(localStorage.appSettings).generatorPresets.user)).toEqual([]);
        await page.screenshot({ path: test.info().outputPath('generator-presets.png') });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
    test('validation rejects duplicate names and unusable patterns; derived options never persist source secrets', async ({ page }) => {
        await open(page); await manage(page);
        await manager(page).getByLabel('Preset name', { exact: true }).fill('Default');
        await manager(page).getByRole('button', { name: 'Save as new preset', exact: true }).click();
        await expect(manager(page).getByRole('status')).toContainText('unique preset name');
        await generator(page).getByLabel('Pattern', { exact: true }).fill('---');
        await expect(generator(page).getByRole('alert')).toContainText('random character');
        await expect(generator(page).getByRole('button', { name: 'Copy password', exact: true })).toBeDisabled();
        await generator(page).getByLabel('Pattern', { exact: true }).fill('I');
        await expect(generator(page).getByRole('alert')).toContainText('additional characters');
        await generator(page).getByText('Derive options from a password', { exact: true }).click();
        const source = 'DoNotPersistThisSecret42!';
        await generator(page).getByLabel('Source password', { exact: true }).fill(source);
        await expect(generator(page).getByLabel('Source password', { exact: true })).toHaveAttribute('type', 'password');
        await generator(page).getByRole('button', { name: 'Derive options', exact: true }).click();
        await expect(generator(page).getByLabel('Source password', { exact: true })).toHaveValue('');
        await expect(generator(page).getByLabel('Length', { exact: true })).toHaveValue(String(source.length));
        await expect(generator(page).getByLabel('Generated password', { exact: true })).not.toHaveValue(source);
        await create(page, 'Derived classes');
        expect(await page.evaluate(() => localStorage.appSettings)).not.toContain(source);
        const settings = await page.evaluate(() => JSON.parse(localStorage.appSettings).generatorPresets.user[0]);
        expect(settings.include).toBeUndefined(); expect(settings.pattern).toBeUndefined(); expect(settings.length).toBe(source.length);
    });
});

test('preset storage failure reports failure and rolls back; retry persists', async ({ page }) => {
    await open(page); await manage(page); await manager(page).getByLabel('Preset name', { exact: true }).fill('Retry preset');
    await page.evaluate(() => {
        const store = window.localStorage;
        Object.defineProperty(window, 'localStorage', { configurable: true, value: new Proxy(store, {
            get(target, property) { const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; },
            set() { throw new DOMException('Storage full', 'QuotaExceededError'); }
        }) });
        window.addEventListener('restore-preset-storage', () => Object.defineProperty(window, 'localStorage', { configurable: true, value: store }), { once: true });
    });
    await manager(page).getByRole('button', { name: 'Save as new preset', exact: true }).click();
    await expect(manager(page).getByRole('status')).toContainText('could not be saved');
    await expect(generator(page).getByLabel('Preset', { exact: true }).locator('option').filter({ hasText: 'Retry preset' })).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('restore-preset-storage')));
    await create(page, 'Retry preset'); await open(page);
    await expect(generator(page).getByLabel('Preset', { exact: true }).locator('option').filter({ hasText: 'Retry preset' })).toHaveCount(1);
});

test('locked generator and settings shortcuts honor policy, copy uses cleanup and does not create a vault', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, 'copiedValues', { value: [] });
        Object.defineProperty(navigator.clipboard, 'writeText', { value: async (text: string) => { (window as unknown as { copiedValues: string[] }).copiedValues.push(text); } });
        Object.defineProperty(navigator.clipboard, 'readText', { value: async () => (window as unknown as { copiedValues: string[] }).copiedValues.at(-1) ?? '' });
    });
    await page.goto('/next.html'); await page.evaluate(() => { localStorage.appSettings = JSON.stringify({ clipboardSeconds: 1 }); }); await page.reload();
    await page.locator('body').click({ position: { x: 1, y: 1 } }); await page.keyboard.press('Control+g');
    await expect(generator(page)).toBeVisible();
    const value = await generator(page).getByLabel('Generated password', { exact: true }).inputValue();
    await generator(page).getByRole('button', { name: 'Copy password', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { copiedValues: string[] }).copiedValues)).toEqual([value, '']);
    await page.keyboard.press('Escape'); await expect(generator(page)).toHaveCount(0);
    await page.locator('body').click({ position: { x: 1, y: 1 } }); await page.keyboard.press('Control+,');
    await expect(page.getByRole('tab', { name: 'Appearance', exact: true })).toBeVisible();
    await expect(page.locator('.entry-row')).toHaveCount(0);
    await page.route(url => url.pathname === '/generator-policy.json', route => route.fulfill({ json: { settings: { canOpenGenerator: false, canOpenSettings: false } } }));
    await page.goto('/next.html?config=/generator-policy.json');
    await expect(page.locator('.start')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Password generator', exact: true })).toHaveCount(0);
    await page.locator('body').click({ position: { x: 1, y: 1 } }); await page.keyboard.press('Control+g'); await page.keyboard.press('Control+,');
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('tab')).toHaveCount(0);
});
