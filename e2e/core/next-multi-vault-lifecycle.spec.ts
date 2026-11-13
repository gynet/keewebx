import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const entry = (page: Page) => page.locator('.entry-editor');
const selector = (page: Page) => page.getByRole('combobox', { name: 'Vault filter', exact: true });
const cards = (page: Page) => page.getByRole('region', { name: 'Open vaults', exact: true });
const card = (page: Page, name: string) => cards(page).locator('.open-vaults__item').filter({ hasText: `${name}.kdbx` });
const closeDialog = (page: Page) => page.locator('dialog.close-vault');
const rows = (page: Page) => page.locator('.entry-row');
const payload = (buffer: Buffer, name: string) => ({ name: `${name}.kdbx`, mimeType: 'application/octet-stream', buffer });

async function fixture(name: string) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const password = `${name} independent master password`;
    const key = name === 'B' ? await kdbx.Credentials.createRandomKeyFile(2) : undefined;
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key), name);
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const group = db.createGroup(db.getDefaultGroup(), 'Shared group');
    const item = db.createEntry(group);
    item.fields.set('Title', 'Shared entry');
    item.fields.set('UserName', `${name}-account-marker`);
    item.fields.set('Password', kdbx.ProtectedValue.fromString(`${name} secret`));
    item.fields.set('Notes', `${name} original notes`);
    item.tags = [name, 'shared']; item.pushHistory();
    const trash = db.createEntry(group); trash.fields.set('Title', `${name} trashed`); db.remove(trash);
    return { name, password, key, id: item.uuid.id, group: group.uuid.id, root: db.getDefaultGroup().uuid.id, buffer: Buffer.from(await db.save()) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function unlock(page: Page, source: Fixture) {
    await page.locator('#password').fill(source.password);
    if (source.key) await page.locator('#unlock-key-file').setInputFiles({ name: 'B.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(source.key) });
    await page.locator('#unlock').click();
    await expect(page.locator('#password')).toHaveCount(0);
}
async function add(page: Page, source: Fixture, url?: string) {
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    if (url) {
        await page.locator('#open-webdav').click();
        await page.locator('#webdav-url').fill(url);
        await page.locator('#webdav-next').click();
    } else await page.locator('#open-file-input').setInputFiles(payload(source.buffer, source.name));
    await unlock(page, source);
}
async function reopen(page: Page, source: Fixture) {
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await page.locator(`.vault-row[data-vault="${source.name}"]`).click();
    await unlock(page, source);
}
async function openBoth(page: Page, url?: string) {
    const a = await fixture('A'), b = await fixture('B');
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles(payload(a.buffer, a.name));
    await unlock(page, a);
    await add(page, b, url);
    return { a, b };
}
async function switchTo(page: Page, name: string) {
    const option = selector(page).locator('option').filter({ hasText: `${name}.kdbx` });
    await selector(page).selectOption((await option.getAttribute('value'))!);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText(`${name}-account-marker`);
}
async function edit(page: Page, name: string, notes: string) {
    await switchTo(page, name);
    await rows(page).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await entry(page).getByLabel('Notes', { exact: true }).fill(notes);
}
async function close(page: Page, name: string) {
    await card(page, name).getByRole('button', { name: /^Close / }).click();
    await expect(closeDialog(page)).toBeVisible();
}
async function saveClose(page: Page) {
    await closeDialog(page).getByRole('button', { name: 'Save and close', exact: true }).click();
    await expect(closeDialog(page)).toHaveCount(0);
}
async function settings(page: Page) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
}
async function download(page: Page, name: string) {
    const pending = page.waitForEvent('download');
    await page.getByRole('form', { name: `Database settings: ${name}`, exact: true }).getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const result = await pending;
    expect(await result.failure()).toBeNull();
    const stream = await result.createReadStream();
    if (!stream) throw new Error('Missing encrypted export');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}
async function decrypt(bytes: Buffer, source: Fixture) {
    expect(bytes.includes(Buffer.from(`${source.name} secret`))).toBe(false);
    const db = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer,
        new kdbx.Credentials(kdbx.ProtectedValue.fromString(source.password), source.key));
    expect(db.getDefaultGroup().uuid.id).toBe(source.root);
    const found = [...db.getDefaultGroup().allEntries()].find(item => item.uuid.id === source.id)!;
    expect((found.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe(`${source.name} secret`);
    expect(found.history.length).toBeGreaterThanOrEqual(1);
    return { db, found };
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { if (!localStorage.getItem('appSettings')) localStorage.setItem('appSettings', JSON.stringify({ autoSave: false, autoSaveInterval: 0, idleMinutes: 0 })); });
});

test('scoped switch/search/tag/group/trash and entry creation preserve independent database identities', async ({ page }) => {
    const { a, b } = await openBoth(page);
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).first()).toContainText(/\.kdbx \(vault [12]\)/);
    await expect(page.getByRole('button', { name: 'New entry', exact: true })).toBeDisabled();
    await edit(page, 'A', 'A draft saved by switching');
    await switchTo(page, 'B');
    await expect(entry(page)).toHaveCount(0);
    await page.locator('#search').fill('A-account-marker'); await expect(rows(page)).toHaveCount(0);
    await page.locator('#search').fill('B-account-marker'); await expect(rows(page)).toHaveCount(1);
    await page.locator('#search').fill('');
    const nav = page.getByRole('navigation', { name: 'Vault', exact: true });
    await expect(nav.getByRole('button', { name: 'A', exact: true })).toHaveCount(0);
    await nav.getByRole('button', { name: 'B', exact: true }).click(); await expect(rows(page)).toHaveCount(1);
    await nav.getByRole('button', { name: 'Trash', exact: true }).click();
    await expect(rows(page)).toHaveText(/B trashed/); await expect(rows(page)).not.toContainText('A trashed');
    await nav.getByRole('button', { name: 'Shared group', exact: true }).click();
    await page.getByRole('button', { name: 'New entry', exact: true }).click();
    await entry(page).getByLabel('Title', { exact: true }).fill('Created only in B group');
    await entry(page).getByRole('button', { name: 'Save', exact: true }).click();
    await nav.getByRole('button', { name: 'All items', exact: true }).click();
    await nav.getByRole('button', { name: 'Manage groups', exact: true }).click();
    const rootChoice = page.getByRole('combobox', { name: 'Choose a vault root', exact: true });
    await rootChoice.selectOption((await rootChoice.locator('option').filter({ hasText: 'B.kdbx' }).getAttribute('value'))!);
    await page.getByRole('button', { name: 'New group', exact: true }).click();
    const groupDialog = page.getByRole('dialog', { name: 'New group', exact: true });
    await groupDialog.getByLabel('Group name', { exact: true }).fill('B created group');
    await groupDialog.getByRole('button', { name: 'Create group', exact: true }).click();
    await expect(groupDialog).toHaveCount(0);
    await selector(page).selectOption('');
    const target = page.getByRole('combobox', { name: 'New entry vault', exact: true });
    await target.selectOption((await target.locator('option').filter({ hasText: 'B.kdbx' }).getAttribute('value'))!);
    await page.getByRole('button', { name: 'New entry', exact: true }).click();
    await entry(page).getByLabel('Title', { exact: true }).fill('Created only in B root');
    await entry(page).getByRole('button', { name: 'Save', exact: true }).click();
    await card(page, 'B').getByRole('button', { name: /^Save / }).click();
    await expect(card(page, 'B').getByRole('status')).toHaveText('Up to date');
    await settings(page);
    const exportA = await decrypt(await download(page, 'A'), a);
    const exportB = await decrypt(await download(page, 'B'), b);
    expect(exportA.found.fields.get('Notes')).toBe('A draft saved by switching');
    expect([...exportA.db.getDefaultGroup().allEntries()].some(item => item.fields.get('Title') === 'Created only in B group')).toBe(false);
    const created = [...exportB.db.getDefaultGroup().allEntries()].find(item => item.fields.get('Title') === 'Created only in B group')!;
    expect(created.parentGroup?.uuid.id).toBe(b.group);
    expect(exportB.db.getDefaultGroup().groups.some(group => group.name === 'B created group')).toBe(true);
    expect(exportA.db.getDefaultGroup().groups.some(group => group.name === 'B created group')).toBe(false);
    expect([...exportB.db.getDefaultGroup().allEntries()].find(item => item.fields.get('Title') === 'Created only in B root')?.parentGroup?.uuid.id).toBe(b.root);
    expect([...exportA.db.getDefaultGroup().allEntries()].some(item => item.fields.get('Title') === 'Created only in B root')).toBe(false);
});

