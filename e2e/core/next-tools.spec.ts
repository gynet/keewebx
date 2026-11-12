import { test, expect, type Locator, type Page } from '@playwright/test';
import path from 'path';

const FIXTURE = path.resolve(__dirname, '../../modules/db/resources/KDBX4.1.kdbx');
const editor = (page: Page) => page.locator('.entry-editor');
const entryRow = (page: Page, title: string) => page.locator('.entry-row').filter({
    has: page.getByText(title, { exact: true })
});

async function openFixture(page: Page): Promise<void> {
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', FIXTURE);
    await expect(page.locator('.card__title')).toHaveText('KDBX4.1.kdbx');
    await page.fill('#password', 'test');
    await page.click('#unlock');
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('.entry-row').first().click();
}

async function lockAndReopen(page: Page, title: string): Promise<void> {
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });
    await page.click('#lock');
    await expect(page.locator('.entry-row')).toHaveCount(0, { timeout: 30_000 });
    await page.reload();
    await page.locator('.vault-row[data-vault="KDBX4.1"]').click();
    await page.fill('#password', 'test');
    await page.click('#unlock');
    await expect(entryRow(page, title)).toBeVisible({ timeout: 30_000 });
    await entryRow(page, title).click();
}

async function startEdit(page: Page): Promise<Locator> {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(page)).toBeVisible();
    return editor(page);
}

async function downloadBytes(page: Page, row: Locator): Promise<{ name: string; data: Buffer }> {
    const downloadPromise = page.waitForEvent('download');
    await row.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    if (!stream) {
        throw new Error('The attachment download did not return a stream');
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
    }
    return { name: download.suggestedFilename(), data: Buffer.concat(chunks) };
}

