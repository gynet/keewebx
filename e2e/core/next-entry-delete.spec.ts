import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const name = 'Entry deletion';
const password = 'Disposable deletion password';
const title = 'Selected account';
const timeout = 30_000;
const credentials = () => new kdbx.Credentials(kdbx.ProtectedValue.fromString(password));
const entries = (db: kdbx.Kdbx) => db.groups.flatMap(group => [...group.allEntries()]);
const text = (value: unknown) => value instanceof kdbx.ProtectedValue ? value.getText() : value;
async function decrypt(bytes: Buffer) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    return kdbx.Kdbx.load(new Uint8Array(bytes).buffer, credentials());
}
async function fixture(mode: 'trash' | 'disabled' | 'normal' = 'trash') {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(credentials(), name);
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const source = db.createGroup(db.groups[0], 'Accounts');
    const bin = db.getGroup(db.meta.recycleBinUuid!)!;
    const nested = db.createGroup(bin, 'Old accounts');
    const shared = await db.createBinary(new Uint8Array([1, 128, 200, 255]).buffer);
    const selected = db.createEntry(source);
    selected.fields.set('Title', title);
    selected.fields.set('Password', kdbx.ProtectedValue.fromString('Old selected secret'));
    selected.fields.set('Notes', kdbx.ProtectedValue.fromString('Applied protected notes'));
    selected.tags = ['selected-tag']; selected.binaries.set('shared.bin', shared);
    selected.pushHistory(); selected.fields.set('Password', kdbx.ProtectedValue.fromString('Current selected secret'));
    for (const [group, label] of [[source, 'Live sibling'], [nested, 'Trash sibling']] as const) {
        const entry = db.createEntry(group); entry.fields.set('Title', label);
        entry.fields.set('Password', kdbx.ProtectedValue.fromString(`${label} secret`));
        entry.tags = ['keep']; entry.binaries.set('shared.bin', shared); entry.pushHistory();
    }
    if (mode === 'trash') db.move(selected, nested);
    if (mode === 'disabled') db.meta.recycleBinEnabled = false;
    return { data: Buffer.from(await db.save()), id: selected.uuid.id, groupId: source.uuid.id, binId: bin.uuid.id, mode };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const row = (page: Page, label = title) => page.locator('.entry-row').filter({ has: page.getByText(label, { exact: true }) });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Vault', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Permanently delete entry', exact: true });