test('invalid entry draft blocks switching and closing until corrected', async ({ page }) => {
    await openBoth(page); await edit(page, 'A', 'Keep invalid A draft');
    await entry(page).getByRole('button', { name: 'Add field', exact: true }).click();
    const before = await selector(page).inputValue();
    const option = selector(page).locator('option').filter({ hasText: 'B.kdbx' });
    await selector(page).selectOption((await option.getAttribute('value'))!);
    await expect(selector(page)).toHaveValue(before);
    await expect(entry(page).getByLabel('Notes', { exact: true })).toHaveValue('Keep invalid A draft');
    await close(page, 'A');
    await closeDialog(page).getByRole('button', { name: 'Save and close', exact: true }).click();
    await expect(closeDialog(page).getByRole('alert')).toContainText('invalid fields');
    await closeDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card(page, 'A')).toBeVisible();
    await expect(entry(page).getByLabel('Notes', { exact: true })).toHaveValue('Keep invalid A draft');
    await entry(page).getByRole('button', { name: 'Remove field', exact: true }).click();
    await switchTo(page, 'B');
    await expect(entry(page)).toHaveCount(0);
});

test('close nonselected B leaves A draft untouched; save last A closes to unlock and recent reopening retains both factors', async ({ page }) => {
    const { a, b } = await openBoth(page);
    await edit(page, 'A', 'A close-last draft');
    await close(page, 'B'); await closeDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card(page, 'B')).toBeVisible();
    await expect(entry(page).getByLabel('Notes', { exact: true })).toHaveValue('A close-last draft');
    await close(page, 'B'); await saveClose(page);
    await expect(card(page, 'B')).toHaveCount(0);
    await expect(entry(page).getByLabel('Notes', { exact: true })).toHaveValue('A close-last draft');
    await close(page, 'A'); await saveClose(page);
    await expect(page.locator('.vault-row[data-vault="A"]')).toBeVisible();
    await expect(page.locator('.vault-row[data-vault="B"]')).toBeVisible();
    await page.locator('.vault-row[data-vault="A"]').click(); await unlock(page, a);
    await settings(page);
    expect((await decrypt(await download(page, 'A'), a)).found.fields.get('Notes')).toBe('A close-last draft');
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await page.locator('.vault-row[data-vault="B"]').click();
    await page.locator('#password').fill(b.password); await page.locator('#unlock').click();
    await expect(page.locator('#unlock-error')).toHaveText('Wrong password');
    await unlock(page, b); await expect(card(page, 'B')).toBeVisible();
});

