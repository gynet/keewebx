import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { activateVaultUtility } from './vault-utilities';

const demo = resolve(__dirname, '../../modules/vault/resources/Demo.kdbx');
const sections = ['appearance', 'security', 'saving', 'database', 'extensions'];

async function openSettings(page: Page, touch: boolean) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles(demo);
    await page.locator('#password').fill('demo');
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout: 30_000 });
    await activateVaultUtility(page, 'Settings', { touch });
}

async function fits(page: Page) {
    const overflow = await page.locator('.settings').evaluate(main => {
        const bounds = main.getBoundingClientRect();
        return [...main.querySelectorAll<HTMLElement>('button, input, select, textarea, .cardlist__row, .vault-form__field')]
            .filter(element => element.getClientRects().length && !element.closest('[hidden]'))
            .filter(element => {
                const rect = element.getBoundingClientRect();
                return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
            }).map(element => element.id || element.className || element.tagName);
    });
    expect(overflow, 'Settings controls stay inside the scrolling pane').toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const [width, height] of [[320, 568], [375, 667], [390, 844], [430, 932], [768, 1024], [844, 390], [1024, 768], [1280, 800]]) {
    const touch = width !== 1280;
    test.describe(`Settings ${width}x${height}`, () => {
        test.use({ viewport: { width, height }, hasTouch: touch });
        test('categories remain reachable while scrolling, controls fit, and drafts survive navigation', async ({ page }) => {
            await openSettings(page, touch);
            for (const id of sections) {
                const tab = page.locator(`#settings-tab-${id}`);
                await expect(tab).toBeInViewport({ ratio: 1 });
                const box = await tab.boundingBox();
                expect(box!.height).toBeGreaterThanOrEqual(44);
                if (touch) await tab.tap(); else await tab.click();
                await expect(tab).toHaveAttribute('aria-selected', 'true');
                await expect(page.getByRole('tabpanel')).toHaveCount(1);
                await fits(page);
                await page.locator('.settings').evaluate(main => main.scrollTop = main.scrollHeight);
                await expect(page.locator('.settings__title')).toBeInViewport({ ratio: 1 });
                for (const other of sections) await expect(page.locator(`#settings-tab-${other}`)).toBeInViewport({ ratio: 1 });
            }
            await page.locator('#settings-tab-appearance').click();
            const checkbox = page.locator('#setting-colorfulIcons');
            const checked = await checkbox.isChecked();
            // The whole label is a touch target, including its wrapped copy.
            const label = checkbox.locator('..');
            if (touch) await label.tap(); else await label.click();
            await expect(checkbox).toBeChecked({ checked: !checked });
            if (touch) {
                const sizes = await page.locator('.settings select:visible').evaluateAll(elements => elements.map(element => parseFloat(getComputedStyle(element).fontSize)));
                expect(sizes.every(size => size >= 16)).toBe(true);
            }
            await page.locator('#settings-tab-database').click();
            const name = page.getByLabel('Vault name', { exact: true });
            if (touch) await name.tap(); else await name.click();
            await name.fill('A long settings draft that survives category changes');
            await expect(name).toBeInViewport({ ratio: 1 });
            const header = await page.locator('.settings__header').boundingBox();
            expect((await name.boundingBox())!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
            await page.getByText('Advanced', { exact: true }).click();
            await fits(page);
            await page.locator('#settings-tab-security').click();
            await page.locator('#settings-tab-database').click();
            await expect(name).toHaveValue('A long settings draft that survives category changes');
            await fits(page);
        });
    });
}

test.describe('Settings long content and rotation', () => {
    test.use({ viewport: { width: 320, height: 568 }, hasTouch: true });
    test('translated largest text, long vault names and close dialog fit after rotation', async ({ page }) => {
        await openSettings(page, true);
        await page.locator('#setting-fontSize').selectOption('2');
        await page.locator('#setting-locale').selectOption('de-DE');
        for (const id of sections) {
            await page.locator(`#settings-tab-${id}`).tap();
            await fits(page);
            await expect(page.locator(`#settings-tab-${id}`)).toBeInViewport({ ratio: 1 });
        }
        await page.locator('#settings-tab-appearance').tap();
        await page.locator('#setting-locale').selectOption('en-US');
        await page.locator('#settings-tab-database').tap();
        const name = page.getByLabel('Vault name', { exact: true });
        const longName = 'VeryLongVaultNameWithoutSpaces'.repeat(5);
        await name.fill(longName);
        await page.getByRole('button', { name: 'Save database settings', exact: true }).click();
        await expect(page.getByRole('status').filter({ hasText: 'Saved in browser storage' })).toBeVisible({ timeout: 30_000 });
        await page.locator('#settings-tab-security').tap();
        await expect(page.locator('.settings__shortcut')).toContainText(longName);
        await fits(page);
        await page.setViewportSize({ width: 844, height: 390 });
        await page.locator('#settings-tab-database').tap();
        await fits(page);
        await page.getByRole('button', { name: 'Close vault', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        const box = await dialog.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(844);
        expect(box!.y + box!.height).toBeLessThanOrEqual(391);
        const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
        await cancel.scrollIntoViewIfNeeded();
        await expect(cancel).toBeInViewport({ ratio: 1 });
        await cancel.tap();
        await expect(dialog).toHaveCount(0);
        await page.setViewportSize({ width: 320, height: 568 });
        await page.locator('#settings-tab-appearance').tap();
        await page.locator('#setting-fontSize').selectOption('0');
        await page.locator('.settings').evaluate(main => main.scrollTop = main.scrollHeight);
        const back = page.getByRole('button', { name: 'Back to vault', exact: true });
        await expect(back).toBeInViewport({ ratio: 1 });
        await back.tap();
        await expect(page.locator('.settings')).toHaveCount(0);
        await expect(page.locator('.entry-row').first()).toBeVisible();
    });
});
