import { test, expect, type Locator } from '@playwright/test';
import { activateVaultUtility } from './vault-utilities';

async function touchTarget(control: Locator) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    // Firefox can report an exact CSS 44px edge as 43.99998474121094.
    expect(bounds!.width).toBeGreaterThanOrEqual(43.99);
    expect(bounds!.height).toBeGreaterThanOrEqual(43.99);
}

async function generatorChrome(dialog: Locator) {
    await expect(dialog.getByRole('heading')).toHaveCount(1);
    await expect(dialog.getByRole('region', { name: 'Password generator', exact: true })).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Close generator', exact: true })).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    await expect(dialog.locator('.password-generator__head')).toHaveCount(0);
    expect(await dialog.getByRole('heading').locator('span').evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el); return range.getClientRects().length;
    })).toBe(1);
    const body = dialog.locator('.prompt-dialog__body');
    const close = dialog.getByRole('button', { name: 'Close generator', exact: true });
    const copy = dialog.getByRole('button', { name: 'Copy password', exact: true });
    expect(await copy.evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el); return range.getClientRects().length;
    })).toBe(1);
    await touchTarget(close);
    for (const end of [true, false]) {
        await body.evaluate((el, end) => { el.scrollTop = end ? el.scrollHeight : 0; }, end);
        await dialog.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        for (const control of [close, copy]) {
            await expect(control).toBeInViewport({ ratio: 1 });
            expect(await control.evaluate(el => {
                const r = el.getBoundingClientRect();
                const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return target === el || el.contains(target);
            })).toBe(true);
        }
        const headerBounds = await dialog.locator('.prompt-dialog__header').boundingBox();
        const previewBounds = await dialog.locator('.password-generator__preview').boundingBox();
        expect(previewBounds!.y).toBeGreaterThanOrEqual(headerBounds!.y + headerBounds!.height - 0.01);
        await expect(dialog.locator('.password-generator__preview')).toBeInViewport({ ratio: 1 });
        if (end) {
            await copy.click();
            await expect(dialog.getByRole('status')).toContainText('Copied');
            await expect(copy).toBeInViewport({ ratio: 1 });
        }
    }
}

