import { activateEntryAction } from '../entry-actions';
import { test, expect, type Page, type Locator } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'Disposable field acceptance';
const credentials = () => new kdbx.Credentials(kdbx.ProtectedValue.fromString(password));
const nav = (page: Page) => page.getByRole('navigation', { name: 'Vault', exact: true });
const editor = (page: Page) => page.locator('.entry-editor');
const row = (page: Page, title = 'Field account') => page.locator('.entry-row').filter({ has: page.getByText(title, { exact: true }) });
const text = (value: unknown) => value instanceof kdbx.ProtectedValue ? value.getText() : value;
const all = (db: kdbx.Kdbx) => [...db.groups[0].allEntries()];
async function fixture(history = 10) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(credentials(), 'Fields');
    db.setVersion(4, 1); db.meta.historyMaxItems = history;
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.groups[0]);
    entry.fields.set('Title', 'Field account'); entry.fields.set('UserName', '');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('secret<&>'));
    entry.fields.set('Notes', kdbx.ProtectedValue.fromString('Private notes\nsecond line'));
    entry.fields.set('Empty plain', ''); entry.fields.set('Empty protected', kdbx.ProtectedValue.fromString(''));
    entry.fields.set('Private multiline', kdbx.ProtectedValue.fromString('Private custom\nsecond line'));
    entry.fields.set('KP2A_URL', kdbx.ProtectedValue.fromString('https://private.example/path'));
    entry.fields.set('KP2A_URL_1', 'javascript:alert(1)');
    entry.binaries.set('proof.bin', await db.createBinary(new Uint8Array([0, 255, 128, 1]).buffer));
    if (history) { entry.pushHistory(); entry.fields.set('URL', 'https://current.example'); }
    for (const [user, count] of [['alice', 3], ['albert', 2], ['alfa', 1], ['alpine', 1], ['alto', 1], ['alina', 1]] as const) {
        for (let i = 0; i < count; i++) {
            const other = db.createEntry(db.groups[0]); other.fields.set('Title', `${user} ${i}`); other.fields.set('UserName', user);
        }
    }
    const excluded = db.createGroup(db.groups[0], 'Excluded'); excluded.enableSearching = false;
    const hidden = db.createEntry(excluded); hidden.fields.set('UserName', 'alexcluded');
    return { bytes: Buffer.from(await db.save()), id: entry.uuid.id, history };
}
async function click(control: Locator, touch: boolean) { if (touch) await control.tap(); else await control.click(); }
async function browse(page: Page, touch: boolean) {
    if (!await nav(page).isVisible()) await click(page.getByRole('button', { name: 'Browse vault', exact: true }), touch);
}
async function select(page: Page, touch: boolean, title = 'Field account') {
    if (!await row(page, title).isVisible()) {
        const back = page.getByRole('button', { name: 'Back', exact: true });
        if (await back.isVisible()) await click(back, touch);
    }
    await click(row(page, title), touch);
}
async function open(page: Page, source: Awaited<ReturnType<typeof fixture>>, touch: boolean) {
    await page.addInitScript(() => { if (!localStorage.getItem('appSettings')) localStorage.setItem('appSettings', JSON.stringify({ autoSave: false, autoSaveInterval: 0, idleMinutes: 0, hideEmptyFields: true })); });
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'Fields.kdbx', mimeType: 'application/octet-stream', buffer: source.bytes });
    await page.locator('#password').fill(password); await click(page.locator('#unlock'), touch);
    await expect(row(page)).toBeVisible(); await select(page, touch);
}
async function edit(page: Page, touch: boolean) { await click(page.getByRole('button', { name: 'Edit', exact: true }), touch); }
async function apply(page: Page, touch: boolean) { await click(editor(page).getByRole('button', { name: 'Save', exact: true }), touch); await expect(editor(page)).toHaveCount(0); }
async function field(page: Page, name: string) {
    const rows = editor(page).locator('.entry-editor__custom-row');
    for (const item of await rows.all()) if (await item.getByLabel('Field name', { exact: true }).inputValue() === name) return item;
    throw new Error(`Missing custom field ${name}`);
}
async function savedReopen(page: Page, touch: boolean) {
    await browse(page, touch); await click(nav(page).getByRole('button', { name: /^Save Fields/ }), touch);
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });
    await click(nav(page).getByRole('button', { name: 'Lock', exact: true }), touch);
    await expect(page.locator('#password')).toBeVisible(); await page.reload();
    await click(page.locator('.vault-row').filter({ has: page.getByText('Fields.kdbx', { exact: true }) }), touch);
    await page.locator('#password').fill(password); await click(page.locator('#unlock'), touch);
    await expect(row(page)).toBeVisible();
}
async function download(page: Page, touch: boolean) {
    await browse(page, touch); await click(nav(page).getByRole('button', { name: 'Settings', exact: true }), touch);
    await click(page.getByRole('tab', { name: 'Database', exact: true }), touch);
    const pending = page.waitForEvent('download'); await click(page.getByRole('button', { name: 'Download KDBX', exact: true }), touch);
    const output = await pending; expect(await output.failure()).toBeNull();
    const stream = await output.createReadStream(); if (!stream) throw new Error('No KDBX bytes');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks); await test.info().attach('encrypted-reopened.kdbx', { body: bytes, contentType: 'application/octet-stream' });
    const db = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer, credentials());
    await click(page.locator('#settings-back:visible, .settings__phone-back:visible'), touch); return db;
}
function fidelity(entry: kdbx.KdbxEntry) {
    for (const [name, value] of [['Notes', 'Private notes\nsecond line'], ['Private multiline', 'Private custom\nsecond line'], ['Empty protected', ''], ['Password', 'secret<&>']]) {
        expect(entry.fields.get(name)).toBeInstanceOf(kdbx.ProtectedValue); expect(text(entry.fields.get(name))).toBe(value);
    }
    expect(entry.fields.get('Empty plain')).toBe('');
    const binary = entry.binaries.get('proof.bin'); expect(kdbx.KdbxBinaries.isKdbxBinaryWithHash(binary)).toBe(true);
    if (!kdbx.KdbxBinaries.isKdbxBinaryWithHash(binary)) throw new Error('Missing proof');
    expect(Buffer.from(binary.value as ArrayBuffer)).toEqual(Buffer.from([0, 255, 128, 1]));
}
for (const touch of [false, true]) test.describe(touch ? '320px touch field workflows' : 'desktop field workflows', () => {
    test.use(touch ? { viewport: { width: 320, height: 568 }, hasTouch: true } : {});
    test.setTimeout(90_000);
    test('ranked suggestions, bounded additional URLs and empty fields survive encrypted cached reopen', async ({ page, browserName }) => {
        const source = await fixture(); await open(page, source, touch);
        await activateEntryAction(page, 'Show empty fields', touch);
        await expect(page.locator('[data-field="field:Empty protected"]')).toContainText('(empty)');
        await expect(page.locator('[data-field="url"]').getByRole('button', { name: 'Copy', exact: true })).toHaveCount(1);
        await expect(page.locator('[data-field="field:KP2A_URL"]').getByRole('link')).toHaveCount(0);
        await click(page.getByRole('button', { name: 'Show KP2A_URL', exact: true }), touch);
        await expect(page.locator('[data-field="field:KP2A_URL"]').getByRole('link')).toHaveAttribute('href', 'https://private.example/path');
        await expect(page.locator('[data-field="field:KP2A_URL_1"]').getByRole('link')).toHaveCount(0);
        await page.context().route('https://private.example/**', route => route.fulfill({ body: 'Opened approved website', contentType: 'text/plain' }));
        const popupPromise = page.waitForEvent('popup');
        await click(page.locator('[data-field="field:KP2A_URL"]').getByRole('link', { name: 'Open', exact: true }), touch);
        const popup = await popupPromise; await popup.waitForLoadState(); expect(popup.url()).toBe('https://private.example/path'); await popup.close();
        if (browserName === 'firefox') await page.evaluate(() => { navigator.clipboard.writeText = async value => { (window as any).copiedField = value; }; });
        await click(page.locator('[data-field="field:KP2A_URL"]').getByRole('button', { name: 'Copy', exact: true }), touch);
        await expect(page.locator('[data-field="field:KP2A_URL"]').getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
        expect(await page.evaluate(native => native ? navigator.clipboard.readText() : (window as any).copiedField, browserName === 'chromium')).toBe('https://private.example/path');
        await edit(page, touch); await editor(page).getByLabel('Username', { exact: true }).fill('al');
        const suggestions = page.getByRole('listbox', { name: 'Username suggestions', exact: true });
        await expect(suggestions.getByRole('option')).toHaveText(['alice', 'albert', 'alfa', 'alpine', 'alto']);
        if (touch) await click(suggestions.getByRole('option', { name: 'alice', exact: true }), touch);
        else { await editor(page).getByLabel('Username', { exact: true }).press('ArrowDown'); await editor(page).getByLabel('Username', { exact: true }).press('Enter'); }
        await expect(editor(page).getByLabel('Username', { exact: true })).toHaveValue('alice');
        await click(editor(page).getByRole('button', { name: 'Add website', exact: true }), touch);
        await (await field(page, 'KP2A_URL_2')).getByLabel('Field value', { exact: true }).fill('https://additional.example/path?q=1');
        await click(editor(page).getByRole('button', { name: 'Add website', exact: true }), touch);
        await (await field(page, 'KP2A_URL_3')).getByLabel('Field value', { exact: true }).fill('data:text/html,unsafe');
        await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveAttribute('readonly', '');
        await apply(page, touch);
        await expect(page.locator('[data-field="field:KP2A_URL_2"]').getByRole('link')).toHaveAttribute('href', 'https://additional.example/path?q=1');
        await expect(page.locator('[data-field="field:KP2A_URL_3"]').getByRole('link')).toHaveCount(0);
        await edit(page, touch); await editor(page).getByLabel('Username', { exact: true }).fill('canceled');
        await click(editor(page).getByRole('button', { name: 'Add website', exact: true }), touch);
        await click(editor(page).getByRole('button', { name: 'Cancel', exact: true }), touch);
        await savedReopen(page, touch); const db = await download(page, touch), entry = all(db).find(item => item.uuid.id === source.id)!;
        fidelity(entry); expect(entry.fields.get('UserName')).toBe('alice'); expect(entry.fields.has('KP2A_URL_4')).toBe(false);
        expect(entry.fields.get('KP2A_URL_2')).toBe('https://additional.example/path?q=1');
    });
    for (const limit of [0, 10]) test(`discard repeated applied edits and history restore, retention ${limit}, persists encrypted`, async ({ page }) => {
        const source = await fixture(limit); await open(page, source, touch);
        await select(page, touch, 'alice 0'); await edit(page, touch); await editor(page).getByLabel('Website', { exact: true }).fill('https://sibling.example'); await apply(page, touch);
        await select(page, touch); await edit(page, touch); await editor(page).getByLabel('Username', { exact: true }).fill('unsaved-first');
        await click(editor(page).getByRole('button', { name: 'Show Notes', exact: true }), touch);
        await editor(page).getByLabel('Notes', { exact: true }).fill('Changed private\nnotes'); await apply(page, touch);
        await edit(page, touch); await editor(page).getByLabel('Website', { exact: true }).fill('https://unsaved.example'); await apply(page, touch);
        if (limit) {
            await activateEntryAction(page, 'History', touch);
            const history = page.getByRole('dialog', { name: 'Entry history', exact: true });
            await history.getByRole('combobox', { name: 'Version', exact: true }).selectOption('0');
            await click(history.getByRole('button', { name: 'Restore version', exact: true }), touch);
            await click(history.getByRole('button', { name: 'Confirm restore', exact: true }), touch);
        }
        const discard = page.getByRole('button', { name: 'Discard unsaved entry changes…', exact: true });
        await activateEntryAction(page, 'Discard unsaved entry changes…', touch);
        const action = page.getByRole('dialog', { name: 'Discard unsaved entry changes', exact: true });
        await expect(action.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        await click(action.getByRole('button', { name: 'Cancel', exact: true }), touch); await expect(discard).toBeVisible();
        await activateEntryAction(page, 'Discard unsaved entry changes…', touch); await click(action.getByRole('button', { name: 'Discard entry changes', exact: true }), touch);
        await expect(page.getByRole('button', { name: 'Discard unsaved entry changes…', exact: true, includeHidden: true })).toHaveCount(0);
        await test.info().attach('discard-result', { body: await page.screenshot(), contentType: 'image/png' });
        if (!limit) {
            if (touch) await click(page.getByRole('button', { name: 'Back', exact: true }), touch);
            await click(page.getByRole('button', { name: 'New entry', exact: true }), touch);
            await editor(page).getByLabel('Title', { exact: true }).fill('Never saved child'); await apply(page, touch);
            await activateEntryAction(page, 'Discard unsaved entry changes…', touch);
            await expect(action).toContainText('Discarding removes it.');
            await click(action.getByRole('button', { name: 'Discard entry changes', exact: true }), touch);
            await expect(row(page, 'Never saved child')).toHaveCount(0);
        }
        await savedReopen(page, touch); const db = await download(page, touch), entry = all(db).find(item => item.uuid.id === source.id)!;
        if (!limit) { expect(all(db).some(item => item.fields.get('Title') === 'Never saved child')).toBe(false); expect(db.deletedObjects).toHaveLength(1); }
        fidelity(entry); expect(entry.fields.get('UserName')).toBe(''); expect(entry.fields.get('URL')).toBe(limit ? 'https://current.example' : '');
        expect(entry.history).toHaveLength(limit ? 1 : 0);
        expect(all(db).find(item => item.fields.get('Title') === 'alice 0')!.fields.get('URL')).toBe('https://sibling.example');
    });
});

// Browser contracts exercise cancellation/fallbacks on both engines; Chromium also reads its native rich clipboard.
test('formatted copy warns, escapes HTML, share cancellation is inert, and real drag exports plain text', async ({ page, browserName }) => {
    await open(page, await fixture(), false);
    await page.evaluate(() => {
        const state = { plain: '', html: '', writes: 0, shared: '' }; (window as any).fieldClipboard = state;
        Object.defineProperty(navigator, 'share', { configurable: true, value: async (value: ShareData) => { state.shared = value.text || ''; throw new DOMException('Canceled', 'AbortError'); } });
        if (navigator.clipboard.write) {
            const write = navigator.clipboard.write.bind(navigator.clipboard);
            navigator.clipboard.write = async items => {
                state.writes++; state.plain = await (await items[0].getType('text/plain')).text(); state.html = await (await items[0].getType('text/html')).text();
                if (/Chrome/.test(navigator.userAgent)) await write(items);
            };
        }
        const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async value => { state.writes++; state.plain = value; if (/Chrome/.test(navigator.userAgent)) await writeText(value); };
    });
    await activateEntryAction(page, 'Copy formatted entry…');
    const dialog = page.getByRole('dialog', { name: 'Copy formatted entry', exact: true });
    await expect(dialog).toContainText('including hidden secrets'); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await page.evaluate(() => (window as any).fieldClipboard.writes)).toBe(0);
    await activateEntryAction(page, 'Copy formatted entry…'); await dialog.getByRole('button', { name: 'Copy entry', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Entry copied.' })).toBeVisible();
    const clipboard = await page.evaluate(() => (window as any).fieldClipboard);
    expect(clipboard.plain).toContain('Password: secret<&>'); expect(clipboard.plain).toContain('Attachment: proof.bin');
    if (clipboard.html) { expect(clipboard.html).toContain('secret&lt;&amp;&gt;'); expect(clipboard.html).toContain('data:application/octet-stream;base64,AP+AAQ=='); }
    if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(clipboard.plain);
    await activateEntryAction(page, 'Share password…');
    await page.getByRole('dialog', { name: 'Share password', exact: true }).getByRole('button', { name: 'Share password', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Sharing canceled.' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).fieldClipboard.writes)).toBe(1);
    expect(await page.evaluate(() => (window as any).fieldClipboard.shared)).toBe('secret<&>');
    await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }));
    await activateEntryAction(page, 'Share password…');
    const fallback = page.getByRole('dialog', { name: 'Share password', exact: true });
    expect(await page.evaluate(() => (window as any).fieldClipboard.writes)).toBe(1);
    await fallback.getByRole('button', { name: 'Copy password instead', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Password copied.' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).fieldClipboard.plain)).toBe('secret<&>');
    expect(await page.evaluate(() => (window as any).fieldClipboard.writes)).toBe(2);
    await page.evaluate(() => {
        const target = document.createElement('textarea'); target.setAttribute('aria-label', 'External drop receiver');
        target.style.cssText = 'position:fixed;top:0;left:0;width:160px;height:60px;z-index:10000';
        target.addEventListener('dragover', event => event.preventDefault());
        target.addEventListener('drop', event => { event.preventDefault(); target.value = event.dataTransfer!.getData('text/plain'); });
        document.body.append(target);
    });
    await page.locator('[data-field="password"] .field__label').dragTo(page.getByRole('textbox', { name: 'External drop receiver', exact: true }));
    await expect(page.getByRole('textbox', { name: 'External drop receiver', exact: true })).toHaveValue('secret<&>');
    await expect(page.getByRole('button', { name: 'Discard unsaved entry changes…', exact: true, includeHidden: true })).toHaveCount(0);
});
