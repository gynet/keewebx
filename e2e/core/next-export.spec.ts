import { test, expect, type Browser, type Download, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbxweb from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'export database password';
const originalTitle = 'Original export entry';
const updatedTitle = 'Exported edited entry';
const updatedPassword = 'Edited protected password !982';
const updatedNotes = 'Edited notes\n中文 export fidelity';
const attachment = Buffer.from([0, 1, 2, 10, 127, 128, 200, 255]);
const timeout = 30_000;
type CredentialsMode = 'password' | 'password and key file' | 'key file only';

async function fixture(mode: CredentialsMode = 'password') {
    kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    const secret = mode === 'key file only' ? null : password;
    const key = mode === 'password' ? undefined : await kdbxweb.Credentials.createRandomKeyFile(2);
    const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(
        secret === null ? null : kdbxweb.ProtectedValue.fromString(secret), key
    ), 'Export fixture');
    const group = db.createGroup(db.groups[0], 'Preserved group');
    const entry = db.createEntry(group);
    entry.fields.set('Title', originalTitle);
    entry.fields.set('UserName', 'original-user');
    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('Original protected password'));
    entry.fields.set('Notes', kdbxweb.ProtectedValue.fromString('Original protected notes'));
    entry.fields.set('Recovery code', kdbxweb.ProtectedValue.fromString('Keep this protected recovery code'));
    entry.tags = ['original-tag'];
    entry.binaries.set('proof.bin', await db.createBinary(new Uint8Array(attachment).buffer));
    db.createEntry(group).fields.set('Title', 'Untouched sibling');
    return { secret, key, data: Buffer.from(await db.save()), entryId: entry.uuid.id, groupId: group.uuid.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function decrypt(data: Buffer, secret: string | null, key?: Uint8Array) {
    return kdbxweb.Kdbx.load(new Uint8Array(data).buffer,
        new kdbxweb.Credentials(secret === null ? null : kdbxweb.ProtectedValue.fromString(secret), key));
}
const entries = (db: kdbxweb.Kdbx) => db.groups.flatMap((group) => [...group.allEntries()]);
const fieldText = (entry: kdbxweb.KdbxEntry, field: string) => {
    const value = entry.fields.get(field);
    return value instanceof kdbxweb.ProtectedValue ? value.getText() : value;
};

async function selectCredentials(page: Page, source: Fixture) {
    await page.locator('#password').fill(source.secret ?? '');
    if (source.key) {
        await page.setInputFiles('#unlock-key-file', {
            name: 'export.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(source.key)
        });
        await expect(page.getByRole('button', { name: 'Key file: export.keyx', exact: true })).toBeVisible();
    }
}

async function openBytes(page: Page, source: Fixture, bytes: Buffer = source.data, name = 'export-source.kdbx') {
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', { name, mimeType: 'application/octet-stream', buffer: bytes });
    await selectCredentials(page, source);
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout });
}

async function editEntry(page: Page) {
    await page.locator(`.entry-row[data-entry="${originalTitle}"]`).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('.entry-editor');
    await editor.getByLabel('Title', { exact: true }).fill(updatedTitle);
    await editor.getByLabel('Username', { exact: true }).fill('export-user');
    await editor.getByLabel('Password', { exact: true }).fill(updatedPassword);
    await editor.getByLabel('Website', { exact: true }).fill('https://example.test/export');
    await editor.getByLabel('Notes', { exact: true }).fill(updatedNotes);
    await editor.getByLabel('Tags', { exact: true }).fill('exported, preserved');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#entry-title')).toHaveText(updatedTitle);
}

async function openSettings(page: Page) {
    await page.locator('#open-settings').click();
    const form = page.getByRole('form', { name: /^Database settings: / });
    await expect(form).toBeVisible();
    return form;
}

async function downloadBytes(page: Page) {
    const pending = page.waitForEvent('download', { timeout });
    await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    const stream = await download.createReadStream();
    if (!stream) throw new Error('The encrypted export returned no download stream');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    expect(download.suggestedFilename()).toMatch(/\.kdbx$/i);
    expect(data.subarray(0, 8)).toEqual(Buffer.from([3, 217, 162, 154, 103, 251, 75, 181]));
    expect(data.readUInt16LE(10)).toBe(4);
    await test.info().attach(download.suggestedFilename(), { body: data, contentType: 'application/octet-stream' });
    return { data, name: download.suggestedFilename() };
}

