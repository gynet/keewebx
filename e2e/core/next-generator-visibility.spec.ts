import { openStartTools } from './start-tool-controls';
import { test, expect } from '@playwright/test';
for (const width of [320, 1280]) test(`Generator visibility keeps the same password at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.goto('/next.html');
    await openStartTools(page);
    await page.getByRole('button', { name: 'Password generator', exact: true }).click();
    const generator = page.getByRole('region', { name: 'Password generator', exact: true });
    const result = generator.getByLabel('Generated password', { exact: true });
    await expect(result).toBeInViewport();
    for (const label of ['Preset', 'Length', 'Uppercase letters', 'Lowercase letters', 'Digits', 'Symbols']) {
        await expect(generator.getByLabel(label, { exact: true })).toBeVisible();
    }
    for (const label of ['Brackets', 'Extended characters', 'Ambiguous characters', 'Additional characters', 'Pattern']) {
        await expect(generator.getByLabel(label, { exact: true })).toBeHidden();
    }
    await expect(generator.getByRole('button', { name: 'Generate again', exact: true })).toBeInViewport();
    await expect(generator.getByRole('button', { name: 'Copy password', exact: true })).toBeInViewport();
    const original = await result.inputValue();
    expect(original.length).toBeGreaterThan(0);
    await expect(result).toHaveAttribute('type', 'password');
    await generator.getByRole('button', { name: 'Show generated password', exact: true }).click();
    await expect(result).toHaveAttribute('type', 'text');
    await expect(result).toHaveValue(original);
    await generator.getByRole('button', { name: 'Hide generated password', exact: true }).click();
    await expect(result).toHaveAttribute('type', 'password');
    await expect(result).toHaveValue(original);
    await generator.getByRole('button', { name: 'Show generated password', exact: true }).click();
    await generator.getByLabel('Length', { exact: true }).fill('24');
    await expect(result).toHaveAttribute('type', 'text');
    await expect(result).toHaveValue(/^.{24}$/);
    await generator.getByLabel('Preset', { exact: true }).selectOption('Pin4');
    await expect(result).toHaveAttribute('type', 'text');
    await expect(result).toHaveValue(/^\d{4}$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`generator-preview-${width}.png`), fullPage: true });
});

for (const width of [320, 1280]) test.describe(`Generator Advanced at ${width}px`, () => {
    test.use({ viewport: { width, height: 740 }, hasTouch: width === 320 });
    test('keyboard disclosure preserves options and output; collapsed controls stay out of the tab order', async ({ page }) => {
        await page.addInitScript(() => {
            Object.defineProperty(window, 'copiedValues', { value: [] });
            Object.defineProperty(navigator.clipboard, 'writeText', { value: async (text: string) => {
                (window as unknown as { copiedValues: string[] }).copiedValues.push(text);
            } });
        });
        await page.goto('/next.html');
        await openStartTools(page);
        await page.getByRole('button', { name: 'Password generator', exact: true }).click();
        const generator = page.getByRole('region', { name: 'Password generator', exact: true });
        const result = generator.getByLabel('Generated password', { exact: true });
        const advanced = generator.locator('.password-generator__advanced');
        const summary = advanced.locator(':scope > summary');
        const original = await result.inputValue();
        await summary.focus();
        await summary.press('Enter');
        await expect(advanced).toHaveAttribute('open', '');
        await expect(result).toHaveValue(original);
        await page.keyboard.press('Tab');
        await expect(generator.getByLabel('Brackets', { exact: true })).toBeFocused();
        for (const label of ['Brackets', 'Extended characters', 'Ambiguous characters']) {
            await generator.getByLabel(label, { exact: true }).check();
        }
        await generator.getByLabel('Additional characters', { exact: true }).fill('23456789ABCDEFGHJKLMNPQRSTUVWXYZ');
        await generator.getByLabel('Pattern', { exact: true }).fill('I-');
        await generator.getByLabel('Length', { exact: true }).fill('24');
        const candidate = await result.inputValue();
        expect(candidate).toMatch(/^(?:[2-9A-HJ-NP-Z]-){12}$/);
        await summary.focus();
        await summary.press('Space');
        await expect(advanced).not.toHaveAttribute('open');
        await expect(result).toHaveValue(candidate);
        await expect(result).toHaveAttribute('type', 'password');
        await page.keyboard.press('Tab');
        await expect(generator.getByRole('button', { name: 'Generate again', exact: true })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(generator.getByRole('button', { name: 'Copy password', exact: true })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect.poll(() => page.evaluate(() => (window as unknown as { copiedValues: string[] }).copiedValues)).toEqual([candidate]);
        await generator.getByRole('button', { name: 'Generate again', exact: true }).click();
        await expect(result).toHaveValue(/^(?:[2-9A-HJ-NP-Z]-){12}$/);
        await expect(result).not.toHaveValue(candidate);
        const regenerated = await result.inputValue();
        if (width === 320) await summary.tap();
        else await summary.click();
        for (const label of ['Brackets', 'Extended characters', 'Ambiguous characters']) {
            await expect(generator.getByLabel(label, { exact: true })).toBeChecked();
        }
        await expect(generator.getByLabel('Additional characters', { exact: true })).toHaveValue('23456789ABCDEFGHJKLMNPQRSTUVWXYZ');
        await expect(generator.getByLabel('Pattern', { exact: true })).toHaveValue('I-');
        await expect(result).toHaveValue(regenerated);
        expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`generator-advanced-${width}.png`), fullPage: true });
    });
});