test.describe('New interface entry tools', () => {
    test.setTimeout(120_000);

    test('generates from presets and character sets, changes only the draft, and persists a saved password', async ({ page }) => {
        await openFixture(page);
        let form = await startEdit(page);
        const original = await form.getByLabel('Password', { exact: true }).inputValue();
        await form.getByRole('button', { name: 'Generate password', exact: true }).click();
        let generator = page.getByRole('region', { name: 'Password generator', exact: true });
        await generator.getByLabel('Preset', { exact: true }).selectOption('Pin4');
        await expect(generator.getByLabel('Generated password', { exact: true })).toHaveValue(/^[1-9]{4}$/);
        await expect(form.getByLabel('Password', { exact: true })).toHaveValue(original);

        await generator.getByLabel('Preset', { exact: true }).selectOption('Default');
        await generator.getByLabel('Length', { exact: true }).fill('28');
        await generator.getByLabel('Uppercase letters', { exact: true }).uncheck();
        await generator.getByLabel('Lowercase letters', { exact: true }).uncheck();
        await expect(generator.getByLabel('Generated password', { exact: true })).toHaveValue(/^[1-9]{28}$/);
        await generator.getByLabel('Digits', { exact: true }).uncheck();
        await expect(generator.getByRole('button', { name: 'Use this password', exact: true })).toBeDisabled();
        await expect(generator.getByRole('alert')).toContainText('Select at least one character set');
        await generator.getByLabel('Digits', { exact: true }).check();
        await generator.getByLabel('Lowercase letters', { exact: true }).check();
        await generator.getByRole('button', { name: 'Generate again', exact: true }).click();
        const candidate = await generator.getByLabel('Generated password', { exact: true }).inputValue();
        expect(candidate).toHaveLength(28);
        expect(candidate).toMatch(/^[a-z1-9]+$/);
        expect(candidate).toMatch(/[a-z]/);
        expect(candidate).toMatch(/[1-9]/);
        await generator.getByRole('button', { name: 'Use this password', exact: true }).click();
        await expect(generator).toHaveCount(0);
        await expect(form.getByLabel('Password', { exact: true })).toHaveValue(candidate);
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
        form = await startEdit(page);
        await expect(form.getByLabel('Password', { exact: true })).toHaveValue(original);

        await form.getByRole('button', { name: 'Generate password', exact: true }).click();
        generator = page.getByRole('region', { name: 'Password generator', exact: true });
        await generator.getByLabel('Preset', { exact: true }).selectOption('Long');
        const saved = await generator.getByLabel('Generated password', { exact: true }).inputValue();
        expect(saved).toHaveLength(32);
        await generator.getByRole('button', { name: 'Use this password', exact: true }).click();
        await form.getByLabel('Title', { exact: true }).fill('Generated password entry');
        await form.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.locator('#entry-title')).toHaveText('Generated password entry');
        await lockAndReopen(page, 'Generated password entry');
        form = await startEdit(page);
        await expect(form.getByLabel('Password', { exact: true })).toHaveValue(saved);
        await expect(form.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
    });

    test('handles read errors, downloads exact attachment bytes, and persists upload and removal', async ({ page }) => {
        await openFixture(page);
        const title = await page.locator('#entry-title').innerText();
        const attachments = page.getByRole('region', { name: 'Attachments', exact: true });
        const input = attachments.getByLabel('Attachment file', { exact: true });
        const name = 'fixture-attachment.bin';
        const data = Buffer.concat([Buffer.from('Saved attachment\n中文\n'), Buffer.from([0, 1, 2, 127, 128, 255])]);
        const row = attachments.locator('[data-attachment="fixture-attachment.bin"]');

        // Fail one browser file read, then restore the real API for the retry.
        await page.evaluate(() => {
            const original = File.prototype.arrayBuffer;
            File.prototype.arrayBuffer = function () {
                File.prototype.arrayBuffer = original;
                return Promise.reject(new Error('Unreadable fixture file'));
            };
        });
        await input.setInputFiles({ name, mimeType: 'application/octet-stream', buffer: data });
        await expect(attachments.getByRole('alert')).toContainText('Could not read the attachment');
        await expect(row).toHaveCount(0);
        await input.setInputFiles({ name, mimeType: 'application/octet-stream', buffer: data });
        await expect(row).toBeVisible();
        await expect(attachments.getByRole('button', { name: 'Add attachment', exact: true })).toBeEnabled();
        await expect(attachments.getByRole('alert')).toHaveCount(0);

        // Duplicate names cannot silently overwrite the saved attachment.
        await input.setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('Replacement') });
        await expect(attachments.getByRole('alert')).toContainText('already exists');
        expect(await downloadBytes(page, row)).toEqual({ name, data });
        await lockAndReopen(page, title);
        await expect(row).toBeVisible();
        expect(await downloadBytes(page, row)).toEqual({ name, data });

        await row.getByRole('button', { name: 'Remove attachment', exact: true }).click();
        await expect(row).toHaveCount(0);
        await lockAndReopen(page, title);
        await expect(row).toHaveCount(0);
    });

    test('shows arbitrary website text and only opens normalized HTTP or HTTPS links', async ({ page }) => {
        await openFixture(page);
        const website = page.locator('[data-field="url"]');
        for (const value of [
            'javascript:window.websiteExecuted=true',
            'JaVaScRiPt:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'mailto:test@example.com',
            'java\tscript:alert(1)'
        ]) {
            const form = await startEdit(page);
            await form.getByLabel('Website', { exact: true }).fill(value);
            await form.getByRole('button', { name: 'Save', exact: true }).click();
            await expect(website.locator('.field__value')).toHaveText(value);
            await expect(website.getByRole('link', { name: 'Open', exact: true })).toHaveCount(0);
        }
        for (const [value, normalized] of [
            [' HTTPS://Example.com/a b?q=1 ', 'https://example.com/a%20b?q=1'],
            ['example.com/new', 'https://example.com/new'],
            ['http://example.com/plain', 'http://example.com/plain']
        ]) {
            const form = await startEdit(page);
            await form.getByLabel('Website', { exact: true }).fill(value);
            await form.getByRole('button', { name: 'Save', exact: true }).click();
            const link = website.getByRole('link', { name: 'Open', exact: true });
            await expect(link).toHaveAttribute('href', normalized);
            await expect(link).toHaveAttribute('target', '_blank');
            await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        }
    });
});