for (const fresh of [false, true]) test(`failed save retains ${fresh ? 'new' : 'existing'} editor; corrected retry closes exactly one vault`, async ({ page }) => {
    const { a, b } = await openBoth(page);
    if (fresh) {
        await switchTo(page, 'A'); await page.getByRole('button', { name: 'New entry', exact: true }).click();
        await entry(page).getByLabel('Title', { exact: true }).fill('New retained draft');
    } else await edit(page, 'A', 'A failed-save draft');
    await entry(page).getByLabel('Notes', { exact: true }).fill('A failed-save draft');
    await page.evaluate(() => {
        const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
        crypto.subtle.encrypt = (...args) => {
            const algorithm = typeof args[0] === 'string' ? args[0] : args[0].name;
            return algorithm === 'AES-CBC' ? Promise.reject(new Error('Synthetic close encryption failure')) : encrypt(...args);
        };
        (window as any).__restoreEncrypt = () => { crypto.subtle.encrypt = encrypt; };
    });
    await close(page, 'A');
    await closeDialog(page).getByRole('button', { name: 'Save and close', exact: true }).click();
    await expect(closeDialog(page).getByRole('alert')).toContainText('Synthetic close encryption failure');
    await closeDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(entry(page).getByLabel('Notes', { exact: true })).toHaveValue('A failed-save draft');
    await entry(page).getByLabel('Notes', { exact: true }).fill('A corrected draft');
    await page.evaluate(() => (window as any).__restoreEncrypt());
    await close(page, 'A'); await saveClose(page);
    await expect(card(page, 'A')).toHaveCount(0); await expect(card(page, 'B')).toBeVisible();
    await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('B-account-marker');
    await expect(entry(page)).toHaveCount(0);
    await reopen(page, a); await settings(page);
    const opened = await decrypt(await download(page, 'A'), a);
    const target = fresh ? [...opened.db.getDefaultGroup().allEntries()].filter(item => item.fields.get('Title') === 'New retained draft') : [opened.found];
    expect(target).toHaveLength(1); expect(target[0].fields.get('Notes')).toBe('A corrected draft');
    expect((await decrypt(await download(page, 'B'), b)).found.fields.get('Notes')).toBe('B original notes');
});

