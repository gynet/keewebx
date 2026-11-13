import { test, expect, type Page, type Download } from '@playwright/test';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const originalPassword = 'Disposable original credentials';
const changedPassword = 'Disposable changed credentials';
const title = 'Preserved credential-change record';
const secret = 'Preserve this entry secret';
const timeout = 30_000;
type Factors = { password: string; key?: Uint8Array };
const initial: Factors = { password: originalPassword };
const payload = (bytes: Uint8Array, name = 'replacement.keyx') => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
const credentials = (page: Page) => page.getByRole('region', { name: 'Database credentials', exact: true });
const settings = (page: Page) => page.getByRole('form', { name: /^Database settings: / });

// Use the supported shared settings UI: automatic timers must not move the reset baseline
// while the test independently decrypts snapshots. Explicit Save remains exercised below.
async function disableAutomaticSave(page: Page) {
    await page.goto('/index.html?ui=classic');
    if (!(await page.locator('#open__icon-settings').isVisible())) await page.locator('#open__icon-more').click();
    await page.locator('#open__icon-settings').click();
    await page.locator('#settings__general-auto-save-interval').selectOption('0');
    await page.reload();
    if (!(await page.locator('#open__icon-settings').isVisible())) await page.locator('#open__icon-more').click();
    await page.locator('#open__icon-settings').click();
    await expect(page.locator('#settings__general-auto-save-interval')).toHaveValue('0');
}

async function fixture() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(originalPassword)), 'Credentials fixture');
    const group = db.createGroup(db.groups[0], 'Preserved group');
    const entry = db.createEntry(group);
    entry.fields.set('Title', title);
    entry.fields.set('Password', kdbx.ProtectedValue.fromString(secret));
    entry.fields.set('Notes', 'Keep notes through credential changes');
    return { bytes: Buffer.from(await db.save()), entryId: entry.uuid.id, groupId: group.uuid.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function decrypt(bytes: Buffer, factors: Factors) {
    return kdbx.Kdbx.load(new Uint8Array(bytes).buffer,
        new kdbx.Credentials(kdbx.ProtectedValue.fromString(factors.password), factors.key));
}
async function proves(bytes: Buffer, source: Fixture, accepted: Factors, rejected: Factors[]) {
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([3, 217, 162, 154, 103, 251, 75, 181]));
    expect(bytes.includes(Buffer.from(secret))).toBe(false);
    const reopened = await decrypt(bytes, accepted);
    const entry = reopened.groups.flatMap(group => [...group.allEntries()]).find(entry => entry.uuid.id === source.entryId);
    expect(entry?.fields.get('Title')).toBe(title);
    expect(entry?.parentGroup?.uuid.id).toBe(source.groupId);
    expect((entry?.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe(secret);
    expect(entry?.fields.get('Notes')).toBe('Keep notes through credential changes');
    for (const wrong of rejected) await expect(decrypt(bytes, wrong)).rejects.toThrow();
}
async function unlock(page: Page, factors: Factors) {
    await page.locator('#password').fill(factors.password);
    if (factors.key) await page.locator('#unlock-key-file').setInputFiles(payload(factors.key));
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout });
}
async function open(page: Page, source: Fixture, name = 'credentials.kdbx') {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles(payload(source.bytes, name));
    await unlock(page, initial);
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
}
async function passwordDraft(page: Page, password: string, confirmation = password) {
    await credentials(page).getByLabel('New master password', { exact: true }).fill(password);
    await credentials(page).getByLabel('Confirm new master password', { exact: true }).fill(confirmation);
}
async function apply(page: Page) {
    await credentials(page).getByRole('button', { name: 'Apply credential changes', exact: true }).click();
    await expect(credentials(page).getByRole('status')).toContainText('Credentials applied in memory', { timeout });
}
async function readDownload(download: Download) {
    expect(await download.failure()).toBeNull();
    const stream = await download.createReadStream();
    if (!stream) throw new Error('No downloaded bytes');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    writeFileSync(test.info().outputPath(`download-${test.info().attachments.length}-${download.suggestedFilename()}`), bytes);
    await test.info().attach(download.suggestedFilename(), { body: bytes, contentType: 'application/octet-stream' });
    return bytes;
}
async function exported(page: Page) {
    const pending = page.waitForEvent('download');
    await settings(page).getByRole('button', { name: 'Download KDBX', exact: true }).click();
    return readDownload(await pending);
}
async function save(page: Page) {
    await settings(page).getByRole('button', { name: 'Save database settings', exact: true }).click();
    await expect(settings(page).getByRole('status').filter({ hasText: /Saved in browser storage|Database settings saved\./ })).toBeVisible({ timeout });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}
