import { test, expect, type Page, type Locator } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

// Same real-UI/encrypted-download pattern as next-entry-history/move.
const name = 'Clone and sort';
const password = 'clone sort disposable password';
const timeout = 30_000;
const proof = Buffer.from([0, 255, 127, 128, 10, 42]);
const entries = (db: kdbx.Kdbx) => db.groups.flatMap(group => [...group.allEntries()]);
const text = (value: unknown) => value instanceof kdbx.ProtectedValue ? value.getText() : value;
const credentials = () => new kdbx.Credentials(kdbx.ProtectedValue.fromString(password));
async function decrypt(data: Buffer) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    return kdbx.Kdbx.load(new Uint8Array(data).buffer, credentials());
}
async function fixture() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(credentials(), name);
    const group = db.createGroup(db.createGroup(db.groups[0], 'Work'), 'Accounts');
    const other = db.createGroup(db.groups[0], 'Other');
    const source = db.createEntry(group);
    // Shared getRank uses case-sensitive raw string ranking; use an exact lowercase term.
    source.fields.set('Title', 'needle');
    source.fields.set('UserName', 'bravo');
    source.fields.set('Password', kdbx.ProtectedValue.fromString('old secret'));
    source.fields.set('URL', 'https://z.example');
    source.fields.set('Notes', kdbx.ProtectedValue.fromString('Applied notes'));
    source.fields.set('Recovery code', kdbx.ProtectedValue.fromString('custom secret'));
    source.fields.set('otp', kdbx.ProtectedValue.fromString('otpauth://totp/test?secret=JBSWY3DPEHPK3PXP'));
    source.tags = ['daily', 'security'];
    source.times.creationTime = new Date('2020-01-01T00:00:00Z');
    source.times.lastModTime = new Date('2020-01-02T00:00:00Z');
    source.times.expires = true; source.times.expiryTime = new Date('2029-01-01T00:00:00Z');
    source.icon = 13; source.autoType.defaultSequence = '{USERNAME}{TAB}{PASSWORD}{ENTER}';
    source.binaries.set('proof.bin', await db.createBinary(new Uint8Array(proof).buffer));
    source.pushHistory();
    source.fields.set('Password', kdbx.ProtectedValue.fromString('current secret'));
    source.times.lastModTime = new Date('2022-01-01T00:00:00Z');
    for (const [title, user, url, created, updated] of [
        ['Alpha', 'charlie', 'https://needle.example', '2022', '2020'],
        ['Beta', 'needle', 'https://a.example', '2021', '2021']
    ]) {
        const entry = db.createEntry(group);
        entry.fields.set('Title', title); entry.fields.set('UserName', user); entry.fields.set('URL', url);
        entry.times.creationTime = new Date(`${created}-01-01T00:00:00Z`);
        entry.times.lastModTime = new Date(`${updated}-01-01T00:00:00Z`);
        if (title === 'Beta') for (const file of ['a.bin', 'b.bin']) entry.binaries.set(file, await db.createBinary(new Uint8Array([1]).buffer));
    }
    return { data: Buffer.from(await db.save()), entryId: source.uuid.id, groupId: group.uuid.id, otherId: other.uuid.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const row = (page: Page, title = 'needle') => page.locator('.entry-row').filter({
    has: page.getByText(title, { exact: true }).and(page.locator('.entry-row__title'))
});
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Make a copy', exact: true });
const trigger = (page: Page) => page.getByRole('button', { name: 'Make a copy…', exact: true });
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Vault', exact: true });
async function activate(control: Locator, touch = false) { if (touch) await control.tap(); else await control.click(); }
async function browse(page: Page, touch = false) {
    const show = page.getByRole('button', { name: 'Show menu', exact: true });
    if (await show.isVisible()) await activate(show, touch);
    if (!await navigation(page).isVisible()) await activate(page.getByRole('button', { name: 'Browse vault', exact: true }), touch);
}
async function open(page: Page, source: Fixture) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: `${name}.kdbx`, mimeType: 'application/octet-stream', buffer: source.data });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(row(page)).toBeVisible({ timeout });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    // Use the existing visible menu toggle so the floating toolbar does not cover list rows.
    const handle = page.getByRole('button', { name: 'Move menu', exact: true });
    if (await handle.isVisible()) await handle.click();
}
async function download(page: Page, touch = false, waitSaved = true) {
    if (waitSaved) await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await browse(page, touch);
    await activate(navigation(page).getByRole('button', { name: 'Settings', exact: true }), touch);
    await activate(page.getByRole('tab', { name: 'Database', exact: true }), touch);
    const pending = page.waitForEvent('download');
    await activate(page.getByRole('button', { name: 'Download KDBX', exact: true }), touch);
    const file = await pending; expect(await file.failure()).toBeNull();
    const stream = await file.createReadStream(); if (!stream) throw new Error('Missing encrypted download');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const path = test.info().outputPath(`actual-download-${Date.now()}.kdbx`);
    await writeFile(path, bytes); await test.info().attach('encrypted download', { path, contentType: 'application/octet-stream' });
    await activate(page.locator('#settings-back:visible, .settings__phone-back:visible'), touch);
    return { bytes, db: await decrypt(bytes) };
}
function binary(entry: kdbx.KdbxEntry, name: string) {
    const value = entry.binaries.get(name);
    if (!kdbx.KdbxBinaries.isKdbxBinaryWithHash(value)) throw new Error('Missing binary');
    return Buffer.from(value.value instanceof kdbx.ProtectedValue ? value.value.getBinary() : new Uint8Array(value.value));
}
function semantic(entry: kdbx.KdbxEntry): unknown {
    return { id: entry.uuid.id, parent: entry.parentGroup?.uuid.id,
        fields: [...entry.fields].map(([name, value]) => [name, text(value), value instanceof kdbx.ProtectedValue]),
        tags: entry.tags, created: entry.times.creationTime, updated: entry.times.lastModTime,
        icon: entry.icon, autoType: entry.autoType, expires: entry.times.expires, expiry: entry.times.expiryTime,
        binaries: [...entry.binaries.keys()].map(name => [name, binary(entry, name).toString('base64')]), history: entry.history.map(semantic) };
}
async function fidelity(db: kdbx.Kdbx, source: Fixture) {
    const original = await decrypt(source.data);
    const before = entries(original).find(e => e.uuid.id === source.entryId)!;
    expect(entries(db)).toHaveLength(entries(original).length + 1);
    for (const entry of entries(original)) expect(semantic(entries(db).find(e => e.uuid.id === entry.uuid.id)!)).toEqual(semantic(entry));
    const copy = entries(db).find(e => !entries(original).some(old => old.uuid.id === e.uuid.id))!;
    expect(text(copy.fields.get('Title'))).toBe('needle Copy');
    expect(copy.parentGroup?.uuid.id).toBe(source.groupId);
    expect(copy.history).toHaveLength(0); // Classic cloneEntry copies applied state, never old history.
    for (const [name, value] of before.fields) if (name !== 'Title') {
        expect(text(copy.fields.get(name))).toBe(text(value));
        expect(copy.fields.get(name) instanceof kdbx.ProtectedValue).toBe(value instanceof kdbx.ProtectedValue);
    }
    expect(copy.tags).toEqual(before.tags); expect(copy.icon).toBe(before.icon); expect(copy.autoType).toEqual(before.autoType);
    expect(copy.times.expires).toBe(true); expect(copy.times.expiryTime).toEqual(before.times.expiryTime);
    expect(copy.times.creationTime!.getTime()).toBeGreaterThan(before.times.creationTime!.getTime());
    expect(binary(copy, 'proof.bin')).toEqual(proof); expect(db.deletedObjects).toHaveLength(0);
    return copy.uuid.id;
}