const trigger = (page: Page) => page.getByRole('button', { name: 'Delete permanently…', exact: true });
const confirm = (page: Page) => dialog(page).getByRole('button', { name: 'Delete permanently', exact: true });
async function open(page: Page, source: Fixture) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: `${name}.kdbx`, mimeType: 'application/octet-stream', buffer: source.data });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(row(page, 'Live sibling')).toBeVisible({ timeout });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    const menu = page.getByRole('button', { name: 'Move menu', exact: true });
    if (await menu.isVisible()) await menu.click();
    if (source.mode === 'trash') await nav(page).getByRole('button', { name: 'Trash', exact: true }).click();
    await row(page).click();
}
async function download(page: Page, saved = true) {
    if (saved) await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await nav(page).getByRole('button', { name: 'Settings', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('form', { name: `Database settings: ${name}`, exact: true })
        .getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const file = await pending; expect(await file.failure()).toBeNull();
    const stream = await file.createReadStream(); if (!stream) throw new Error('Missing encrypted download');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    await test.info().attach('encrypted-download', { body: bytes, contentType: 'application/octet-stream' });
    await page.locator('#settings-back').click();
    return { bytes, db: await decrypt(bytes) };
}
function semantic(entry: kdbx.KdbxEntry): unknown {
    return { id: entry.uuid.id, parent: entry.parentGroup?.uuid.id,
        fields: [...entry.fields].map(([key, value]) => [key, text(value), value instanceof kdbx.ProtectedValue]),
        tags: entry.tags, times: entry.times, history: entry.history.map(semantic),
        binaries: [...entry.binaries].map(([key, value]) => {
            if (!kdbx.KdbxBinaries.isKdbxBinaryWithHash(value)) throw new Error('Missing binary');
            return [key, Buffer.from(value.value instanceof kdbx.ProtectedValue ? value.value.getBinary() : new Uint8Array(value.value)).toString('base64')];
        }) };
}
async function unchanged(db: kdbx.Kdbx, source: Fixture) {
    const original = await decrypt(source.data);
    expect(entries(db).map(semantic)).toEqual(entries(original).map(semantic));
    expect(db.deletedObjects).toHaveLength(0);
}
async function deleted(db: kdbx.Kdbx, source: Fixture) {
    const original = await decrypt(source.data);
    expect(entries(db).map(semantic)).toEqual(entries(original).filter(entry => entry.uuid.id !== source.id).map(semantic));
    expect(db.deletedObjects).toHaveLength(1);
    expect(db.deletedObjects[0].uuid.id).toBe(source.id);
    expect(db.deletedObjects[0].deletionTime).toBeInstanceOf(Date);
    expect(db.meta.recycleBinEnabled).toBe(original.meta.recycleBinEnabled);
    expect(db.meta.recycleBinUuid?.id).toBe(source.binId);
}
async function reload(page: Page) {
    await nav(page).getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('#password')).toBeVisible({ timeout }); await page.reload();
    await page.locator('.vault-row').filter({ has: page.getByText(`${name}.kdbx`, { exact: true }) }).click();
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(row(page, 'Live sibling')).toBeVisible({ timeout });
}
async function syncSetting(page: Page, interval: '0' | '1') {
    await page.clock.install(); await page.goto('/index.html?ui=classic');
    await page.locator('#open__icon-more').click(); await page.locator('#open__icon-settings').click();
    await page.locator('#settings__general-auto-save-interval').selectOption(interval); await page.clock.runFor(100);
}
async function peer(source: Fixture) {
    let data = source.data, revision = Date.UTC(2026, 10, 13), writes = 0;
    const replace = (bytes: Buffer) => { data = Buffer.from(bytes); revision += 1000; };
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, If-Match, If-None-Match');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (req.method === 'PUT') {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            replace(Buffer.concat(chunks)); ++writes; res.writeHead(200).end(); return;
        }
        res.setHeader('Last-Modified', new Date(revision).toUTCString()); res.setHeader('ETag', `"${revision}"`);
        res.writeHead(200).end(req.method === 'GET' ? data : undefined);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/deletion.kdbx`, replace, bytes: () => data, writes: () => writes,
        async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test.setTimeout(90_000);
for (const mode of ['trash', 'disabled'] as const) test(`${mode}: cancel is inert; confirmed deletion persists one UUID tombstone and preserves siblings`, async ({ page }) => {
    const source = await fixture(mode); await open(page, source); await trigger(page).click();
    await expect(dialog(page)).toContainText('This cannot be undone.');
    if (mode === 'disabled') await expect(dialog(page)).toContainText('The recycle bin is disabled.');
    await expect(dialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Enter'); await expect(dialog(page)).toHaveCount(0); await expect(trigger(page)).toBeFocused();
    await trigger(page).click(); await page.keyboard.press('Escape'); await expect(trigger(page)).toBeFocused();
    await unchanged((await download(page)).db, source);
    await trigger(page).click();
    await page.screenshot({ path: test.info().outputPath('permanent-delete-confirmation.png'), fullPage: true });
    // Repeated delivery to the same button must not mutate twice before Preact unmounts it.
    await confirm(page).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect(row(page)).toHaveCount(0); await deleted((await download(page)).db, source);
    await reload(page); await deleted((await download(page)).db, source);
    await nav(page).getByRole('button', { name: 'Trash', exact: true }).click();
    await expect(row(page)).toHaveCount(0); await expect(row(page, 'Trash sibling')).toBeVisible();
});

test('normal Move to Trash remains reversible and creates no tombstone', async ({ page }) => {
    const source = await fixture('normal'); await open(page, source);
    await expect(trigger(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0); await expect(row(page)).toHaveCount(0);
    await nav(page).getByRole('button', { name: 'Trash', exact: true }).click(); await row(page).click();
    await expect(trigger(page)).toBeVisible();
    const db = (await download(page)).db, before = await decrypt(source.data);
    expect(entries(db)).toHaveLength(3); expect(db.deletedObjects).toHaveLength(0);
    const moved = entries(db).find(entry => entry.uuid.id === source.id)!;
    expect(moved.parentGroup?.uuid.id).toBe(source.binId);
    expect([...moved.fields].map(([key, value]) => [key, text(value)])).toEqual([...entries(before).find(entry => entry.uuid.id === source.id)!.fields].map(([key, value]) => [key, text(value)]));
    expect(entries(db).filter(entry => entry.uuid.id !== source.id).map(semantic)).toEqual(entries(before).filter(entry => entry.uuid.id !== source.id).map(semantic));
});

test('cancel and declined draft discard preserve Notes; accepted discard permits only selected deletion', async ({ page }) => {
    const source = await fixture(); await open(page, source);
    const notes = page.getByRole('region', { name: 'Notes', exact: true });
    await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
    await notes.getByRole('textbox').fill('Unsaved deletion draft');
    await trigger(page).click(); await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(notes.getByRole('textbox')).toHaveValue('Unsaved deletion draft');
    await trigger(page).click(); page.once('dialog', prompt => prompt.dismiss()); await confirm(page).click();
    await expect(dialog(page)).toBeVisible(); await expect(notes.getByRole('textbox')).toHaveValue('Unsaved deletion draft');
    page.once('dialog', prompt => prompt.accept()); await confirm(page).click();
    await deleted((await download(page)).db, source);
});

test('closed confirmation rejects stale button delivery without deleting', async ({ page }) => {
    const source = await fixture(); await open(page, source); await trigger(page).click();
    await confirm(page).evaluate(button => { button.closest('dialog')!.close(); (button as HTMLButtonElement).click(); });
    await expect(row(page)).toBeVisible();
    await page.locator('dialog[aria-label="Permanently delete entry"]').evaluate(el => (el as HTMLDialogElement).showModal());
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await unchanged((await download(page)).db, source);
});

test('confirmation closed during draft discard cannot continue into deletion', async ({ page }) => {
    const source = await fixture(); await open(page, source);
    const notes = page.getByRole('region', { name: 'Notes', exact: true });
    await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
    await notes.getByRole('textbox').fill('Discard only this draft'); await trigger(page).click();
    await page.evaluate(() => {
        const original = window.confirm;
        window.confirm = () => {
            window.confirm = original;
            document.querySelector<HTMLDialogElement>('dialog[aria-label="Permanently delete entry"]')!.close();
            return true;
        };
    });
    await confirm(page).click(); await expect(row(page)).toBeVisible();
    await page.locator('dialog[aria-label="Permanently delete entry"]').evaluate(el => (el as HTMLDialogElement).showModal());
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await unchanged((await download(page)).db, source);
});

for (const change of ['restore', 'update'] as const) test(`encrypted remote ${change} invalidates pending permanent deletion without tombstones or writes`, async ({ page }) => {
    const source = await fixture(); const dav = await peer(source);
    try {
        await syncSetting(page, '1'); await page.goto('/next.html'); await page.locator('#open-webdav').click();
        await page.locator('#webdav-url').fill(dav.url); await page.locator('#webdav-user').fill('tester');
        await page.locator('#webdav-pass').fill('disposable'); await page.locator('#webdav-next').click();
        await page.locator('#password').fill(password); await page.locator('#unlock').click();
        await expect(row(page, 'Live sibling')).toBeVisible({ timeout });
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        await nav(page).getByRole('button', { name: 'Trash', exact: true }).click(); await row(page).click(); await trigger(page).click();
        const remote = await decrypt(dav.bytes());
        const target = entries(remote).find(entry => entry.uuid.id === source.id)!;
        if (change === 'restore') remote.move(target, remote.getGroup(source.groupId)!);
        else { target.fields.set('Notes', 'Remote replacement'); target.times.update(); }
        dav.replace(Buffer.from(await remote.save())); const bytes = Buffer.from(dav.bytes()), writes = dav.writes();
        await page.clock.fastForward(61_000);
        if (change === 'restore') {
            await expect(row(page)).toHaveCount(0, { timeout }); await expect(dialog(page)).toHaveCount(0);
        } else {
            await expect(dialog(page).getByRole('alert')).toContainText('changed', { timeout });
            await expect(confirm(page)).toBeDisabled();
            await confirm(page).evaluate(button => (button as HTMLButtonElement).click());
        }
        expect(dav.bytes().equals(bytes)).toBe(true); expect(dav.writes()).toBe(writes);
        const db = await decrypt(dav.bytes()); expect(db.deletedObjects).toHaveLength(0);
        const current = entries(db).find(entry => entry.uuid.id === source.id)!;
        if (change === 'restore') expect(current.parentGroup?.uuid.id).toBe(source.groupId);
        else expect(text(current.fields.get('Notes'))).toBe('Remote replacement');
    } finally { await dav.close(); }
});

test('active save blocks deletion until it finishes without changing the selected UUID', async ({ page }) => {
    const source = await fixture('disabled'); await open(page, source);
    await page.evaluate(() => {
        const encrypt = SubtleCrypto.prototype.encrypt;
        (window as any).deleteSaveEntered = false;
        SubtleCrypto.prototype.encrypt = async function (...args) {
            SubtleCrypto.prototype.encrypt = encrypt;
            (window as any).deleteSaveEntered = true;
            await new Promise<void>(resolve => window.addEventListener('release-delete-save', () => resolve(), { once: true }));
            return encrypt.apply(this, args);
        };
    });
    const notes = page.getByRole('region', { name: 'Notes', exact: true });
    await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
    await notes.getByRole('textbox').fill('New applied note');
    await notes.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).deleteSaveEntered), { timeout }).toBe(true);
    await trigger(page).click(); await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('A save is in progress.');
    await page.evaluate(() => window.dispatchEvent(new Event('release-delete-save')));
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await trigger(page).click(); await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    const db = (await download(page)).db;
    expect(db.deletedObjects).toHaveLength(0); expect(entries(db)).toHaveLength(3);
    expect(text(entries(db).find(entry => entry.uuid.id === source.id)!.fields.get('Notes'))).toBe('New applied note');
});

test('lock recovery invalidates retained delete confirmation after authentication', async ({ page }) => {
    const source = await fixture(); await syncSetting(page, '0'); await open(page, source);
    await page.locator('#open-settings').click(); await page.locator('#setting-auto-lock').selectOption('5'); await page.locator('#settings-back').click();
    const notes = page.getByRole('region', { name: 'Notes', exact: true });
    await notes.getByRole('button', { name: 'Edit notes', exact: true }).click(); await notes.getByRole('textbox').fill('Saved during lock');
    await trigger(page).click();
    await page.evaluate(() => {
        const encrypt = SubtleCrypto.prototype.encrypt;
        (window as any).deleteGate = { entered: false, completed: false };
        SubtleCrypto.prototype.encrypt = async function (...args) {
            SubtleCrypto.prototype.encrypt = encrypt;
            const released = new Promise<void>(resolve => window.addEventListener('release-delete-save', () => resolve(), { once: true }));
            (window as any).deleteGate.entered = true; await released;
            const bytes = await encrypt.apply(this, args); (window as any).deleteGate.completed = true; return bytes;
        };
    });
    await page.clock.fastForward(6 * 60_000);
    await expect.poll(() => page.evaluate(() => (window as any).deleteGate.entered), { timeout }).toBe(true);
    const retained = page.locator('dialog[aria-label="Permanently delete entry"]');
    await expect(retained).toBeHidden(); await expect(retained).toHaveJSProperty('open', false);
    await retained.getByText('Delete permanently', { exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    await page.clock.fastForward(16_000);
    const recovery = page.getByRole('form', { name: `Verify database: ${name}`, exact: true });
    await recovery.getByLabel('Master password', { exact: true }).fill(password); await recovery.getByLabel('Master password', { exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
    await expect(dialog(page).getByRole('alert')).toContainText('session changed'); await expect(confirm(page)).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event('release-delete-save')));
    await expect.poll(() => page.evaluate(() => (window as any).deleteGate.completed), { timeout }).toBe(true);
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    const db = (await download(page, false)).db;
    expect(entries(db)).toHaveLength(3); expect(db.deletedObjects).toHaveLength(0);
    const entry = entries(db).find(entry => entry.uuid.id === source.id)!;
    expect(text(entry.fields.get('Notes'))).toBe('Saved during lock');
    expect(entry.parentGroup?.uuid.id).not.toBe(source.groupId);
});