async function reload(page: Page, factors: Factors) {
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    await expect(settings(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('#password')).toBeVisible({ timeout });
    await page.reload();
    await unlock(page, factors);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
}
async function selectKey(page: Page, bytes: Uint8Array, name = 'replacement.keyx') {
    await credentials(page).getByRole('combobox', { name: 'Key file action', exact: true }).selectOption('set');
    await credentials(page).getByLabel('Select key file', { exact: true }).setInputFiles(payload(bytes, name));
}

test.describe('Database credential changes preserve encrypted access', () => {
    test.setTimeout(120_000);

    test('confirmation rejects before mutation; reset restores saved password; changed password survives save and reload', async ({ page }) => {
        await disableAutomaticSave(page);
        const source = await fixture();
        await open(page, source);
        await passwordDraft(page, changedPassword, 'Mismatched confirmation');
        await credentials(page).getByRole('button', { name: 'Apply credential changes', exact: true }).click();
        await expect(credentials(page).getByRole('status')).toContainText('matching confirmation');
        const downloads: Download[] = [];
        page.on('download', download => downloads.push(download));
        await settings(page).getByRole('button', { name: 'Download KDBX', exact: true }).click();
        await expect(settings(page).getByRole('status').filter({ hasText: 'Apply or discard credential edits before downloading.' })).toBeVisible();
        expect(downloads).toHaveLength(0);
        await credentials(page).getByRole('button', { name: 'Discard credential edits', exact: true }).click();
        await proves(await exported(page), source, initial, [{ password: changedPassword }]);
        await passwordDraft(page, changedPassword);
        await apply(page);
        await proves(await exported(page), source, { password: changedPassword }, [initial]);
        await credentials(page).getByRole('button', { name: 'Reset password change', exact: true }).click();
        await apply(page);
        await proves(await exported(page), source, initial, [{ password: changedPassword }]);
        await passwordDraft(page, changedPassword);
        await apply(page);
        await save(page);
        const unsavedPassword = `${changedPassword} second edit`;
        await passwordDraft(page, unsavedPassword);
        await apply(page);
        await credentials(page).getByRole('button', { name: 'Reset password change', exact: true }).click();
        await apply(page);
        // Reset must now restore the newly saved password, not the original import password.
        await proves(await exported(page), source, { password: changedPassword }, [initial, { password: unsavedPassword }]);
        await reload(page, { password: changedPassword });
        await proves(await exported(page), source, { password: changedPassword }, [initial]);
    });

    test('key add, replacement, reset and removal each preserve the expected decrypting factors', async ({ page }) => {
        await disableAutomaticSave(page);
        const source = await fixture();
        const keyA = await kdbx.Credentials.createRandomKeyFile(2);
        const keyB = await kdbx.Credentials.createRandomKeyFile(2);
        await open(page, source);
        await selectKey(page, keyA, 'saved-key.keyx');
        await apply(page);
        await proves(await exported(page), source, { ...initial, key: keyA }, [initial, { ...initial, key: keyB }]);
        await save(page);
        await reload(page, { ...initial, key: keyA });
        await selectKey(page, keyB);
        await apply(page);
        await proves(await exported(page), source, { ...initial, key: keyB }, [initial, { ...initial, key: keyA }]);
        await credentials(page).getByRole('combobox', { name: 'Key file action', exact: true }).selectOption('reset');
        await apply(page);
        await proves(await exported(page), source, { ...initial, key: keyA }, [{ ...initial, key: keyB }]);
        await credentials(page).getByRole('combobox', { name: 'Key file action', exact: true }).selectOption('remove');
        await apply(page);
        await proves(await exported(page), source, initial, [{ ...initial, key: keyA }]);
        await save(page);
        await reload(page, initial);
        await proves(await exported(page), source, initial, [{ ...initial, key: keyA }, { ...initial, key: keyB }]);
    });

    test('a malformed XML key cannot partially publish an otherwise valid password change', async ({ page }) => {
        const source = await fixture();
        await open(page, source);
        await passwordDraft(page, changedPassword);
        // Well-formed XML with an invalid v2 key checksum: arbitrary non-XML files are valid hashed keys.
        const malformed = Buffer.from('<KeyFile><Meta><Version>2.0</Version></Meta><Key><Data Hash="00000000">' + 'AB'.repeat(32) + '</Data></Key></KeyFile>');
        await selectKey(page, malformed, 'bad-checksum.keyx');
        await credentials(page).getByRole('button', { name: 'Apply credential changes', exact: true }).click();
        await expect(credentials(page).getByRole('status')).toContainText('No credential changes were applied', { timeout });
        await expect(credentials(page).getByLabel('New master password', { exact: true })).toHaveValue(changedPassword);
        await credentials(page).getByRole('button', { name: 'Discard credential edits', exact: true }).click();
        await proves(await exported(page), source, initial, [{ password: changedPassword }]);
        await save(page);
        await reload(page, initial);
        await proves(await exported(page), source, initial, [{ password: changedPassword }]);
    });

    test.describe('320px touch credential controls', () => {
        test.use({ hasTouch: true, viewport: { width: 320, height: 740 } });
        test('generated key requires acknowledgement and its actual downloaded bytes reopen the saved vault', async ({ page }, testInfo) => {
            const source = await fixture();
            await open(page, source, `${'long-vault-name-'.repeat(8)}.kdbx`);
            const section = credentials(page);
            await section.getByRole('button', { name: 'Generate key file', exact: true }).tap();
            const downloadKey = section.getByRole('button', { name: 'Download generated key file', exact: true });
            await expect(downloadKey).toBeVisible();
            await section.getByRole('button', { name: 'Apply credential changes', exact: true }).tap();
            await expect(section.getByRole('status')).toContainText('Save the generated key file before applying it.');
            const pending = page.waitForEvent('download');
            await downloadKey.tap();
            const key = await readDownload(await pending);
            await expect(section.getByRole('checkbox')).not.toBeChecked();
            await section.getByRole('checkbox', { name: 'I saved the generated key file in a safe place.', exact: true }).check();
            await expect(section.getByRole('status')).toHaveCount(0);
            for (const region of [section, settings(page)]) {
                expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            }
            for (const button of await section.getByRole('button').all()) {
                const box = (await button.boundingBox())!;
                expect(box.x).toBeGreaterThanOrEqual(0);
                expect(box.x + box.width).toBeLessThanOrEqual(321);
            }
            await page.screenshot({ path: testInfo.outputPath('generated-key-320.png'), fullPage: true });
            await apply(page);
            await proves(await exported(page), source, { ...initial, key }, [initial]);
            await save(page);
            await reload(page, { ...initial, key });
            await proves(await exported(page), source, { ...initial, key }, [initial]);
        });
    });

    test('failed WebDAV credential save leaves old remote readable; retry persists new password and key', async ({ page }) => {
        const source = await fixture();
        const key = await kdbx.Credentials.createRandomKeyFile(2);
        const next = { password: changedPassword, key };
        const files = new Map([['/credentials.kdbx', source.bytes]]);
        const requests: { method: string; path: string; failing: boolean }[] = [];
        const consoleErrors: string[] = [];
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
        let failWrites = true;
        let failedWrites = 0;
        let revision = Date.UTC(2026, 10, 13);
        const revisions = new Map([['/credentials.kdbx', revision]]);
        const server = createServer(async (request, response) => {
            response.setHeader('Access-Control-Allow-Origin', request.headers.origin || '*');
            response.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT, MOVE, DELETE');
            response.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, Destination, Overwrite, If-Match, If-None-Match');
            response.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
            response.setHeader('Cache-Control', 'no-store');
            if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
            const path = new URL(request.url!, 'http://localhost').pathname;
            requests.push({ method: request.method!, path, failing: failWrites });
            const bytes = files.get(path);
            if (request.method === 'GET' || request.method === 'HEAD') {
                const fileRevision = revisions.get(path) ?? revision;
                response.setHeader('Last-Modified', new Date(fileRevision).toUTCString());
                response.setHeader('ETag', `"${fileRevision}"`);
                response.writeHead(bytes ? 200 : 404).end(request.method === 'GET' ? bytes : undefined);
            } else if (failWrites) {
                failedWrites++; request.resume(); response.writeHead(503).end();
            } else if (request.method === 'PUT') {
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                files.set(path, Buffer.concat(chunks)); revisions.set(path, revision += 1000); response.writeHead(201).end();
            } else if (request.method === 'MOVE' && bytes) {
                const destination = new URL(String(request.headers.destination), 'http://localhost').pathname;
                files.set(destination, bytes); revisions.set(destination, revision += 1000);
                files.delete(path); revisions.delete(path); response.writeHead(204).end();
            } else if (request.method === 'DELETE') {
                files.delete(path); revisions.delete(path); response.writeHead(204).end();
            } else response.writeHead(405).end();
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        try {
            await page.goto('/next.html');
            await page.locator('#open-webdav').click();
            await page.locator('#webdav-url').fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}/credentials.kdbx`);
            await page.locator('#webdav-next').click();
            await unlock(page, initial);
            await page.getByRole('button', { name: 'Settings', exact: true }).click();
            await page.getByRole('tab', { name: 'Database', exact: true }).click();
            await passwordDraft(page, changedPassword);
            await selectKey(page, key);
            await apply(page);
            await settings(page).getByRole('button', { name: 'Save database settings', exact: true }).click();
            await expect.poll(() => failedWrites, { timeout }).toBeGreaterThan(0);
            await expect(settings(page).getByRole('status').filter({ hasText: /Changes are (still )?pending/ })).toBeVisible({ timeout });
            await proves(files.get('/credentials.kdbx')!, source, initial, [next]);
            await proves(await exported(page), source, next, [initial, { password: changedPassword }]);
            await expect(page.locator('#sync-state')).not.toHaveText('Up to date');
            failWrites = false;
            await save(page);
            await proves(files.get('/credentials.kdbx')!, source, next, [initial, { password: changedPassword }]);
            await reload(page, next);
            await proves(await exported(page), source, next, [initial]);
        } finally {
            writeFileSync(test.info().outputPath('webdav-diagnostics.json'), JSON.stringify({ requests, consoleErrors }, null, 2));
            console.log('WebDAV diagnostics', JSON.stringify({requests,consoleErrors}));
            await test.info().attach('webdav-diagnostics.json', {body:Buffer.from(JSON.stringify({requests,consoleErrors},null,2)),contentType:'application/json'});
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});
