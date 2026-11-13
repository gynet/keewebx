import { test, expect, type Locator, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

// Follow next-groups-lifecycle / next-export: disposable encrypted input,
// visible UI mutations, actual downloads and independent runner-side decoding.
const password = 'entry move disposable password';
const name = 'Entry move';
const title = 'Move account';
const timeout = 30_000;
const proof = Buffer.from([0, 1, 10, 127, 128, 200, 255]);
const longGroup = 'DestinationWithSharedPrefix'.repeat(4) + 'Alpha';
const credentials = () => new kdbx.Credentials(kdbx.ProtectedValue.fromString(password));
const entries = (db: kdbx.Kdbx) => db.groups.flatMap(group => [...group.allEntries()]);
const text = (entry: kdbx.KdbxEntry, key: string) => {
    const value = entry.fields.get(key);
    return value instanceof kdbx.ProtectedValue ? value.getText() : value;
};
async function decrypt(bytes: Buffer) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    return kdbx.Kdbx.load(new Uint8Array(bytes).buffer, credentials());
}
async function fixture() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(credentials(), name);
    const root = db.groups[0];
    const source = db.createGroup(db.createGroup(root, 'Source'), 'Accounts');
    const target = db.createGroup(db.createGroup(root, 'Team B'), 'Accounts');
    const other = db.createGroup(db.createGroup(root, 'Team C'), 'Accounts');
    const longTarget = db.createGroup(target, longGroup);
    const bin = db.getGroup(db.meta.recycleBinUuid!)!;
    db.createGroup(bin, 'Hidden trashed group');
    const entry = db.createEntry(source);
    entry.fields.set('Title', title);
    entry.fields.set('UserName', 'move user');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Earlier secret'));
    entry.fields.set('Notes', kdbx.ProtectedValue.fromString('Protected notes\nsecond line'));
    entry.tags = ['organization', 'keep'];
    entry.pushHistory();
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Current secret'));
    entry.fields.set('Recovery code', kdbx.ProtectedValue.fromString('Custom secret'));
    entry.fields.set('URL', 'https://example.test/move');
    entry.binaries.set('proof.bin', await db.createBinary(new Uint8Array(proof).buffer));
    const sibling = db.createEntry(other);
    sibling.fields.set('Title', 'Unchanged sibling');
    sibling.fields.set('Password', kdbx.ProtectedValue.fromString('Sibling secret'));
    return { data: Buffer.from(await db.save()), ids: {
        root: root.uuid.id, source: source.uuid.id, target: target.uuid.id, other: other.uuid.id,
        entry: entry.uuid.id, sibling: sibling.uuid.id, bin: bin.uuid.id, longTarget: longTarget.uuid.id
    } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function duplicateFixture() {
    const source = await fixture();
    const db = await decrypt(source.data);
    const root = db.groups[0];
    const first = db.createGroup(root, 'Work');
    const second = db.createGroup(root, 'Work');
    const firstArchive = db.createGroup(first, 'Archive');
    const sameParentArchive = db.createGroup(first, 'Archive');
    const secondArchive = db.createGroup(second, 'Archive');
    const literalPath = db.createGroup(root, 'Work / Archive');
    const literalOrdinal = db.createGroup(root, 'Work (1)');
    const secondRoot = kdbx.KdbxGroup.create('Another raw root name');
    db.groups.push(secondRoot);
    const rootArchive = db.createGroup(secondRoot, 'Archive');
    return { ...source, data: Buffer.from(await db.save()), firstWork: first.uuid.id, secondWork: second.uuid.id,
        targets: [
            { path: `${name} (1) / Work (1) / Archive (1)`, id: firstArchive.uuid.id },
            { path: `${name} (1) / Work (1) / Archive (2)`, id: sameParentArchive.uuid.id },
            { path: `${name} (1) / Work (2) / Archive`, id: secondArchive.uuid.id },
            { path: `${name} (2) / Archive`, id: rootArchive.uuid.id },
            { path: `${name} (1) / "Work / Archive"`, id: literalPath.uuid.id },
            { path: `${name} (1) / "Work (1)"`, id: literalOrdinal.uuid.id }
        ]
    };
}
const row = (page: Page, value = title) => page.locator('.entry-row').filter({ has: page.getByText(value, { exact: true }) });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Move entry to group', exact: true });
const moveTrigger = (page: Page) => page.getByRole('button', { name: 'Move to group…', exact: true });
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Vault', exact: true });
async function activate(control: Locator, touch = false) { if (touch) await control.tap(); else await control.click(); }
async function browse(page: Page, touch = false) {
    if (!await navigation(page).isVisible()) await activate(page.getByRole('button', { name: 'Browse vault', exact: true }), touch);
}
async function open(page: Page, source: Fixture) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: `${name}.kdbx`, mimeType: 'application/octet-stream', buffer: source.data });
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await expect(row(page)).toBeVisible({ timeout });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}
async function choose(page: Page, label = `${name} / Team B / Accounts`) {
    await dialog(page).getByRole('combobox', { name: 'Destination group', exact: true }).selectOption({ label });
}
async function download(page: Page, touch = false) {
    await browse(page, touch);
    await activate(navigation(page).getByRole('button', { name: 'Settings', exact: true }), touch);
    await activate(page.getByRole('tab', { name: 'Database', exact: true }), touch);
    const form = page.getByRole('form', { name: `Database settings: ${name}`, exact: true });
    const waiting = page.waitForEvent('download');
    await activate(form.getByRole('button', { name: 'Download KDBX', exact: true }), touch);
    const output = await waiting;
    expect(await output.failure()).toBeNull();
    const stream = await output.createReadStream();
    if (!stream) throw new Error('No encrypted download stream');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    await test.info().attach('actual-downloaded.kdbx', { body: bytes, contentType: 'application/octet-stream' });
    expect(bytes.includes(Buffer.from('Current secret'))).toBe(false);
    await activate(page.locator('#settings-back:visible, .settings__phone-back:visible'), touch);
    return { bytes, db: await decrypt(bytes) };
}
function fidelity(db: kdbx.Kdbx, source: Fixture, parent = source.ids.target) {
    const all = entries(db);
    expect(all).toHaveLength(2);
    const moved = all.filter(entry => entry.uuid.id === source.ids.entry);
    expect(moved).toHaveLength(1);
    const entry = moved[0];
    expect(entry.parentGroup?.uuid.id).toBe(parent);
    expect(text(entry, 'Title')).toBe(title);
    expect(text(entry, 'UserName')).toBe('move user');
    expect(text(entry, 'URL')).toBe('https://example.test/move');
    for (const [key, value] of [['Password', 'Current secret'], ['Recovery code', 'Custom secret'], ['Notes', 'Protected notes\nsecond line']]) {
        expect(entry.fields.get(key)).toBeInstanceOf(kdbx.ProtectedValue);
        expect(text(entry, key)).toBe(value);
    }
    expect(entry.tags).toEqual(['organization', 'keep']);
    expect(entry.history).toHaveLength(1);
    expect(text(entry.history[0], 'Password')).toBe('Earlier secret');
    expect(entry.history[0].fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
    const binary = entry.binaries.get('proof.bin');
    expect(kdbx.KdbxBinaries.isKdbxBinaryWithHash(binary)).toBe(true);
    if (!kdbx.KdbxBinaries.isKdbxBinaryWithHash(binary)) throw new Error('Lost binary reference');
    const bytes = binary.value instanceof kdbx.ProtectedValue ? binary.value.getBinary() : new Uint8Array(binary.value);
    expect(Buffer.from(bytes)).toEqual(proof);
    const sibling = all.find(entry => entry.uuid.id === source.ids.sibling)!;
    expect(sibling.parentGroup?.uuid.id).toBe(source.ids.other);
    expect(text(sibling, 'Password')).toBe('Sibling secret');
    expect(db.deletedObjects).toHaveLength(0);
    expect(db.groups[0].uuid.id).toBe(source.ids.root);
    expect(db.meta.recycleBinUuid?.id).toBe(source.ids.bin);
}
async function saveReopen(page: Page, touch = false) {
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await browse(page, touch);
    await activate(navigation(page).getByRole('button', { name: 'Lock', exact: true }), touch);
    await expect(page.locator('#password')).toBeVisible({ timeout });
    await page.reload();
    await activate(page.locator('.vault-row').filter({ has: page.getByText(`${name}.kdbx`, { exact: true }) }), touch);
    await page.locator('#password').fill(password);
    await activate(page.locator('#unlock'), touch);
    await expect(row(page)).toBeVisible({ timeout });
    await activate(row(page), touch);
}
async function classicSyncSetting(page: Page, value: '0' | '1') {
    await page.clock.install();
    await page.goto('/index.html?ui=classic');
    await page.locator('#open__icon-more').click();
    await page.locator('#open__icon-settings').click();
    await page.locator('#settings__general-auto-save-interval').selectOption(value);
    await page.clock.runFor(100);
}

// Existing sync-safety peer pattern: encrypted revisions through real HTTP,
// never injecting application models or production test hooks.
async function peer(source: Fixture) {
    let data = source.data;
    let revision = Date.UTC(2026, 10, 13);
    let writes = 0;
    const replace = (bytes: Buffer) => { data = Buffer.from(bytes); revision += 1000; };
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, If-Match, If-None-Match');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (req.method === 'PUT') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            replace(Buffer.concat(chunks)); ++writes;
            res.writeHead(200).end(); return;
        }
        res.setHeader('Last-Modified', new Date(revision).toUTCString());
        res.setHeader('ETag', `"${revision}"`);
        res.writeHead(200).end(req.method === 'GET' ? data : undefined);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/move.kdbx`,
        replace, bytes: () => data, writes: () => writes,
        async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    };
}

test.describe('New same-vault entry move', () => {
    test.setTimeout(90_000);
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark'] as const) {
        test.describe(`${mobile ? '320px touch' : 'desktop'} ${colorScheme}`, () => {
            test.use({ viewport: mobile ? { width: 320, height: 350 } : { width: 1280, height: 800 }, hasTouch: mobile, colorScheme });
            test('moves by explicit path, preserves identity and encrypted content after save/reopen', async ({ page, browser }) => {
                const source = await fixture();
                await open(page, source);
                await activate(row(page), mobile);
                await activate(moveTrigger(page), mobile);
                const select = dialog(page).getByRole('combobox', { name: 'Destination group', exact: true });
                await expect(select).toBeFocused();
                await expect(select).toHaveValue('');
                await expect(dialog(page).getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
                // Playwright's enabled-state matcher does not model <option disabled>.
                await expect(select.locator('option').filter({ hasText: 'current group' })).toHaveJSProperty('disabled', true);
                await expect(select.locator('option').filter({ hasText: /Recycle Bin|Hidden trashed/ })).toHaveCount(0);
                await expect(select.locator('option').filter({ hasText: 'Team C / Accounts' })).toHaveCount(1);
                await choose(page, `${name} / Team B / Accounts / ${longGroup}`);
                await expect(dialog(page).getByText(`Destination: ${name} / Team B / Accounts / ${longGroup}`, { exact: true })).toBeVisible();
                expect(await dialog(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
                await page.screenshot({ path: test.info().outputPath('long-destination.png'), fullPage: true });
                await choose(page);
                expect(await dialog(page).evaluate(el => el.matches(':modal'))).toBe(true);
                expect(await dialog(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
                await page.screenshot({ path: test.info().outputPath('move-dialog.png'), fullPage: true });
                await activate(dialog(page).getByRole('button', { name: 'Move', exact: true }), mobile);
                await expect(dialog(page)).toHaveCount(0);
                await expect(page.locator('#entry-title')).toHaveText(title);
                await expect(moveTrigger(page)).toBeFocused();
                await expect(row(page)).toHaveCount(1);
                await expect(row(page, 'Unchanged sibling')).toHaveCount(0); // destination filter follows the entry
                await saveReopen(page, mobile);
                const { db, bytes } = await download(page, mobile);
                fidelity(db, source);
                expect(db.getGroup(source.ids.source)?.entries).toHaveLength(0);
                // A fresh UI imports the actual downloaded artifact, not the original fixture/cache.
                const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
                try {
                    const fresh = await context.newPage();
                    await open(fresh, { ...source, data: bytes });
                    await row(fresh).click();
                    await moveTrigger(fresh).click();
                    await expect(dialog(fresh).getByRole('combobox').locator('option:disabled')).toHaveText(`${name} / Team B / Accounts (current group)`);
                } finally { await context.close(); }
                // The completed move must also fit: a long unbroken destination
                // previously overflowed detail__where after the modal closed.
                await activate(moveTrigger(page), mobile);
                await choose(page, `${name} / Team B / Accounts / ${longGroup}`);
                await activate(dialog(page).getByRole('button', { name: 'Move', exact: true }), mobile);
                await expect(page.locator('.detail__where')).toHaveText(longGroup);
                expect(await page.locator('main.detail').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
                expect(await page.locator('.detail__where').evaluate(el => {
                    const bounds = el.getBoundingClientRect();
                    const parent = el.parentElement!.getBoundingClientRect();
                    return bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1;
                })).toBe(true);
                await page.screenshot({ path: test.info().outputPath('moved-long-group.png'), fullPage: true });
                fidelity((await download(page, mobile)).db, source, source.ids.longTarget);
            });
        });
    }

    test('cancel, Escape and rejected draft discard preserve the entry; accepted discard never saves the draft', async ({ page }) => {
        const source = await fixture();
        await open(page, source);
        await row(page).click();
        await moveTrigger(page).click();
        await choose(page);
        await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(moveTrigger(page)).toBeFocused();
        await moveTrigger(page).click();
        await choose(page);
        await page.keyboard.press('Escape');
        await expect(moveTrigger(page)).toBeFocused();
        const notes = page.getByRole('region', { name: 'Notes', exact: true });
        await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
        await notes.getByRole('textbox').fill('Discard me, never persist');
        page.once('dialog', prompt => prompt.dismiss());
        await moveTrigger(page).click();
        await expect(dialog(page)).toHaveCount(0);
        await expect(notes.getByRole('textbox')).toHaveValue('Discard me, never persist');
        page.once('dialog', prompt => prompt.accept());
        await moveTrigger(page).click();
        await expect(dialog(page)).toBeVisible();
        await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        fidelity((await download(page)).db, source, source.ids.source);
        // Trash has a separate Restore workflow; normal move must not expose it as a destination/source.
        await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
        await navigation(page).getByRole('button', { name: 'Trash', exact: true }).click();
        await row(page).click();
        await expect(moveTrigger(page)).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
    });

    test('disambiguates exact duplicate sibling/root paths and literal separators, moving each to the exact UUID', async ({ page }) => {
        const source = await duplicateFixture();
        await open(page, source);
        await row(page).click();
        for (const target of source.targets) {
            await moveTrigger(page).click();
            const select = dialog(page).getByRole('combobox');
            const labels = await select.locator('option').allTextContents();
            expect(new Set(labels).size).toBe(labels.length);
            await choose(page, target.path);
            await expect(dialog(page).getByText(`Destination: ${target.path}`, { exact: true })).toBeVisible();
            // Values stay UUID-based; ordinals are only the displayed choice.
            expect((await select.inputValue()).endsWith(`:${target.id}`)).toBe(true);
            await page.screenshot({ path: test.info().outputPath(`duplicate-choice-${source.targets.indexOf(target)}.png`), fullPage: true });
            await dialog(page).getByRole('button', { name: 'Move', exact: true }).click();
            await expect(page.locator('#entry-title')).toHaveText(title);
            fidelity((await download(page)).db, source, target.id);
        }
    });

    for (const mutation of ['entry moved', 'destination deleted', 'duplicate sibling reordered'] as const) {
        test(`rejects stale ${mutation} after a real encrypted remote revision`, async ({ page }) => {
            const source = mutation === 'duplicate sibling reordered' ? await duplicateFixture() : await fixture();
            const dav = await peer(source);
            try {
                await classicSyncSetting(page, '1');
                await page.goto('/next.html');
                await page.locator('#open-webdav').click();
                await page.locator('#webdav-url').fill(dav.url);
                await page.locator('#webdav-user').fill('tester');
                await page.locator('#webdav-pass').fill('disposable');
                await page.locator('#webdav-next').click();
                await page.locator('#password').fill(password);
                await page.locator('#unlock').click();
                await expect(row(page)).toBeVisible({ timeout });
                await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
                await row(page).click();
                await moveTrigger(page).click();
                // The WebDAV filename is the file model's display name.
                await choose(page, 'targets' in source ? source.targets[0].path.replace(name, 'move') : 'move / Team B / Accounts');
                const remote = await decrypt(dav.bytes());
                if (mutation === 'entry moved') remote.move(entries(remote).find(e => e.uuid.id === source.ids.entry)!, remote.getGroup(source.ids.other)!);
                else if ('targets' in source) {
                    const first = remote.getGroup(source.firstWork)!;
                    remote.move(remote.getGroup(source.secondWork)!, remote.groups[0], remote.groups[0].groups.indexOf(first));
                } else remote.move(remote.getGroup(source.ids.target)!, null);
                remote.createEntry(remote.groups[0]).fields.set('Title', 'Remote revision arrived');
                dav.replace(Buffer.from(await remote.save()));
                await page.clock.fastForward(61_000);
                await expect(row(page, 'Remote revision arrived')).toHaveCount(1, { timeout });
                await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
                const before = Buffer.from(dav.bytes());
                const writes = dav.writes();
                await expect(dialog(page).getByRole('alert')).toContainText('changed');
                await expect(dialog(page).getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
                await dialog(page).getByRole('combobox').press('Enter');
                await expect(dialog(page)).toBeVisible();
                await page.screenshot({ path: test.info().outputPath('stale-move-denied.png'), fullPage: true });
                await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
                expect(dav.bytes().equals(before)).toBe(true);
                expect(dav.writes()).toBe(writes);
                const latest = await decrypt(dav.bytes());
                expect(entries(latest).find(e => e.uuid.id === source.ids.entry)?.parentGroup?.uuid.id)
                    .toBe(mutation === 'entry moved' ? source.ids.other : source.ids.source);
            } finally { await dav.close(); }
        });
    }

    test('idle lock hides the chooser and recovery invalidates its old selection without moving', async ({ page }) => {
        const source = await fixture();
        await classicSyncSetting(page, '0');
        await open(page, source);
        await page.locator('#open-settings').click();
        await page.getByRole('tab', { name: 'Security', exact: true }).click();
        await page.locator('#setting-auto-lock').selectOption('5');
        await page.locator('#settings-back').click();
        await row(page).click();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('.entry-editor').getByLabel('Title', { exact: true }).fill('Edited before lock');
        await page.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
        await moveTrigger(page).click();
        await choose(page);
        let entered = false;
        let completed = false;
        await page.exposeFunction('sdetMoveEncryptEntered', () => { entered = true; });
        await page.exposeFunction('sdetMoveEncryptCompleted', () => { completed = true; });
        await page.evaluate(() => {
            const encrypt = SubtleCrypto.prototype.encrypt;
            SubtleCrypto.prototype.encrypt = async function (...args: Parameters<SubtleCrypto['encrypt']>) {
                SubtleCrypto.prototype.encrypt = encrypt;
                const release = new Promise<void>(resolve => window.addEventListener('sdet-move-release', () => resolve(), { once: true }));
                await (window as unknown as { sdetMoveEncryptEntered(): Promise<void> }).sdetMoveEncryptEntered();
                await release;
                const bytes = await encrypt.apply(this, args);
                await (window as unknown as { sdetMoveEncryptCompleted(): Promise<void> }).sdetMoveEncryptCompleted();
                return bytes;
            };
        });
        await page.clock.fastForward(6 * 60_000);
        await expect.poll(() => entered, { timeout }).toBe(true);
        const retained = page.locator('dialog[aria-label="Move entry to group"]');
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
        await expect(dialog(page).getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
        await dialog(page).getByRole('combobox').press('Enter');
        await expect(dialog(page)).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('recovered-stale-move.png'), fullPage: true });
        await page.evaluate(() => window.dispatchEvent(new Event('sdet-move-release')));
        await expect.poll(() => completed, { timeout }).toBe(true);
        await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        const { db } = await download(page);
        const entry = entries(db).find(e => e.uuid.id === source.ids.entry)!;
        expect(entry.parentGroup?.uuid.id).toBe(source.ids.source);
        expect(text(entry, 'Title')).toBe('Edited before lock');
        expect(text(entry, 'Password')).toBe('Current secret');
        expect(db.deletedObjects).toHaveLength(0);
    });
});