async function expectFidelity(data: Buffer, source: Fixture) {
    expect(data.includes(Buffer.from(updatedPassword))).toBe(false);
    expect(data.includes(Buffer.from(updatedNotes))).toBe(false);
    const db = await decrypt(data, source.secret, source.key);
    const target = entries(db).find((entry) => entry.uuid.id === source.entryId);
    expect(target).toBeDefined();
    expect(fieldText(target!, 'Title')).toBe(updatedTitle);
    expect(fieldText(target!, 'UserName')).toBe('export-user');
    expect(fieldText(target!, 'Password')).toBe(updatedPassword);
    expect(fieldText(target!, 'URL')).toBe('https://example.test/export');
    expect(fieldText(target!, 'Notes')).toBe(updatedNotes);
    expect(target!.fields.get('Password')).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(target!.fields.get('Notes')).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(target!.fields.get('Recovery code')).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(fieldText(target!, 'Recovery code')).toBe('Keep this protected recovery code');
    expect(target!.tags).toEqual(['exported', 'preserved']);
    expect(target!.parentGroup?.uuid.id).toBe(source.groupId);
    expect(target!.history.some((entry) => fieldText(entry, 'Title') === originalTitle)).toBe(true);
    expect(entries(db).some((entry) => fieldText(entry, 'Title') === 'Untouched sibling')).toBe(true);
    const binary = target!.binaries.get('proof.bin');
    expect(kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary)).toBe(true);
    if (!kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary)) throw new Error('Export lost its attachment reference');
    const binaryBytes = binary.value instanceof kdbxweb.ProtectedValue
        ? binary.value.getBinary() : new Uint8Array(binary.value);
    expect(Buffer.from(binaryBytes)).toEqual(attachment);
    const original = await decrypt(source.data, source.secret, source.key);
    for (const parameter of ['$UUID', 'I', 'M', 'P']) {
        expect(db.header.kdfParameters!.get(parameter)).toEqual(original.header.kdfParameters!.get(parameter));
    }
}

async function reopenFresh(browser: Browser, page: Page, source: Fixture, data: Buffer) {
    const fresh = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
        const reopened = await fresh.newPage();
        await openBytes(reopened, source, data);
        await reopened.locator(`.entry-row[data-entry="${updatedTitle}"]`).click();
        await reopened.getByRole('button', { name: 'Edit', exact: true }).click();
        const editor = reopened.locator('.entry-editor');
        await expect(editor.getByLabel('Password', { exact: true })).toHaveValue(updatedPassword);
        await expect(editor.getByLabel('Notes', { exact: true })).toHaveValue(updatedNotes);
    } finally { await fresh.close(); }
}

