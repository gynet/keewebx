import { activateVaultUtility } from './vault-utilities';
import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';
import { browse } from './presentation-lifecycle-fixture';

const password = 'Disposable template vault master';
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Entry templates', exact: true });
const editor = (page: Page) => dialog(page).locator('.entry-editor');
const closeDialog = (page: Page) => page.locator('dialog.close-vault');
const templates = async (page: Page) => { await page.getByRole('button', { name: 'Entry templates…', exact: true }).click(); return dialog(page); };
const payload = (buffer: Buffer, name: string) => ({ name: `${name}.kdbx`, mimeType: 'application/octet-stream', buffer });
async function fixture(name: string) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), name);
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    db.meta.defaultUser = `${name}-default`;
    const work = db.createGroup(db.groups[0], 'Work');
    const account = db.createEntry(work); account.fields.set('Title', `${name} account`);
    const group = db.createGroup(db.groups[0], 'Templates'); db.meta.entryTemplatesGroup = group.uuid;
    const template = db.createEntry(group); template.fields.set('Title', `${name} template`);
    template.fields.set('UserName', `${name}-source`);
    template.fields.set('Password', kdbx.ProtectedValue.fromString(`${name} secret`));
    template.fields.set('Notes', kdbx.ProtectedValue.fromString('Protected notes\nsecond line'));
    template.fields.set('Multiline', kdbx.ProtectedValue.fromString('Private field\nsecond line'));
    template.fields.set('Empty protected', kdbx.ProtectedValue.fromString(''));
    template.binaries.set('proof.bin', await db.createBinary(new Uint8Array([3, 1, 4]).buffer));
    template.pushHistory();
    return { bytes: Buffer.from(await db.save()), template: template.uuid.id, root: db.groups[0].uuid.id, work: work.uuid.id };
}
async function unlock(page: Page) { await page.locator('#password').fill(password); await page.locator('#unlock').click(); await expect(page.locator('#password')).toHaveCount(0); }
async function openBoth(page: Page, remote?: string) {
    const a = await fixture('A'), b = await fixture('B');
    await page.goto('/next.html'); await page.locator('#open-file-input').setInputFiles(payload(a.bytes, 'A')); await unlock(page);
    await browse(page); await activateVaultUtility(page, 'Open another vault');
    if (remote) {
        await page.locator('#open-webdav').click(); await page.locator('#webdav-url').fill(remote); await page.locator('#webdav-next').click();
    } else await page.locator('#open-file-input').setInputFiles(payload(b.bytes, 'B'));
    await unlock(page); return { a, b };
}
async function scope(page: Page, name: string) {
    const select = page.getByRole('combobox', { name: 'Vault filter', exact: true });
    const label = `${name}.kdbx (vault ${name === 'A' ? 1 : 2})`;
    if (await select.isVisible()) await select.selectOption({ label });
    else { await browse(page); await page.getByRole('navigation', { name: 'Vault', exact: true }).getByRole('button', { name: label, exact: true }).click(); }
}
async function decrypt(bytes: Buffer) {
    return kdbx.Kdbx.load(new Uint8Array(bytes).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
}
async function download(page: Page, name: string) {
    await browse(page); await activateVaultUtility(page, 'Settings'); await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('form', { name: `Database settings: ${name}`, exact: true }).getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const stream = await (await pending).createReadStream(); if (!stream) throw new Error('Missing export');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const db = await decrypt(Buffer.concat(chunks)); await page.getByRole('button', { name: 'Back to vault', exact: true }).click(); return db;
}
const entries = (db: kdbx.Kdbx) => [...db.groups[0].allEntries()];
const text = (entry: kdbx.KdbxEntry, name: string) => { const value = entry.fields.get(name); return value instanceof kdbx.ProtectedValue ? value.getText() : value; };

const pageErrors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });
test.beforeEach(async ({ page }) => {
    const errors: string[] = []; pageErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { if (!localStorage.getItem('appSettings')) localStorage.setItem('appSettings', JSON.stringify({ autoSave: false, autoSaveInterval: 0, idleMinutes: 0 })); });
});