for (const colorScheme of ['light', 'dark'] as const) for (const width of [320, 390, 1440]) {
    test(`generator, detail and nested dialog remain usable at ${width}px in ${colorScheme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        await page.emulateMedia({ colorScheme });
        await page.addInitScript(mode => {
            localStorage.setItem('uiTheme', mode);
            localStorage.setItem('appSettings', JSON.stringify({ locale: 'en-US', idleMinutes: 0 }));
        }, colorScheme);
        await page.goto('/next.html');
        const startGenerator = page.getByRole('button', { name: 'Password generator', exact: true });
        await expect(startGenerator).toBeVisible();
        if (width < 760) {
            await touchTarget(startGenerator);
            await touchTarget(page.getByRole('button', { name: 'Settings', exact: true }));
            await touchTarget(page.getByRole('button', { name: 'Switch to dark mode', exact: true }).or(
                page.getByRole('button', { name: 'Switch to light mode', exact: true })));
        }
        await startGenerator.click();
        let generator = page.getByRole('dialog', { name: 'Generate password', exact: true });
        await expect(generator.getByRole('heading', { name: 'Generate password', exact: true })).toBeFocused();
        await expect.poll(() => generator.evaluate(el => el.scrollTop)).toBe(0);
        await generatorChrome(generator);
        const preset = await generator.getByRole('combobox', { name: 'Preset', exact: true }).boundingBox();
        expect(preset!.y).toBeGreaterThan(0);
        expect(preset!.y + preset!.height).toBeLessThan(width === 1440 ? 900 : 844);
        if (width < 760) {
            for (const label of await generator.locator('.password-generator__sets label').all()) await touchTarget(label);
            for (const summary of await generator.locator('summary').all()) if (await summary.isVisible()) await touchTarget(summary);
        }
        await generator.getByRole('button', { name: 'Close generator', exact: true }).click();
        await expect(generator).toHaveCount(0);
        await expect(startGenerator).toBeFocused();
        await page.locator('#open-demo').click();
        await page.locator('.entry-row').filter({ hasText: 'GitHub' }).first().click();
        await expect(page.locator('#entry-title')).toHaveText('GitHub');
        if (width < 760) {
            for (const control of await page.locator('.detail .field__action, .detail .icon-btn, .detail .round').all()) {
                if (await control.isVisible()) await touchTarget(control);
            }
            const lines = await page.locator('[data-field="url"] .field__value').evaluate(el => {
                const range = document.createRange(); range.selectNodeContents(el); return range.getClientRects().length;
            });
            expect(lines).toBe(1);
        }
        await page.locator('[data-field="user"] .field__action').click();
        await expect(page.locator('[data-field="user"] .field__action')).toHaveText('Copied');
        await activateVaultUtility(page, 'Password generator');
        generator = page.getByRole('dialog', { name: 'Generate password', exact: true });
        await expect(generator.getByRole('heading', { name: 'Generate password', exact: true })).toBeFocused();
        await expect.poll(() => generator.evaluate(el => el.scrollTop)).toBe(0);
        await generatorChrome(generator);
        await generator.getByRole('spinbutton', { name: 'Length', exact: true }).fill('0');
        await expect(generator.getByRole('alert')).toContainText('Choose a length from 1 to 128');
        const errorBounds = await generator.getByRole('alert').boundingBox();
        expect(errorBounds!.y).toBeGreaterThan(0);
        expect(errorBounds!.y + errorBounds!.height).toBeLessThan(width === 1440 ? 900 : 844);
        await expect(generator.getByRole('button', { name: 'Copy password', exact: true })).toBeDisabled();
        await page.keyboard.press('Escape');
        await expect(generator).toHaveCount(0);
        if (width < 760) await expect(page.getByRole('button', { name: 'Browse vault', exact: true })).toBeFocused();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        const editor = page.locator('.entry-editor');
        await expect(editor.getByRole('textbox', { name: 'Title', exact: true })).toBeFocused();
        await editor.getByRole('button', { name: 'Generate password', exact: true }).click();
        const inlineGenerator = editor.getByRole('region', { name: 'Password generator', exact: true });
        await expect(inlineGenerator.getByRole('heading', { name: 'Password generator', exact: true })).toBeVisible();
        await expect(inlineGenerator.getByRole('button', { name: 'Close generator', exact: true })).toBeVisible();
        await expect(page.getByRole('dialog', { name: 'Generate password', exact: true })).toHaveCount(0);
        await inlineGenerator.getByRole('button', { name: 'Close generator', exact: true }).click();
        await expect(inlineGenerator).toHaveCount(0);
        if (width < 760) {
            for (const control of await editor.locator('.link, .entry-editor__protect').all()) {
                if (await control.isVisible()) await touchTarget(control);
            }
        }
        await page.keyboard.press('Escape');
        await expect(editor).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
        if (width < 760) {
            await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
            for (const control of await page.locator('.side .nav-row, .side button.tag').all()) await touchTarget(control);
        }
        await activateVaultUtility(page, 'Manage groups');
        const groups = page.getByRole('dialog', { name: 'Groups', exact: true });
        await groups.getByRole('button', { name: 'Work', exact: true }).click();
        await groups.getByRole('button', { name: 'Group actions', exact: true }).click();
        await groups.getByRole('button', { name: 'Rename group', exact: true }).click();
        const rename = page.getByRole('dialog', { name: 'Rename group', exact: true });
        await expect(rename.getByLabel('Group name', { exact: true })).toBeFocused();
        const primary = rename.getByRole('button', { name: 'Save name', exact: true });
        const colors = await primary.evaluate(el => ({
            foreground: getComputedStyle(el).color,
            weight: getComputedStyle(el).fontWeight,
            expected: getComputedStyle(document.documentElement).getPropertyValue('--kx-acc-text').trim()
        }));
        const expectedColor = await page.evaluate(value => {
            const span = document.createElement('span'); span.style.color = value; document.body.append(span);
            const color = getComputedStyle(span).color; span.remove(); return color;
        }, colors.expected);
        expect(colors.foreground).toBe(expectedColor);
        expect(colors.weight).toBe('600');
        await page.keyboard.press('Escape');
        await expect(rename).toHaveCount(0);
        await expect(groups.getByRole('button', { name: 'Rename group', exact: true })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(groups).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
}