test.describe('New encrypted KDBX export', () => {
    test.setTimeout(90_000);

    for (const mode of ['password', 'password and key file', 'key file only'] as const) {
        test(`exports modified data and reopens using ${mode}`, async ({ page, browser }, testInfo) => {
            const source = await fixture(mode);
            await openBytes(page, source);
            await editEntry(page);
            await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
            await openSettings(page);
            if (mode === 'password') {
                await page.getByRole('button', { name: 'Download KDBX', exact: true }).scrollIntoViewIfNeeded();
                await page.screenshot({ path: testInfo.outputPath('export-controls-desktop.png'), fullPage: true });
                const viewport = page.viewportSize()!;
                await page.setViewportSize({ width: 320, height: 700 });
                await page.getByRole('button', { name: 'Download KDBX', exact: true }).scrollIntoViewIfNeeded();
                await page.screenshot({ path: testInfo.outputPath('export-controls-320.png'), fullPage: true });
                await page.setViewportSize(viewport);
            }
            const exported = await downloadBytes(page);
            expect(exported.name).toBe('export-source.kdbx');
            await expectFidelity(exported.data, source);
            await expect(decrypt(exported.data, 'wrong export password', source.key)).rejects.toMatchObject({ code: 'InvalidKey' });
            if (source.key) {
                await expect(decrypt(exported.data, source.secret)).rejects.toMatchObject({ code: 'InvalidKey' });
                const wrongKey = await kdbxweb.Credentials.createRandomKeyFile(2);
                await expect(decrypt(exported.data, source.secret, wrongKey)).rejects.toMatchObject({ code: 'InvalidKey' });
            }
            await reopenFresh(browser, page, source, exported.data);
        });
    }

    test('Classic opens a New download without relying on the New browser cache', async ({ page, browser }) => {
        const source = await fixture();
        await openBytes(page, source);
        await editEntry(page);
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        await openSettings(page);
        const exported = await downloadBytes(page);
        const fresh = await browser.newContext({ baseURL: new URL(page.url()).origin });
        try {
            const classic = await fresh.newPage();
            await classic.goto('/index.html?ui=classic');
            const chooser = classic.waitForEvent('filechooser');
            await classic.locator('#open__icon-open').click();
            await (await chooser).setFiles({ name: exported.name, mimeType: 'application/octet-stream', buffer: exported.data });
            await classic.locator('.modal button[data-result="ok"]').click();
            await expect(classic.locator('.open__pass-input')).not.toHaveAttribute('readonly', '');
            await classic.locator('.open__pass-input').fill(password);
            await classic.locator('.open__pass-enter-btn').click();
            const row = classic.locator('.list__item').filter({ hasText: updatedTitle });
            await expect(row).toBeVisible({ timeout });
            await row.click();
            await expect(classic.locator('.details__header-title')).toHaveText(updatedTitle);
        } finally { await fresh.close(); }
    });

    for (const draft of ['database', 'entry'] as const) {
        test(`flushes an unsaved ${draft} draft into the downloaded bytes`, async ({ page, browser }) => {
            const source = await fixture();
            await openBytes(page, source);
            if (draft === 'entry') {
                await page.locator(`.entry-row[data-entry="${originalTitle}"]`).click();
                await page.getByRole('button', { name: 'Edit', exact: true }).click();
                await page.locator('.entry-editor').getByLabel('Title', { exact: true }).fill('Uncommitted export draft');
            }
            const form = await openSettings(page);
            if (draft === 'database') await form.getByLabel('Vault name', { exact: true }).fill('Uncommitted database name');
            const exported = await downloadBytes(page);
            const db = await decrypt(exported.data, source.secret, source.key);
            const target = entries(db).find((entry) => entry.uuid.id === source.entryId)!;
            expect(fieldText(target, 'Title')).toBe(draft === 'entry' ? 'Uncommitted export draft' : originalTitle);
            if (draft === 'database') expect(db.meta.name).toBe('Uncommitted database name');
            const fresh = await browser.newContext({ baseURL: new URL(page.url()).origin });
            try {
                const reopened = await fresh.newPage();
                await openBytes(reopened, source, exported.data, exported.name);
                await expect(reopened.locator('.entry-row').filter({ hasText: draft === 'entry' ? 'Uncommitted export draft' : originalTitle })).toBeVisible();
                if (draft === 'database') await expect((await openSettings(reopened)).getByLabel('Vault name', { exact: true })).toHaveValue('Uncommitted database name');
            } finally { await fresh.close(); }
        });
    }

    test('invalid KDF draft blocks stale export and preserves the existing encrypted settings', async ({ page }) => {
        const source = await fixture();
        await openBytes(page, source);
        const form = await openSettings(page);
        await form.getByText('Advanced', { exact: true }).click();
        await form.getByLabel('Memory, KiB', { exact: true }).fill('8');
        await form.getByLabel('Parallelism', { exact: true }).fill('4');
        const downloads: Download[] = [];
        const record = (download: Download) => { downloads.push(download); };
        page.on('download', record);
        try {
            await form.getByRole('button', { name: 'Download KDBX', exact: true }).click();
            await expect(form.getByRole('status')).toContainText(/invalid|memory|fail|unable|could not|resolve/i);
            await expect(form.getByLabel('Memory, KiB', { exact: true })).toHaveValue('8');
            await expect(form.getByRole('button', { name: 'Download KDBX', exact: true })).toBeEnabled();
            expect(downloads).toHaveLength(0);
        } finally { page.off('download', record); }
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
        await openSettings(page);
        const exported = await downloadBytes(page);
        const db = await decrypt(exported.data, source.secret);
        const original = await decrypt(source.data, source.secret);
        for (const parameter of ['$UUID', 'I', 'M', 'P']) {
            expect(db.header.kdfParameters!.get(parameter)).toEqual(original.header.kdfParameters!.get(parameter));
        }
        expect(fieldText(entries(db).find((entry) => entry.uuid.id === source.entryId)!, 'Title')).toBe(originalTitle);
    });

    test('reports encryption failure without downloading and allows a clean retry', async ({ page, browser }) => {
        const source = await fixture();
        await openBytes(page, source);
        await editEntry(page);
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        const form = await openSettings(page);
        // Fault the browser cryptography boundary once, not the application/helper.
        await page.evaluate(() => {
            const encrypt = SubtleCrypto.prototype.encrypt;
            SubtleCrypto.prototype.encrypt = function () {
                SubtleCrypto.prototype.encrypt = encrypt;
                return Promise.reject(new Error('Simulated export encryption failure'));
            };
        });
        const downloads: Download[] = [];
        const record = (download: Download) => { downloads.push(download); };
        page.on('download', record);
        try {
            await form.getByRole('button', { name: 'Download KDBX', exact: true }).click();
            await expect(form.getByRole('status')).toContainText(/fail|unable|could not/i);
            expect(downloads).toHaveLength(0);
            await expect(form.getByRole('button', { name: 'Download KDBX', exact: true })).toBeEnabled();
            await expect(form.getByLabel('Vault name', { exact: true })).toHaveValue('export-source');
        } finally { page.off('download', record); }
        const exported = await downloadBytes(page);
        await expectFidelity(exported.data, source);
        await reopenFresh(browser, page, source, exported.data);
    });

    test('exports valid changed bytes while a browser save is still encrypting, then reopens both outputs', async ({ page, browser }) => {
        const source = await fixture('password and key file');
        await openBytes(page, source);
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        let savePaused = false;
        await page.exposeFunction('sdetEncryptionPaused', () => { savePaused = true; });
        // Pause one real browser crypto operation in the UI-triggered save. A second
        // serializer can run normally; neither model nor application APIs are replaced.
        await page.evaluate(() => {
            const encrypt = SubtleCrypto.prototype.encrypt;
            SubtleCrypto.prototype.encrypt = async function (...args: Parameters<SubtleCrypto['encrypt']>) {
                SubtleCrypto.prototype.encrypt = encrypt;
                const released = new Promise<void>((resolve) => window.addEventListener('sdet-release-encryption', () => resolve(), { once: true }));
                await (window as unknown as { sdetEncryptionPaused: () => Promise<void> }).sdetEncryptionPaused();
                await released;
                return encrypt.apply(this, args);
            };
        });
        try {
            await editEntry(page);
            await expect.poll(() => savePaused, { timeout }).toBe(true);
            await expect(page.locator('#sync-state')).not.toHaveText('Up to date');
            await openSettings(page);
            const exported = await downloadBytes(page);
            await expectFidelity(exported.data, source);
            await expect(page.locator('#sync-state')).not.toHaveText('Up to date');
            await reopenFresh(browser, page, source, exported.data);
        } finally {
            await page.evaluate(() => window.dispatchEvent(new Event('sdet-release-encryption')));
        }
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        await page.reload();
        await selectCredentials(page, source);
        await page.locator('#unlock').click();
        await expect(page.locator(`.entry-row[data-entry="${updatedTitle}"]`)).toBeVisible({ timeout });
        await openSettings(page);
        await expectFidelity((await downloadBytes(page)).data, source);
    });

    test('exports local edits after remote write failure without claiming the remote vault is saved', async ({ page, browser }) => {
        const source = await fixture();
        let failedWrites = 0;
        const server = createServer((request, response) => {
            response.setHeader('Access-Control-Allow-Origin', request.headers.origin || '*');
            response.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT, MOVE');
            response.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, Destination, Overwrite, If-Match, If-None-Match');
            response.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
            response.setHeader('Cache-Control', 'no-store');
            if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
            if (request.method === 'GET' || request.method === 'HEAD') {
                response.setHeader('Last-Modified', 'Thu, 12 Nov 2026 00:00:00 GMT');
                response.setHeader('ETag', '"original-export-revision"');
                response.writeHead(200).end(request.method === 'GET' ? source.data : undefined);
            } else {
                failedWrites++;
                request.resume();
                response.writeHead(503).end();
            }
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        try {
            await page.goto('/next.html');
            await page.locator('#open-webdav').click();
            await page.locator('#webdav-url').fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}/export-source.kdbx`);
            await page.locator('#webdav-next').click();
            await page.locator('#password').fill(password);
            await page.locator('#unlock').click();
            await expect(page.locator('.entry-row').first()).toBeVisible({ timeout });
            await editEntry(page);
            await expect.poll(() => failedWrites, { timeout }).toBeGreaterThan(0);
            await expect(page.locator('#sync-state')).toHaveText('Offline, saved on this device', { timeout });
            await openSettings(page);
            const exported = await downloadBytes(page);
            await expectFidelity(exported.data, source);
            await expect(page.locator('#sync-state')).toHaveText('Offline, saved on this device', { timeout });
            await reopenFresh(browser, page, source, exported.data);
            // The server always served the original encrypted revision; export is not a remote save.
            expect(fieldText(entries(await decrypt(source.data, source.secret)).find((entry) => entry.uuid.id === source.entryId)!, 'Title')).toBe(originalTitle);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