test('database close saves only B settings and preserves A settings draft and stable fallback', async ({ page }) => {
    const { a, b } = await openBoth(page); await switchTo(page, 'B'); await settings(page);
    const aForm = page.getByRole('form', { name: 'Database settings: A', exact: true });
    const bForm = page.getByRole('form', { name: 'Database settings: B', exact: true });
    await aForm.getByLabel('Vault name', { exact: true }).fill('A unsaved settings');
    await bForm.getByLabel('Vault name', { exact: true }).fill('B renamed');
    await bForm.getByRole('button', { name: 'Close vault', exact: true }).click(); await saveClose(page);
    await expect(aForm.getByLabel('Vault name', { exact: true })).toHaveValue('A unsaved settings');
    await expect(aForm.getByRole('heading', { level: 3, name: 'A', exact: true })).toHaveText('A');
    await aForm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('A-account-marker');
    await expect(selector(page)).not.toHaveValue('');
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await page.locator('.vault-row[data-vault="B renamed"]').click(); await unlock(page, b);
    await settings(page);
    expect((await decrypt(await download(page, 'B renamed'), b)).db.meta.name).toBe('B renamed');
    expect((await decrypt(await download(page, 'A'), a)).db.meta.name).toBe('A');
});

test('explicit discard cancel preserves draft; confirmed discard keeps saved copies and other vault intact', async ({ page }) => {
    const { a, b } = await openBoth(page); await edit(page, 'B', 'B discard-only draft');
    await close(page, 'B'); await closeDialog(page).getByRole('button', { name: 'Close without saving…', exact: true }).click();
    await expect(closeDialog(page).getByRole('alert')).toContainText('already saved');
    await closeDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(entry(page).getByLabel('Notes', { exact: true })).toHaveValue('B discard-only draft');
    await close(page, 'B'); await closeDialog(page).getByRole('button', { name: 'Close without saving…', exact: true }).click();
    await closeDialog(page).getByRole('button', { name: 'Discard remaining changes and close', exact: true }).click();
    await expect(closeDialog(page)).toHaveCount(0); await expect(card(page, 'B')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('A-account-marker');
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await page.locator('.vault-row[data-vault="B"]').click(); await unlock(page, b);
    await settings(page);
    expect((await decrypt(await download(page, 'B'), b)).found.fields.get('Notes')).toBe('B original notes');
    expect((await decrypt(await download(page, 'A'), a)).found.fields.get('Notes')).toBe('A original notes');
});

async function dav(source: Fixture) {
    const files = new Map<string, { data: Buffer; revision: string }>();
    let revision = Date.UTC(2026, 10, 13), fail = false;
    const write = (path: string, data: Buffer) => files.set(path, { data, revision: new Date(revision += 1000).toUTCString() });
    write('/B.kdbx', source.buffer);
    let gate: { entered: boolean; promise: Promise<void>; release(): void } | undefined;
    const gates: (() => void)[] = [], methods: string[] = [];
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT, MOVE');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, Destination, Overwrite, If-Match, If-None-Match');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        methods.push(req.method!);
        const path = new URL(req.url!, 'http://localhost').pathname;
        if (req.method === 'PUT') {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const held = gate; gate = undefined;
            if (held) { held.entered = true; await held.promise; }
            if (fail) { res.writeHead(503).end(); return; }
            write(path, Buffer.concat(chunks)); res.writeHead(201).end(); return;
        }
        const file = files.get(path);
        if (!file) { res.writeHead(404).end(); return; }
        if (req.method === 'MOVE') {
            write(new URL(String(req.headers.destination), 'http://localhost').pathname, file.data);
            files.delete(path); res.writeHead(204).end(); return;
        }
        res.setHeader('Last-Modified', file.revision); res.setHeader('ETag', `"${file.revision}"`);
        res.writeHead(200).end(req.method === 'GET' ? file.data : undefined);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/B.kdbx`, methods,
        bytes: () => files.get('/B.kdbx')!.data, fail: (value: boolean) => { fail = value; },
        hold() {
            let release!: () => void;
            const promise = new Promise<void>(resolve => { release = resolve; });
            gates.push(release); gate = { entered: false, promise, release }; return gate;
        },
        async close() { gates.forEach(release => release()); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    };
}
async function remotePair(page: Page) {
    const a = await fixture('A'), b = await fixture('B'), remote = await dav(b);
    await page.goto('/next.html'); await page.locator('#open-file-input').setInputFiles(payload(a.buffer, 'A')); await unlock(page, a);
    await add(page, b, remote.url);
    await edit(page, 'B', 'B remote changes');
    await switchTo(page, 'A'); await rows(page).click(); await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await entry(page).getByLabel('Notes', { exact: true }).fill('A stays an exact draft');
    return { a, b, remote };
}

test('WebDAV 503 retains target and unrelated draft; retry closes only after encrypted remote save', async ({ page }) => {
    const { b, remote } = await remotePair(page);
    try {
        remote.fail(true); await close(page, 'B');
        await closeDialog(page).getByRole('button', { name: 'Save and close', exact: true }).click();
        await expect(closeDialog(page).getByRole('alert')).toContainText('503');
        await closeDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(card(page, 'B').getByRole('status')).not.toHaveText('Up to date');
        await expect(entry(page).getByLabel('Notes', { exact: true })).toHaveValue('A stays an exact draft');
        expect((await decrypt(remote.bytes(), b)).found.fields.get('Notes')).toBe('B original notes');
        remote.fail(false); await close(page, 'B'); await saveClose(page);
        await expect(card(page, 'B')).toHaveCount(0);
        await expect(entry(page).getByLabel('Notes', { exact: true })).toHaveValue('A stays an exact draft');
        expect((await decrypt(remote.bytes(), b)).found.fields.get('Notes')).toBe('B remote changes');
        expect(remote.methods).not.toContain('DELETE');
    } finally { await remote.close(); }
});

for (const timeout of [false, true]) test(`held close ${timeout ? 'times out' : 'is canceled'}; late upload cannot close or change selection`, async ({ page }) => {
    if (timeout) await page.clock.install();
    const { b, remote } = await remotePair(page);
    try {
        const held = remote.hold(); await close(page, 'B');
        await closeDialog(page).getByRole('button', { name: 'Save and close', exact: true }).click();
        await expect.poll(() => held.entered).toBe(true);
        if (timeout) {
            await page.clock.fastForward(16_000);
            await expect(closeDialog(page).getByRole('alert')).toContainText('timed out');
        }
        await closeDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(entry(page).getByLabel('Notes', { exact: true })).toHaveValue('A stays an exact draft');
        held.release();
        await expect(card(page, 'B').getByRole('status')).not.toHaveText('Saving…');
        await expect(card(page, 'B')).toBeVisible();
        await expect(entry(page).getByLabel('Notes', { exact: true })).toHaveValue('A stays an exact draft');
        await close(page, 'B'); await saveClose(page);
        expect((await decrypt(remote.bytes(), b)).found.fields.get('Notes')).toBe('B remote changes');
    } finally { await remote.close(); }
});

test('320px: drawer switches scoped vault and close falls back to the remaining vault', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openBoth(page);
    await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
    await card(page, 'B').getByRole('button', { name: /^B\.kdbx/ }).click();
    await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('B-account-marker');
    await rows(page).click(); await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await entry(page).getByLabel('Notes', { exact: true }).fill('Mobile B draft');
    await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
    await close(page, 'B');
    expect(await closeDialog(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await saveClose(page);
    await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('A-account-marker');
    await expect(entry(page)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('mobile-vault-close-fallback.png'), fullPage: true });
});

for (const target of ['A', 'B']) test(`closing ${target} scopes attachment waits to its owner`, async ({ page }) => {
    const { a } = await openBoth(page); await switchTo(page, 'A'); await rows(page).click();
    await page.evaluate(() => {
        const read = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = async function () {
            const data = await read.call(this);
            if (this.name !== 'pending-attachment.bin') return data;
            (window as any).__attachmentHeld = true;
            return new Promise<ArrayBuffer>(resolve => { (window as any).__releaseAttachment = () => resolve(data); });
        };
    });
    await page.getByLabel('Attachment file', { exact: true }).setInputFiles({
        name: 'pending-attachment.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('Attachment retained in A')
    });
    await expect.poll(() => page.evaluate(() => !!(window as any).__attachmentHeld)).toBe(true);
    await close(page, target);
    await closeDialog(page).getByRole('button', { name: 'Save and close', exact: true }).click();
    if (target === 'B') {
        await expect(closeDialog(page)).toHaveCount(0);
        await expect(card(page, 'B')).toHaveCount(0);
    } else {
        await expect(closeDialog(page).getByRole('status')).toContainText('pending work');
        await expect(page.locator('.open-vaults__item').filter({ hasText: 'A.kdbx' })).toHaveCount(1);
    }
    await page.evaluate(() => (window as any).__releaseAttachment());
    await expect(closeDialog(page)).toHaveCount(0);
    if (target === 'A') await reopen(page, a);
    else await expect(page.getByText('pending-attachment.bin', { exact: true })).toBeVisible();
    await settings(page);
    const opened = await decrypt(await download(page, 'A'), a);
    const binary = opened.found.binaries.get('pending-attachment.bin') as { value: ArrayBuffer };
    expect(Buffer.from(binary.value).toString()).toBe('Attachment retained in A');
});

test('inline notes remain editable after failed close and retry saves the latest source', async ({ page }) => {
    const { a } = await openBoth(page); await switchTo(page, 'A'); await rows(page).click();
    const notes = page.getByRole('region', { name: 'Notes', exact: true });
    await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
    await notes.getByRole('textbox').fill('**Original Markdown draft**');
    await page.evaluate(() => {
        const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
        crypto.subtle.encrypt = (...args) => {
            const algorithm = typeof args[0] === 'string' ? args[0] : args[0].name;
            return algorithm === 'AES-CBC' ? Promise.reject(new Error('Synthetic notes failure')) : encrypt(...args);
        };
        (window as any).__restoreEncrypt = () => { crypto.subtle.encrypt = encrypt; };
    });
    await close(page, 'A');
    await closeDialog(page).getByRole('button', { name: 'Save and close', exact: true }).click();
    await expect(closeDialog(page).getByRole('alert')).toContainText('Synthetic notes failure');
    await closeDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(notes.getByRole('textbox')).toHaveValue('**Original Markdown draft**');
    await notes.getByRole('textbox').fill('**Updated Markdown source**');
    await page.evaluate(() => (window as any).__restoreEncrypt());
    await close(page, 'A'); await saveClose(page); await reopen(page, a); await settings(page);
    expect((await decrypt(await download(page, 'A'), a)).found.fields.get('Notes')).toBe('**Updated Markdown source**');
});

test('disabled browser storage cannot implicitly close a local vault with an unsaved draft', async ({ page }) => {
    await page.goto('/next.html');
    await page.evaluate(() => localStorage.setItem('appSettings', JSON.stringify({ autoSave: false, autoSaveInterval: 0, idleMinutes: 0, disableOfflineStorage: true })));
    await openBoth(page); await edit(page, 'A', 'A cache-disabled draft');
    await close(page, 'A');
    await closeDialog(page).getByRole('button', { name: 'Save and close', exact: true }).click();
    await expect(closeDialog(page).getByRole('alert')).toContainText('Browser storage is disabled');
    await closeDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(entry(page).getByLabel('Notes', { exact: true })).toHaveValue('A cache-disabled draft');
    await expect(card(page, 'A')).toBeVisible(); await expect(card(page, 'B')).toBeVisible();
});

test('idle lock cancels pending per-vault close; late upload cannot close a reopened session', async ({ page }) => {
    await page.clock.install();
    await page.goto('/next.html');
    await page.evaluate(() => localStorage.setItem('appSettings', JSON.stringify({ autoSave: false, autoSaveInterval: 0, idleMinutes: 1 })));
    const { a, b, remote } = await remotePair(page);
    try {
        const held = remote.hold(); await close(page, 'B');
        await closeDialog(page).getByRole('button', { name: 'Save and close', exact: true }).click();
        await expect.poll(() => held.entered).toBe(true);
        await page.clock.fastForward(125_000);
        await expect(closeDialog(page)).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'Securing your vaults', exact: true })).toBeVisible();
        held.release();
        await expect(page.locator('.vault-row[data-vault="A"]')).toBeVisible({ timeout: 30_000 });
        await page.locator('.vault-row[data-vault="A"]').click(); await unlock(page, a);
        await reopen(page, b); await settings(page);
        expect((await decrypt(await download(page, 'A'), a)).found.fields.get('Notes')).toBe('A stays an exact draft');
        expect((await decrypt(await download(page, 'B'), b)).found.fields.get('Notes')).toBe('B remote changes');
    } finally { await remote.close(); }
});

test('same-named vaults remain attributable in filtering, settings, export and close', async ({ page }) => {
    const a = await fixture('A'), b = await fixture('B'), remote = await dav(b);
    try {
        await page.goto('/next.html');
        await page.locator('#open-file-input').setInputFiles(payload(a.buffer, 'B')); await unlock(page, a);
        await add(page, b, remote.url);
        const choices = await selector(page).locator('option').allTextContents();
        expect(choices).toEqual(['All open vaults', 'B.kdbx (vault 1)', 'B.kdbx (vault 2)']);
        await selector(page).selectOption({ label: 'B.kdbx (vault 2)' });
        await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('B-account-marker');
        await settings(page);
        await expect(page.getByRole('form', { name: 'Database settings: B (vault 1)', exact: true })).toBeVisible();
        await expect(page.getByRole('form', { name: 'Database settings: B (vault 2)', exact: true })).toBeVisible();
        expect((await decrypt(await download(page, 'B (vault 1)'), a)).found.fields.get('Notes')).toBe('A original notes');
        expect((await decrypt(await download(page, 'B (vault 2)'), b)).found.fields.get('Notes')).toBe('B original notes');
        await page.getByRole('form', { name: 'Database settings: B (vault 2)', exact: true }).getByRole('button', { name: 'Close vault', exact: true }).click();
        await expect(closeDialog(page).getByRole('heading')).toContainText('vault 2');
        await saveClose(page);
        await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
        await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('A-account-marker');
        expect(remote.methods).not.toContain('DELETE');
    } finally { await remote.close(); }
});

test('per-vault close retains B passkey registration and required key file while A draft stays mounted', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium CDP virtual authenticator required');
    await page.addInitScript(() => {
        (window as any).__keewebx_passkey_capability_override = { prf: 'supported', reason: 'Virtual authenticator test',
            platform: { os: 'macos', browser: 'chrome', osVersion: '15.0.0' } };
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
        protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
        hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true
    } });
    const { b } = await openBoth(page); await settings(page);
    const region = page.getByRole('form', { name: 'Database settings: B', exact: true }).getByRole('region', { name: 'Local passkey unlock', exact: true });
    await region.getByLabel('Current master password', { exact: true }).fill(b.password);
    await region.getByLabel('Current key file (if required)', { exact: true }).setInputFiles({ name: 'B.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(b.key!) });
    await region.getByRole('button', { name: 'Enable local passkey', exact: true }).click();
    await expect(region.getByRole('status')).toContainText('Passkey unlock saved in this browser');
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    await edit(page, 'A', 'A draft across B passkey close');
    await close(page, 'B'); await saveClose(page);
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await page.locator('.vault-row[data-vault="B"]').click();
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await expect(page.locator('#unlock-error')).toContainText('Select the key file first');
    await page.locator('#unlock-key-file').setInputFiles({ name: 'B.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(b.key!) });
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await expect(page.locator('#password')).toHaveCount(0);
    await expect(entry(page).getByLabel('Notes', { exact: true })).toHaveValue('A draft across B passkey close');
    await expect(card(page, 'B')).toBeVisible();
});

test('manual Lock explicitly saves all vault drafts even with automatic saving disabled', async ({ page }) => {
    const { a, b } = await openBoth(page);
    await edit(page, 'B', 'B saved by explicit Lock');
    await edit(page, 'A', 'A saved by explicit Lock');
    const lock = page.getByRole('button', { name: 'Lock', exact: true });
    await expect(lock).toHaveAttribute('title', 'Save all vaults and lock');
    await lock.click();
    await expect(page.locator('.vault-row[data-vault="A"]')).toBeVisible();
    await page.locator('.vault-row[data-vault="A"]').click(); await unlock(page, a);
    await reopen(page, b); await settings(page);
    expect((await decrypt(await download(page, 'A'), a)).found.fields.get('Notes')).toBe('A saved by explicit Lock');
    expect((await decrypt(await download(page, 'B'), b)).found.fields.get('Notes')).toBe('B saved by explicit Lock');
});