// Existing encrypted WebDAV peer pattern; no model injection or app test hooks.
async function peer(source: Fixture) {
    let data = source.data; let revision = Date.UTC(2026, 10, 13); let writes = 0;
    const replace = (next: Buffer) => { data = Buffer.from(next); revision += 1000; };
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
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/clone.kdbx`, replace, bytes: () => data, writes: () => writes,
        async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test.describe('New entry clone and sort', () => {
    test.setTimeout(90_000);
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark'] as const) test.describe(`${mobile ? '320px touch' : 'desktop'} ${colorScheme}`, () => {
        test.use({ viewport: mobile ? { width: 320, height: 350 } : { width: 1280, height: 800 }, hasTouch: mobile, colorScheme });
        test('sort and clone remain reachable; new UUID/current protected content survives export and independent edit', async ({ page, browser }) => {
            const source = await fixture(); await open(page, source);
            await page.getByRole('combobox', { name: 'Sort entries', exact: true }).selectOption('-title');
            await expect(page.locator('.entry-row__title')).toHaveText(['needle', 'Beta', 'Alpha']);
            await page.screenshot({ path: test.info().outputPath('sort-list.png'), fullPage: true });
            await activate(row(page), mobile); await activate(trigger(page), mobile);
            await expect(dialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
            await page.keyboard.press('Escape'); await expect(trigger(page)).toBeFocused();
            await activate(trigger(page), mobile);
            expect(await dialog(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
            await page.screenshot({ path: test.info().outputPath('clone-confirm.png'), fullPage: true });
            await activate(dialog(page).getByRole('button', { name: 'Create copy', exact: true }), mobile);
            await expect(page.locator('.detail__title')).toHaveText('needle Copy');
            const exported = await download(page, mobile); const cloneId = await fidelity(exported.db, source);
            const fresh = await browser.newContext({ baseURL: page.url() });
            try {
                const next = await fresh.newPage(); await open(next, { ...source, data: exported.bytes });
                await row(next, 'needle Copy').click();
                await next.getByRole('button', { name: 'Edit', exact: true }).click();
                await next.locator('.entry-editor').getByLabel('Password', { exact: true }).fill('copy-only changed secret');
                await next.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
                const after = (await download(next)).db;
                expect(text(entries(after).find(e => e.uuid.id === cloneId)!.fields.get('Password'))).toBe('copy-only changed secret');
                expect(semantic(entries(after).find(e => e.uuid.id === source.entryId)!)).toEqual(semantic(entries(await decrypt(source.data)).find(e => e.uuid.id === source.entryId)!));
            } finally { await fresh.close(); }
        });
    });

    test('all Classic sort choices use active query, retain selection/drafts, and never mutate encrypted data', async ({ page }) => {
        const source = await fixture(); await open(page, source); await row(page).click();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('.entry-editor').getByLabel('Title', { exact: true }).fill('Keep this unsaved draft');
        const orders: Record<string, string[]> = {
            title: ['Alpha', 'Beta', 'needle'], '-title': ['needle', 'Beta', 'Alpha'],
            website: ['Beta', 'Alpha', 'needle'], '-website': ['needle', 'Alpha', 'Beta'],
            user: ['needle', 'Alpha', 'Beta'], '-user': ['Beta', 'Alpha', 'needle'],
            created: ['needle', 'Beta', 'Alpha'], '-created': ['Alpha', 'Beta', 'needle'],
            updated: ['Alpha', 'Beta', 'needle'], '-updated': ['needle', 'Beta', 'Alpha'],
            '-attachments': ['needle', 'Beta', 'Alpha']
        };
        for (const [sort, titles] of Object.entries(orders)) {
            await page.getByRole('combobox', { name: 'Sort entries', exact: true }).selectOption(sort);
            await expect(page.locator('.entry-row__title')).toHaveText(titles);
            await expect(page.locator('.entry-row--on')).toHaveAttribute('data-entry', 'needle');
            await expect(page.locator('.entry-editor').getByLabel('Title', { exact: true })).toHaveValue('Keep this unsaved draft');
        }
        await page.locator('.entry-editor').getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.locator('#search').fill('needle');
        await page.getByRole('combobox', { name: 'Sort entries', exact: true }).selectOption('-rank');
        // Shared weights: exact title 10*10 > exact user 10*5 > URL substring 3*8.
        await expect(page.locator('.entry-row__title')).toHaveText(['needle', 'Beta', 'Alpha']);
        await page.locator('#search').fill('a');
        await expect(page.locator('.entry-row__title')).toHaveText(['Alpha', 'Beta', 'needle']);
        await page.locator('#search').fill('bravo');
        await expect(page.locator('.entry-row__title')).toHaveText(['needle']);
        await page.locator('#search').fill('');
        await expect(page.locator('.entry-row')).toHaveCount(3);
        const exported = (await download(page)).db;
        expect(entries(exported).map(semantic)).toEqual(entries(await decrypt(source.data)).map(semantic));
    });

    test('cancel and rejected discard preserve Notes; accepted discard copies only applied state', async ({ page }) => {
        const source = await fixture(); await open(page, source); await row(page).click();
        const notes = page.getByRole('region', { name: 'Notes', exact: true });
        await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
        await notes.getByRole('textbox').fill('Do not copy this unsaved note');
        await trigger(page).click(); await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(notes.getByRole('textbox')).toHaveValue('Do not copy this unsaved note');
        await trigger(page).click(); page.once('dialog', prompt => prompt.dismiss());
        await dialog(page).getByRole('button', { name: 'Create copy', exact: true }).click();
        await expect(dialog(page)).toBeVisible(); await expect(page.locator('.entry-row')).toHaveCount(3);
        page.once('dialog', prompt => prompt.accept());
        await dialog(page).getByRole('button', { name: 'Create copy', exact: true }).click();
        await fidelity((await download(page)).db, source);
    });

    test('an existing identical copy title does not steal selection; trash removes only the new UUID', async ({ page }) => {
        const source = await fixture(); const seeded = await decrypt(source.data);
        const existing = seeded.createEntry(seeded.getGroup(source.groupId)!);
        existing.fields.set('Title', 'needle Copy'); existing.fields.set('Password', kdbx.ProtectedValue.fromString('existing copy secret'));
        const existingId = existing.uuid.id; source.data = Buffer.from(await seeded.save());
        await open(page, source); await row(page).click(); await trigger(page).click();
        await dialog(page).getByRole('button', { name: 'Create copy', exact: true }).click();
        await expect(page.locator('.entry-row--on')).toContainText('bravo');
        const copied = await download(page); const cloneId = await fidelity(copied.db, source);
        await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
        await navigation(page).getByRole('button', { name: 'Trash', exact: true }).click();
        await row(page, 'needle Copy').click(); await expect(trigger(page)).toHaveCount(0);
        const after = (await download(page)).db;
        expect(entries(after)).toHaveLength(5);
        expect(entries(after).find(e => e.uuid.id === cloneId)!.parentGroup?.uuid.id).toBe(after.meta.recycleBinUuid!.id);
        expect(text(entries(after).find(e => e.uuid.id === existingId)!.fields.get('Password'))).toBe('existing copy secret');
        expect(semantic(entries(after).find(e => e.uuid.id === source.entryId)!)).toEqual(semantic(entries(await decrypt(source.data)).find(e => e.uuid.id === source.entryId)!));
    });

    test('stale clone after encrypted remote movement cannot create or write a copy', async ({ page }) => {
        const source = await fixture(); const dav = await peer(source);
        try {
            await page.clock.install(); await page.goto('/index.html?ui=classic');
            await page.locator('#open__icon-more').click(); await page.locator('#open__icon-settings').click();
            await page.locator('#settings__general-auto-save-interval').selectOption('1'); await page.clock.runFor(100);
            await page.goto('/next.html'); await page.locator('#open-webdav').click();
            await page.locator('#webdav-url').fill(dav.url); await page.locator('#webdav-user').fill('tester');
            await page.locator('#webdav-pass').fill('disposable'); await page.locator('#webdav-next').click();
            await page.locator('#password').fill(password); await page.locator('#unlock').click();
            await expect(row(page)).toBeVisible({ timeout }); await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
            await row(page).click(); await trigger(page).click();
            const remote = await decrypt(dav.bytes()); remote.move(entries(remote).find(e => e.uuid.id === source.entryId)!, remote.getGroup(source.otherId)!);
            remote.createEntry(remote.groups[0]).fields.set('Title', 'Remote marker'); dav.replace(Buffer.from(await remote.save()));
            await page.clock.fastForward(61_000); await expect(row(page, 'Remote marker')).toHaveCount(1, { timeout });
            await expect(dialog(page).getByRole('alert')).toContainText('changed');
            await expect(dialog(page).getByRole('button', { name: 'Create copy', exact: true })).toBeDisabled();
            const before = Buffer.from(dav.bytes()); const writes = dav.writes();
            await page.keyboard.press('Enter'); expect(dav.bytes().equals(before)).toBe(true); expect(dav.writes()).toBe(writes);
            await page.screenshot({ path: test.info().outputPath('stale-clone.png'), fullPage: true });
        } finally { await dav.close(); }
    });
    test('idle recovery invalidates the old clone confirmation without creating an entry', async ({ page }) => {
        const source = await fixture();
        await page.clock.install(); await page.goto('/index.html?ui=classic');
        await page.locator('#open__icon-more').click(); await page.locator('#open__icon-settings').click();
        await page.locator('#settings__general-auto-save-interval').selectOption('0'); await page.clock.runFor(100);
        await open(page, source);
        await page.locator('#open-settings').click();
        await page.getByRole('tab', { name: 'Security', exact: true }).click();
        await page.locator('#setting-auto-lock').selectOption('5');
        await page.locator('#settings-back').click();
        await row(page).click();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('.entry-editor').getByLabel('Title', { exact: true }).fill('Edited before lock');
        await page.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
        await trigger(page).click();
        let entered = false;
        let completed = false;
        await page.exposeFunction('sdetCloneEncryptEntered', () => { entered = true; });
        await page.exposeFunction('sdetCloneEncryptCompleted', () => { completed = true; });
        await page.evaluate(() => {
            const encrypt = SubtleCrypto.prototype.encrypt;
            SubtleCrypto.prototype.encrypt = async function (...args: Parameters<SubtleCrypto['encrypt']>) {
                SubtleCrypto.prototype.encrypt = encrypt;
                const release = new Promise<void>(resolve => window.addEventListener('sdet-clone-release', () => resolve(), { once: true }));
                await (window as unknown as { sdetCloneEncryptEntered(): Promise<void> }).sdetCloneEncryptEntered();
                await release;
                const bytes = await encrypt.apply(this, args);
                await (window as unknown as { sdetCloneEncryptCompleted(): Promise<void> }).sdetCloneEncryptCompleted();
                return bytes;
            };
        });
        await page.clock.fastForward(6 * 60_000);
        await expect.poll(() => entered, { timeout }).toBe(true);
        const retained = page.locator('dialog[aria-label="Make a copy"]');
        await expect(retained).toBeHidden();
        await expect(retained).toHaveJSProperty('open', false);
        await expect(retained.locator('xpath=ancestor::*[@inert and @hidden]')).toHaveCount(1);
        await expect(dialog(page)).toHaveCount(0);
        await page.clock.fastForward(16_000);
        const form = page.getByRole('form', { name: `Verify database: ${name}`, exact: true });
        await expect(form).toBeVisible({ timeout });
        await form.getByLabel('Master password', { exact: true }).fill('wrong');
        await form.getByLabel('Master password', { exact: true }).press('Enter');
        await expect(form.getByRole('alert')).toContainText('Verification failed');
        await expect(retained).toBeHidden();
        await form.getByLabel('Master password', { exact: true }).fill(password);
        await form.getByLabel('Master password', { exact: true }).press('Enter');
        await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
        await expect(dialog(page)).toBeVisible();
        await expect(dialog(page).getByRole('alert')).toContainText('session changed');
        await expect(dialog(page).getByRole('button', { name: 'Create copy', exact: true })).toBeDisabled();
        await expect(dialog(page)).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('recovered-stale-clone.png'), fullPage: true });
        await page.evaluate(() => window.dispatchEvent(new Event('sdet-clone-release')));
        await expect.poll(() => completed, { timeout }).toBe(true);
        await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        const { db } = await download(page, false, false);
        const entry = entries(db).find(e => e.uuid.id === source.entryId)!;
        expect(entry.parentGroup?.uuid.id).toBe(source.groupId);
        expect(text(entry.fields.get('Title'))).toBe('Edited before lock');
        expect(text(entry.fields.get('Password'))).toBe('current secret');
        expect(entries(db)).toHaveLength(3);
        expect(entries(db).some(e => String(text(e.fields.get('Title'))).endsWith(' Copy'))).toBe(false);
        expect(db.deletedObjects).toHaveLength(0);
    });
});
