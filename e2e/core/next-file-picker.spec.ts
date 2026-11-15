import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test.use({ serviceWorkers: 'block' });
const database = readFileSync(resolve(__dirname, '../../modules/vault/resources/Demo.kdbx'));
const chosen = (name: string) => ({ name, mimeType: 'application/octet-stream', buffer: database });

for (const width of [320, 1280]) test.describe(`${width}px file picker`, () => {
    test.use({ viewport: { width, height: 800 } });

    test('keeps the native selection available through an asynchronous provider read', async ({ page }) => {
        await page.goto('/next.html');
        await page.evaluate(() => {
            const read = File.prototype.arrayBuffer;
            (window as any).providerSelections = [];
            File.prototype.arrayBuffer = async function () {
                await new Promise(resolve => setTimeout(resolve, 40));
                const input = document.querySelector<HTMLInputElement>('#open-file-input');
                const retained = input?.files?.[0] === this;
                (window as any).providerSelections.push(retained);
                // Model a provider-backed File whose access ends on input reset.
                return retained ? read.call(this) : new ArrayBuffer(0);
            };
        });
        const input = page.locator('#open-file-input');
        await input.setInputFiles(chosen('Provider.kdbx'));
        await expect(page.locator('.card__title')).toHaveText('Provider.kdbx');
        await expect(input).toHaveValue('');
        // The same file must still be selectable again after reading completes.
        await input.setInputFiles(chosen('Provider.kdbx'));
        await expect.poll(() => page.evaluate(() => (window as any).providerSelections)).toEqual([true, true]);
        await expect(input).toHaveValue('');
        await page.locator('#password').fill('demo');
        await page.locator('#unlock').click();
        await expect(page.locator('.entry-row')).toHaveCount(21, { timeout: 30000 });
    });

    test('an incomplete provider read preserves the selected vault and offers a real retry', async ({ page }) => {
        await page.goto('/next.html');
        const input = page.locator('#open-file-input');
        await input.setInputFiles(chosen('Prior.kdbx'));
        await expect(page.locator('.card__title')).toHaveText('Prior.kdbx');
        await page.evaluate(() => {
            const read = File.prototype.arrayBuffer;
            let interrupted = false;
            File.prototype.arrayBuffer = async function () {
                const bytes = await read.call(this);
                if (this.name === 'Cloud.kdbx' && !interrupted) {
                    interrupted = true;
                    return bytes.slice(0, 16); // Valid signature, incomplete file.
                }
                return bytes;
            };
        });
        await input.setInputFiles(chosen('Cloud.kdbx'));
        await expect(page.locator('#open-file-error')).toContainText('could not be read completely');
        await expect(page.locator('.card__title')).toHaveText('Prior.kdbx');
        await page.getByRole('button', { name: 'Retry reading file', exact: true }).click();
        await expect(page.locator('.card__title')).toHaveText('Cloud.kdbx');
        await page.locator('#password').fill('demo');
        await page.locator('#unlock').click();
        await expect(page.locator('.entry-row')).toHaveCount(21, { timeout: 30000 });
    });
});