for (const width of [1280, 320]) test(`template vault scope, defaults and destination root/group persist at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); const { a, b } = await openBoth(page);
    let list = await templates(page);
    await expect(list.getByRole('combobox', { name: 'Template vault', exact: true })).toHaveValue('');
    await expect(list.getByRole('button', { name: 'New template', exact: true })).toBeDisabled();
    await expect(list.getByRole('button', { name: 'Use template', exact: true })).toHaveCount(0);
    await list.getByRole('combobox', { name: 'Template vault', exact: true }).selectOption({ label: 'B (vault 2)' });
    await expect(list.locator('li')).toHaveCount(1); await expect(list.locator('li')).toContainText('B template');
    await list.getByRole('button', { name: 'New template', exact: true }).click();
    await expect(editor(page).getByLabel('Username', { exact: true })).toHaveValue('B-default');
    await editor(page).getByLabel('Title', { exact: true }).fill('B new template');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await list.locator('li').filter({ hasText: 'B template' }).getByRole('button', { name: 'Use template', exact: true }).click();
    await expect(list.getByRole('combobox', { name: 'Destination group', exact: true }).locator('option:checked')).toHaveText('B');
    await editor(page).getByLabel('Title', { exact: true }).fill('B root instance');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await scope(page, 'A'); list = await templates(page);
    await expect(list.getByRole('combobox', { name: 'Template vault', exact: true }).locator('option:checked')).toHaveText('A (vault 1)');
    await expect(list.locator('li')).toHaveCount(1); await expect(list.locator('li')).toContainText('A template');
    await list.getByRole('button', { name: 'Close', exact: true }).click();
    await scope(page, 'B'); await browse(page);
    await page.getByRole('navigation', { name: 'Vault', exact: true }).getByRole('button', { name: 'Work', exact: true }).click();
    list = await templates(page);
    await list.locator('li').filter({ hasText: 'B template' }).getByRole('button', { name: 'Use template', exact: true }).click();
    await expect(list.getByRole('combobox', { name: 'Destination group', exact: true }).locator('option:checked')).toHaveText('B / Work');
    await editor(page).getByLabel('Title', { exact: true }).fill('B work instance'); await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    const dbB = await download(page, 'B'), dbA = await download(page, 'A');
    expect(dbB.groups[0].uuid.id).toBe(b.root); expect(dbA.groups[0].uuid.id).toBe(a.root);
    expect(entries(dbA).map(item => text(item, 'Title')).sort()).toEqual(['A account', 'A template']);
    const rootInstance = entries(dbB).find(item => text(item, 'Title') === 'B root instance')!;
    const workInstance = entries(dbB).find(item => text(item, 'Title') === 'B work instance')!;
    expect(rootInstance.parentGroup?.uuid.id).toBe(b.root); expect(workInstance.parentGroup?.uuid.id).toBe(b.work);
    expect(text(rootInstance, 'Notes')).toBe('Protected notes\nsecond line'); expect(text(workInstance, 'Multiline')).toBe('Private field\nsecond line');
    expect(rootInstance.binaries.has('proof.bin')).toBe(true);
    expect(text(entries(dbB).find(item => text(item, 'Title') === 'B new template')!, 'UserName')).toBe('B-default');
    expect(text(entries(dbB).find(item => item.uuid.id === b.template)!, 'Title')).toBe('B template');
});

async function dav(bytes: Buffer) {
    const files = new Map<string, { bytes: Buffer; revision: string }>(); let revision = Date.UTC(2026, 10, 13), fail = false;
    const write = (path: string, bytes: Buffer) => files.set(path, { bytes, revision: new Date(revision += 1000).toUTCString() }); write('/B.kdbx', bytes);
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT, MOVE');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, Destination, Overwrite, If-Match, If-None-Match');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        const path = new URL(req.url!, 'http://localhost').pathname;
        if (req.method === 'PUT') {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            if (fail) { res.writeHead(503).end(); return; }
            write(path, Buffer.concat(chunks)); res.writeHead(201).end(); return;
        }
        const file = files.get(path); if (!file) { res.writeHead(404).end(); return; }
        if (req.method === 'MOVE') { write(new URL(String(req.headers.destination), 'http://localhost').pathname, file.bytes); files.delete(path); res.writeHead(204).end(); return; }
        res.setHeader('Last-Modified', file.revision); res.setHeader('ETag', `"${file.revision}"`);
        res.writeHead(200).end(req.method === 'GET' ? file.bytes : undefined);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/B.kdbx`, bytes: () => files.get('/B.kdbx')!.bytes,
        fail: (value: boolean) => { fail = value; }, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

for (const mode of ['new', 'edit', 'use'] as const) for (const action of ['save', 'close'] as const) {
    test(`${mode} template retains editable baseline after failed ${action}; retry saves one entry in its own vault`, async ({ page }) => {
        await page.setViewportSize({ width: action === 'save' ? 320 : 1280, height: 900 });
        const source = await fixture('B'), remote = await dav(source.bytes);
        try {
            await openBoth(page, remote.url); await scope(page, 'B'); const list = await templates(page);
            await list.getByRole('button', { name: mode === 'new' ? 'New template' : mode === 'edit' ? 'Edit template' : 'Use template', exact: true }).click();
            await editor(page).getByLabel('Title', { exact: true }).fill('Retained result');
            if (mode !== 'new') {
                await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveAttribute('readonly', '');
                await editor(page).getByRole('button', { name: 'Show Notes', exact: true }).click();
                const index = await editor(page).getByLabel('Field name', { exact: true }).evaluateAll(inputs => inputs.findIndex(input => (input as HTMLInputElement).value === 'Multiline'));
                expect(index).toBeGreaterThanOrEqual(0);
                const custom = editor(page).locator('.entry-editor__custom-row').nth(index);
                await custom.getByRole('button', { name: 'Show field', exact: true }).click();
                await expect(custom.getByLabel('Field value', { exact: true })).toHaveValue('Private field\nsecond line');
                await custom.getByLabel('Field name', { exact: true }).fill('Renamed multiline');
            }
            await editor(page).getByLabel('Notes', { exact: true }).fill('First draft\nsecond line');
            await editor(page).evaluate(element => { element.setAttribute('data-test-editor', 'retained'); });
            expect(await list.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            remote.fail(true);
            if (action === 'save') {
                await list.getByRole('button', { name: 'Save vault and keep editing', exact: true }).click();
                await expect(list.getByRole('alert')).toContainText('503');
            } else {
                await list.getByRole('button', { name: 'Close template vault…', exact: true }).click();
                await closeDialog(page).getByRole('button', { name: 'Save and close', exact: true }).click();
                await expect(closeDialog(page).getByRole('alert')).toContainText('503');
                await closeDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
            }
            await expect(editor(page)).toHaveAttribute('data-test-editor', 'retained');
            await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue('First draft\nsecond line');
            expect(entries(await decrypt(remote.bytes())).filter(item => text(item, 'Title') === 'Retained result')).toHaveLength(0);
            await editor(page).getByLabel('Notes', { exact: true }).fill('Corrected draft\nsecond line'); remote.fail(false);
            if (action === 'save') {
                await list.getByRole('button', { name: 'Save vault and keep editing', exact: true }).click();
                await expect(list.getByRole('status')).toContainText('Vault saved.');
                await expect(editor(page)).toHaveAttribute('data-test-editor', 'retained');
                await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
                if (mode !== 'use') await list.getByRole('button', { name: 'Close', exact: true }).click();
            } else {
                await list.getByRole('button', { name: 'Close template vault…', exact: true }).click();
                await closeDialog(page).getByRole('button', { name: 'Save and close', exact: true }).click();
                await expect(closeDialog(page)).toHaveCount(0); await expect(list).toHaveCount(0);
            }
            const db = await decrypt(remote.bytes()), results = entries(db).filter(item => text(item, 'Title') === 'Retained result');
            expect(results).toHaveLength(1); const result = results[0]; expect(text(result, 'Notes')).toBe('Corrected draft\nsecond line');
            expect(result.parentGroup?.uuid.id).toBe(mode === 'use' ? source.root : db.meta.entryTemplatesGroup?.id);
            if (mode !== 'new') {
                expect(text(result, 'Renamed multiline')).toBe('Private field\nsecond line'); expect(result.fields.has('Multiline')).toBe(false);
                expect(result.fields.get('Renamed multiline')).toBeInstanceOf(kdbx.ProtectedValue); expect(result.fields.get('Notes')).toBeInstanceOf(kdbx.ProtectedValue);
                expect(result.fields.get('Empty protected')).toBeInstanceOf(kdbx.ProtectedValue); expect(text(result, 'Empty protected')).toBe('');
                expect(result.binaries.has('proof.bin')).toBe(true);
            }
            if (mode !== 'edit') expect(text(entries(db).find(item => item.uuid.id === source.template)!, 'Title')).toBe('B template');
            const dbA = await download(page, 'A'); expect(entries(dbA).map(item => text(item, 'Title')).sort()).toEqual(['A account', 'A template']);
        } finally { await remote.close(); }
    });
}
