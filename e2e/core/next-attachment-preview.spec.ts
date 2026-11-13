import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const fixture = path.resolve(__dirname, '../../modules/db/resources/KDBX4.1.kdbx');
const payload = '<svg onload="window.attachmentExecuted=true"><script>window.attachmentExecuted=true</script></svg>';
const files = [
    { name: 'readme.txt', mimeType: 'text/plain', buffer: Buffer.from('Batch attachment\n中文\n') },
    { name: 'escaped.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(payload) },
    { name: 'preview.png', mimeType: 'image/png', buffer: readFileSync(path.resolve(__dirname, '../fixtures/otp-qr.png')) }
];
const region = (page: Page) => page.getByRole('region', { name: 'Attachments', exact: true });
const row = (page: Page, name: string) => region(page).locator(`[data-attachment="${name}"]`);
async function open(page: Page) {
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', fixture);
    await page.locator('#password').fill('test');
    await page.locator('#unlock').click();
    await page.locator('.entry-row').first().click();
}
async function exactDownload(page: Page, name: string, bytes: Buffer) {
    const pending = page.waitForEvent('download');
    await row(page, name).getByRole('button', { name: 'Download', exact: true }).click();
    const download = await pending;
    const chunks: Buffer[] = [];
    const stream = await download.createReadStream();
    if (!stream) throw new Error('Download stream missing');
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(download.suggestedFilename()).toBe(name);
    expect(Buffer.concat(chunks)).toEqual(bytes);
}
for (const width of [1280, 320]) test(`batch upload, inert previews and encrypted reopen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const title = await page.locator('#entry-title').innerText();
    await region(page).getByLabel('Attachment file', { exact: true }).setInputFiles(files);
    for (const file of files) await expect(row(page, file.name)).toBeVisible();
    await row(page, 'escaped.svg').getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByLabel('Attachment text', { exact: true })).toHaveText(payload);
    expect(await page.evaluate(() => (window as any).attachmentExecuted)).toBeUndefined();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await row(page, 'preview.png').getByRole('button', { name: 'Preview', exact: true }).click();
    await expect.poll(() => page.getByRole('dialog').locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30000 });
    await page.getByRole('button', { name: 'Lock', exact: true }).filter({ visible: true }).click();
    await expect(page.locator('.entry-row')).toHaveCount(0);
    await page.reload();
    await page.locator('.vault-row[data-vault="KDBX4.1"]').click();
    await page.locator('#password').fill('test');
    await page.locator('#unlock').click();
    await page.locator('.entry-row').filter({ has: page.getByText(title, { exact: true }) }).click();
    for (const file of files) await exactDownload(page, file.name, file.buffer);
});

test('failed reads and duplicates leave the entire batch unpublished; drop supports multiple files', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
        const original = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = function () {
            if (this.name !== 'escaped.svg') return original.call(this);
            File.prototype.arrayBuffer = original;
            return Promise.reject(new Error('Synthetic read failure'));
        };
    });
    const input = region(page).getByLabel('Attachment file', { exact: true });
    await input.setInputFiles(files);
    await expect(region(page).getByRole('alert')).toContainText('Could not read');
    for (const file of files) await expect(row(page, file.name)).toHaveCount(0);
    const transfer = await page.evaluateHandle(items => {
        const dt = new DataTransfer();
        for (const item of items) dt.items.add(new File([new Uint8Array(item.bytes)], item.name, { type: item.mimeType }));
        return dt;
    }, files.map(file => ({ name: file.name, mimeType: file.mimeType, bytes: [...file.buffer] })));
    await region(page).dispatchEvent('drop', { dataTransfer: transfer });
    for (const file of files) await expect(row(page, file.name)).toBeVisible();
    await input.setInputFiles([files[0], { name: 'unpublished.txt', mimeType: 'text/plain', buffer: Buffer.from('No partial batch') }]);
    await expect(region(page).getByRole('alert')).toContainText('already exists');
    await expect(row(page, 'unpublished.txt')).toHaveCount(0);
    await exactDownload(page, files[0].name, files[0].buffer);
});
