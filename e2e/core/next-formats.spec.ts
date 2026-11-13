import { test, expect, type Page, type Locator } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'formats fixture password';
const importedPassword = 'new import master password';
const attack = '<img src=x onerror="window.injected=1"> & 雪';
const secret = ' \\\\secret, "雪"  ';
const csv = '\uFEFFTitle,Login,Password,Notes,Custom,Ignore me\r\n"雪, first",user," \\\\secret, ""雪""  ","line 1\r\nline\t2",tail  ,unused\r\nsecond,other,,simple,,unused\r\n';
const credentials = (value = password) => new kdbx.Credentials(kdbx.ProtectedValue.fromString(value));
const allEntries = (db: kdbx.Kdbx) => db.groups.flatMap(group => [...group.allEntries()]);
const field = (entry: kdbx.KdbxEntry, name: string) => {
    const value = entry.fields.get(name);
    return value instanceof kdbx.ProtectedValue ? value.getText() : value;
};
async function fixture() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(credentials(), 'Formats');
    const group = db.createGroup(db.createGroup(db.groups[0], 'Team'), 'Accounts');
    const entry = db.createEntry(group);
    entry.fields.set('Title', 'Original account');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('earlier secret'));
    entry.pushHistory();
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('current secret'));
    entry.fields.set('Notes', kdbx.ProtectedValue.fromString('protected notes\n雪'));
    entry.fields.set(attack, kdbx.ProtectedValue.fromString(attack));
    entry.fields.set('URL', 'javascript:window.injected=1');
    entry.binaries.set('proof "<&>.bin', await db.createBinary(new Uint8Array([0, 10, 128, 255])));
    return { bytes: Buffer.from(await db.save()), xml: await db.saveXml(true), id: entry.uuid.id, group: group.uuid.id };
}
async function open(page: Page, source: Awaited<ReturnType<typeof fixture>>) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'Formats.kdbx', mimeType: 'application/octet-stream', buffer: source.bytes });
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout: 30_000 });
}
async function settings(page: Page) {
    const nav = page.getByRole('navigation', { name: 'Vault', exact: true });
    if (!await nav.isVisible()) await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
    await nav.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
}
const importer = (page: Page) => page.getByRole('region', { name: 'Import data', exact: true });
async function choose(page: Page, name: string, data: string) {
    const picker = page.waitForEvent('filechooser');
    await importer(page).getByRole('button', { name: 'Choose XML or CSV', exact: true }).click();
    await (await picker).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(data) });
    await expect(page.getByRole('form', { name: 'Import preview' })).toBeVisible();
}
async function download(page: Page, control: Locator, extension: string, consent = false) {
    if (consent) page.once('dialog', async dialog => {
        expect(dialog.message()).toContain('unencrypted');
        expect(dialog.message()).toContain('secrets');
        await dialog.accept();
    });
    const waiting = page.waitForEvent('download');
    await control.click();
    const result = await waiting;
    expect(await result.failure()).toBeNull();
    expect(result.suggestedFilename()).toMatch(new RegExp(`\\.${extension}$`));
    const chunks: Buffer[] = [];
    for await (const chunk of (await result.createReadStream())!) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    await test.info().attach(result.suggestedFilename(), { body: bytes, contentType: 'application/octet-stream' });
    return bytes;
}
async function encrypted(page: Page, name = 'Formats', pw = password) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const form = page.getByRole('form', { name: `Database settings: ${name}`, exact: true });
    const data = await download(page, form.getByRole('button', { name: 'Download KDBX', exact: true }), 'kdbx');
    return kdbx.Kdbx.load(new Uint8Array(data).buffer, credentials(pw));
}
function fidelity(db: kdbx.Kdbx, source: Awaited<ReturnType<typeof fixture>>) {
    const entry = allEntries(db).find(entry => entry.uuid.id === source.id)!;
    expect(entry.parentGroup?.uuid.id).toBe(source.group);
    expect(entry.fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
    expect(field(entry, 'Password')).toBe('current secret');
    expect(entry.fields.get('Notes')).toBeInstanceOf(kdbx.ProtectedValue);
    expect(field(entry, 'Notes')).toBe('protected notes\n雪');
    expect(entry.fields.get(attack)).toBeInstanceOf(kdbx.ProtectedValue);
    expect(field(entry, attack)).toBe(attack);
    expect(entry.history).toHaveLength(1);
    expect(field(entry.history[0], 'Password')).toBe('earlier secret');
    expect((entry.binaries.get('proof "<&>.bin') as { value: ArrayBuffer }).value).toEqual(new Uint8Array([0, 10, 128, 255]).buffer);
}
function csvFidelity(db: kdbx.Kdbx, group?: string) {
    const imported = allEntries(db).filter(entry => ['雪, first', 'second'].includes(String(field(entry, 'Title'))));
    expect(imported).toHaveLength(2);
    if (group) for (const entry of imported) expect(entry.parentGroup?.uuid.id).toBe(group);
    const first = imported.find(entry => field(entry, 'Title') === '雪, first')!;
    expect(field(first, 'UserName')).toBe('user');
    expect(field(first, 'Password')).toBe(secret);
    expect(first.fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
    expect(field(first, 'Notes')).toBe('line 1\r\nline\t2');
    expect(field(first, 'Custom')).toBe('tail  ');
    expect(first.fields.has('Ignore me')).toBe(false);
    expect(field(imported.find(entry => field(entry, 'Title') === 'second')!, 'Password')).toBe('');
}

for (const viewport of [{ width: 1280, height: 850 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    test.describe(`${viewport.width}px formats`, () => {
        test.use({ viewport });
        test('XML and readable HTML downloads require consent; XML imports and encrypted reads preserve content', async ({ page, context }) => {
            const source = await fixture();
            await open(page, source); await settings(page);
            const downloads: unknown[] = [];
            page.on('download', value => downloads.push(value));
            for (const name of ['Export XML', 'Export HTML']) {
                page.once('dialog', dialog => dialog.dismiss());
                await page.getByRole('button', { name, exact: true }).click();
                await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
            }
            expect(downloads).toHaveLength(0);
            const xml = await download(page, page.getByRole('button', { name: 'Export XML', exact: true }), 'xml', true);
            const parsed = await kdbx.Kdbx.loadXml(xml.toString(), credentials());
            fidelity(parsed, source);
            const html = await download(page, page.getByRole('button', { name: 'Export HTML', exact: true }), 'html', true);
            const readable = await context.newPage();
            // Read the actual download outside the app's service-worker routing.
            await readable.setContent(html.toString());
            await expect(readable.getByRole('heading', { name: 'Original account' })).toBeVisible();
            await expect(readable.locator('td').filter({ hasText: 'current secret' })).toBeVisible();
            await expect(readable.locator('img, script, iframe')).toHaveCount(0);
            await expect(readable.getByRole('cell', { name: attack, exact: true })).toHaveCount(1);
            expect(await readable.evaluate(() => (window as unknown as { injected?: number }).injected)).toBeUndefined();
            const attachment = readable.getByRole('link', { name: 'proof "<&>.bin' });
            expect(await attachment.getAttribute('href')).toBe('data:application/octet-stream;base64,AAqA/w==');
            await readable.screenshot({ path: test.info().outputPath('readable-html.png'), fullPage: true });
            await readable.close();
            await choose(page, 'Imported.xml', xml.toString());
            await page.getByLabel('Import master password', { exact: true }).fill(importedPassword);
            await page.getByLabel('Confirm import password', { exact: true }).fill(importedPassword);
            await page.getByRole('button', { name: 'Import', exact: true }).click();
            await expect(page.getByRole('form', { name: 'Database settings: Imported', exact: true })).toBeVisible();
            fidelity(await encrypted(page, 'Imported', importedPassword), source);
            fidelity(await encrypted(page), source);
        });

        test('CSV preview, mapping and selected nested destination preserve values; duplicate mappings and cancel are inert', async ({ page }) => {
            const source = await fixture();
            await open(page, source); await settings(page); await choose(page, 'Mapped.csv', csv);
            await page.getByLabel('Show preview values (includes secrets)').check();
            await expect(page.getByRole('region', { name: 'CSV rows' })).toContainText('雪, first');
            await page.getByRole('combobox', { name: 'Column 6: Ignore me', exact: true }).selectOption('');
            const options = await page.getByRole('combobox', { name: 'Import destination', exact: true }).locator('option').allTextContents();
            await page.getByRole('combobox', { name: 'Import destination', exact: true }).selectOption({ label: options.find(value => value.includes('Team / Accounts'))! });
            await page.getByRole('combobox', { name: 'Column 2: Login', exact: true }).selectOption('Title');
            await page.getByRole('button', { name: 'Import', exact: true }).click();
            await expect(importer(page).getByRole('status')).toContainText('distinct');
            await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
            expect(allEntries(await encrypted(page))).toHaveLength(1);
            await choose(page, 'Mapped.csv', csv);
            await page.getByRole('combobox', { name: 'Column 6: Ignore me', exact: true }).selectOption('');
            await page.getByRole('combobox', { name: 'Import destination', exact: true }).selectOption({ label: options.find(value => value.includes('Team / Accounts'))! });
            await page.screenshot({ path: test.info().outputPath('csv-mapping.png'), fullPage: true });
            await page.getByRole('button', { name: 'Import', exact: true }).scrollIntoViewIfNeeded();
            await expect(page.getByText('Destination: Formats: Formats / Team / Accounts', { exact: true })).toBeVisible();
            await page.screenshot({ path: test.info().outputPath('csv-destination.png'), fullPage: true });
            await page.getByRole('button', { name: 'Import', exact: true }).click();
            await expect(importer(page).getByRole('status')).toContainText('Import complete');
            const result = await encrypted(page);
            expect(allEntries(result)).toHaveLength(3);
            csvFidelity(result, source.group); fidelity(result, source);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        });

        test('start-screen CSV import requires a password and produces a new encrypted vault', async ({ page }) => {
            await page.goto('/next.html');
            await page.getByRole('button', { name: 'Import XML or CSV', exact: true }).click();
            await choose(page, 'New CSV.csv', csv);
            await page.getByRole('combobox', { name: 'Column 6: Ignore me', exact: true }).selectOption('');
            await page.getByLabel('Import master password', { exact: true }).fill(importedPassword);
            await page.getByLabel('Confirm import password', { exact: true }).fill('wrong');
            await page.getByRole('button', { name: 'Import', exact: true }).click();
            await expect(importer(page).getByRole('status')).toContainText('Passwords do not match');
            await page.getByLabel('Confirm import password', { exact: true }).fill(importedPassword);
            await page.getByRole('button', { name: 'Import', exact: true }).click();
            await expect(page.locator('.entry-row').first()).toBeVisible({ timeout: 30_000 });
            await settings(page);
            csvFidelity(await encrypted(page, 'New CSV', importedPassword));
        });

        test('malformed XML and pending database drafts leave the current vault unchanged', async ({ page }) => {
            const source = await fixture();
            await open(page, source); await settings(page); await choose(page, 'Broken.xml', '<not-keepass/>');
            await page.getByLabel('Import master password', { exact: true }).fill(importedPassword);
            await page.getByLabel('Confirm import password', { exact: true }).fill(importedPassword);
            await page.getByRole('button', { name: 'Import', exact: true }).click();
            await expect(importer(page).getByRole('status')).toContainText(/Error|bad|invalid|corrupt/i);
            await expect(page.getByRole('form', { name: /^Database settings:/ })).toHaveCount(1);
            await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
            await page.getByLabel('Vault name', { exact: true }).fill('Pending name');
            await page.getByRole('button', { name: 'Export XML', exact: true }).click();
            await expect(page.getByText('Apply or discard unsaved edits before exporting.', { exact: true })).toBeVisible();
            const picker = page.waitForEvent('filechooser');
            await importer(page).getByRole('button', { name: 'Choose XML or CSV' }).click();
            await (await picker).setFiles({ name: 'Blocked.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
            await expect(importer(page).getByRole('status')).toContainText('unsaved edits');
            await expect(page.getByRole('form', { name: 'Import preview' })).toHaveCount(0);
            await page.getByLabel('Vault name', { exact: true }).fill('Formats');
            fidelity(await encrypted(page), source);
        });
    });
}

test('canceling an in-flight file read never publishes its late preview', async ({ page }) => {
    await page.goto('/next.html');
    await page.getByRole('button', { name: 'Import XML or CSV', exact: true }).click();
    await page.evaluate(() => {
        const original = File.prototype.text;
        File.prototype.text = function () {
            return new Promise(resolve => {
                (window as unknown as { releaseRead(): void }).releaseRead = () => { void original.call(this).then(resolve); };
            });
        };
    });
    const picker = page.waitForEvent('filechooser');
    await importer(page).getByRole('button', { name: 'Choose XML or CSV' }).click();
    await (await picker).setFiles({ name: 'Late.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.getByText('Preparing import…', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
    await page.evaluate(() => (window as unknown as { releaseRead(): void }).releaseRead());
    await expect(page.getByRole('form', { name: 'Import preview' })).toHaveCount(0);
    await expect(importer(page).getByRole('button', { name: 'Choose XML or CSV' })).toBeEnabled();
});
