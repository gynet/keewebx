import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'disposable search password';
const timeout = 30_000;
const credentials = () => new kdbx.Credentials(kdbx.ProtectedValue.fromString(password));
const text = (value: unknown) => value instanceof kdbx.ProtectedValue ? value.getText() : value;
let source: Buffer;
let second: Buffer;
async function fixture(other = false) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(credentials(), other ? 'Second search' : 'Search fixture');
    const work = db.createGroup(db.groups[0], 'Work');
    const personal = db.createGroup(db.groups[0], 'Personal');
    const alpha = db.createEntry(work);
    alpha.fields.set('Title', 'ArchiveOnly');
    alpha.fields.set('Password', kdbx.ProtectedValue.fromString('historypassword'));
    alpha.fields.set('Notes', 'historynote');
    alpha.pushHistory();
    alpha.fields.set('Title', other ? 'Other vault item' : 'Alpha blue sky');
    alpha.fields.set('UserName', 'Casey');
    alpha.fields.set('URL', 'https://search.example/route');
    alpha.fields.set('Notes', 'ordinarynotes');
    alpha.fields.set('Password', kdbx.ProtectedValue.fromString('passwordneedle'));
    alpha.fields.set('Public', 'publicneedle');
    alpha.fields.set('Private', kdbx.ProtectedValue.fromString('customneedle'));
    alpha.fields.set('otp', 'otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&issuer=Test');
    alpha.bgColor = '#ff8888';
    alpha.tags = ['research'];
    alpha.binaries.set('proof.bin', await db.createBinary(new Uint8Array([1, 2, 255]).buffer));
    if (!other) {
        const beta = db.createEntry(personal);
        beta.fields.set('Title', 'Beta sky blue');
        beta.bgColor = '#8888ff';
        const shield = db.createEntry(work);
        shield.fields.set('Title', 'Shield');
        shield.fields.set('Notes', kdbx.ProtectedValue.fromString('noteneedle'));
        shield.fields.set('UserName', kdbx.ProtectedValue.fromString('userneedle'));
        const trash = db.createEntry(work);
        trash.fields.set('Title', 'Deleted search entry');
        trash.tags = ['research'];
        trash.bgColor = '#ff8888';
        db.remove(trash);
    }
    return Buffer.from(await db.save());
}
const rows = (page: Page) => page.locator('.entry-row');
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search', exact: true });
const options = (page: Page) => page.locator('.search-options');
const editor = (page: Page) => page.locator('.entry-editor');
async function open(page: Page, data = source, name = 'Search fixture.kdbx') {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: data });
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await expect(rows(page).first()).toBeVisible({ timeout });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}
async function showOptions(page: Page) {
    if (!await options(page).getAttribute('open').then(value => value !== null)) await options(page).locator('summary').first().click();
}
async function key(page: Page, command: string) { await page.keyboard.press(`Control+${command}`); }
async function unfocus(page: Page) { await page.locator('body').click({ position: { x: 1, y: 1 } }); }
async function find(page: Page, query: string) {
    await key(page, 'f');
    await expect(search(page)).toBeFocused();
    await search(page).fill(query);
}
async function titles(page: Page, expected: string[]) {
    await expect(rows(page).locator('.entry-row__title')).toHaveText(expected);
}
async function download(page: Page) {
    await unfocus(page);
    await key(page, ',');
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const output = await pending;
    expect(await output.failure()).toBeNull();
    const stream = await output.createReadStream();
    if (!stream) throw new Error('Missing encrypted export');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    await test.info().attach('keyboard-actual-export.kdbx', { body: bytes, contentType: 'application/octet-stream' });
    return { bytes, db: await kdbx.Kdbx.load(new Uint8Array(bytes).buffer, credentials()) };
}

test.beforeAll(async () => { source = await fixture(); second = await fixture(true); });
for (const width of [1280, 320]) {
    test.describe(`${width}px search and keyboard`, () => {
        test.use({ viewport: { width, height: 900 } });
        test('field scopes exclude secrets until explicit opt-in, including protected built-ins and OTP', async ({ page }) => {
            await open(page); await showOptions(page);
            for (const [label, query] of [['Title', 'Alpha'], ['Username', 'Casey'], ['Website', 'search.example'], ['Notes', 'ordinarynotes'], ['Other unprotected fields', 'publicneedle'], ['Tags and attachment names', 'proof.bin']]) {
                await search(page).fill(query); await titles(page, ['Alpha blue sky']);
                await options(page).getByLabel(label, { exact: true }).uncheck(); await titles(page, []);
                await options(page).getByLabel(label, { exact: true }).check(); await titles(page, ['Alpha blue sky']);
            }
            for (const query of ['passwordneedle', 'customneedle', 'noteneedle', 'userneedle', 'JBSWY3DPEHPK3PXP']) {
                await search(page).fill(query); await titles(page, []);
            }
            await search(page).fill('alpha RESEARCH proof.bin'); await titles(page, ['Alpha blue sky']);
            await options(page).getByLabel('Passwords', { exact: true }).check();
            await search(page).fill('passwordneedle'); await titles(page, ['Alpha blue sky']);
            await options(page).getByLabel('Passwords', { exact: true }).uncheck();
            await search(page).fill('passwordneedle'); await titles(page, []);
            await options(page).getByLabel('Protected fields and OTP', { exact: true }).check();
            for (const [query, title] of [['customneedle', 'Alpha blue sky'], ['noteneedle', 'Shield'], ['userneedle', 'Shield'], ['JBSWY3DPEHPK3PXP', 'Alpha blue sky']]) {
                await search(page).fill(query); await titles(page, [title]);
            }
            await search(page).fill('passwordneedle'); await titles(page, []);
            await page.screenshot({ path: test.info().outputPath('search-options.png') });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        });
        test('case, phrase, regex and historical matches use encrypted fields and identify the matching revision', async ({ page }) => {
            await open(page); await showOptions(page);
            await search(page).fill('sky blue'); await titles(page, ['Alpha blue sky', 'Beta sky blue']);
            await options(page).getByLabel('Exact phrase', { exact: true }).check(); await titles(page, ['Beta sky blue']);
            await search(page).fill('CASEY'); await titles(page, ['Alpha blue sky']);
            await options(page).getByLabel('Case sensitive', { exact: true }).check(); await titles(page, []);
            await options(page).getByLabel('Case sensitive', { exact: true }).uncheck();
            await options(page).getByLabel('Regular expression', { exact: true }).check();
            await search(page).fill('^(Alpha|Beta)'); await titles(page, ['Alpha blue sky', 'Beta sky blue']);
            await search(page).fill('['); await titles(page, []);
            await expect(page.getByRole('alert')).toContainText('Invalid regular expression');
            await options(page).getByLabel('Regular expression', { exact: true }).uncheck();
            await expect(page.getByRole('alert')).toHaveCount(0);
            await search(page).fill('ArchiveOnly'); await titles(page, []);
            await options(page).getByLabel('Search history', { exact: true }).check(); await titles(page, ['Alpha blue sky']);
            await expect(rows(page)).toContainText('Match in history');
            await rows(page).click();
            await page.getByRole('button', { name: 'History', exact: true }).click();
            const history = page.getByRole('dialog', { name: 'Entry history', exact: true });
            await expect(history.getByRole('combobox', { name: 'Version', exact: true }).locator('option:checked')).toContainText('search match');
            await expect(history.locator('[aria-label="History field: Title"]')).toContainText('ArchiveOnly');
            await history.getByRole('button', { name: 'Close History', exact: true }).click();
            await find(page, 'historypassword'); await titles(page, []);
            await options(page).getByLabel('Passwords', { exact: true }).check(); await titles(page, ['Alpha blue sky']);
            await options(page).getByLabel('Search history', { exact: true }).uncheck(); await titles(page, []);
        });
        test('combined vault/group/tag/color/trash filters reset visibly and create in the selected vault root', async ({ page }) => {
            await open(page); await unfocus(page); await key(page, 'o');
            const picker = page.getByRole('dialog', { name: 'Open another vault', exact: true });
            await picker.locator('#open-file-input').setInputFiles({ name: 'Second search.kdbx', mimeType: 'application/octet-stream', buffer: second });
            await picker.locator('#password').fill(password); await picker.locator('#unlock').click();
            await expect(picker).toHaveCount(0); await titles(page, ['Alpha blue sky', 'Beta sky blue', 'Other vault item', 'Shield']);
            await showOptions(page);
            await options(page).getByRole('combobox', { name: 'Search vault', exact: true }).selectOption({ label: 'Search fixture' });
            await options(page).getByRole('combobox', { name: 'Search tag', exact: true }).selectOption('research');
            await options(page).getByRole('combobox', { name: 'Search color', exact: true }).selectOption('red');
            const group = options(page).getByRole('combobox', { name: 'Search group', exact: true });
            await group.selectOption({ label: 'Search fixture / Search fixture / Work' });
            await titles(page, ['Alpha blue sky']); await search(page).fill('Alpha'); await titles(page, ['Alpha blue sky']);
            await search(page).fill(''); await options(page).getByLabel('Search trash', { exact: true }).check();
            await titles(page, ['Deleted search entry']); await expect(page.getByRole('button', { name: 'New entry', exact: true })).toBeDisabled();
            await expect(options(page).locator('summary').first()).toContainText('Filters active');
            await options(page).getByRole('button', { name: 'Reset search and filters', exact: true }).click();
            await titles(page, ['Alpha blue sky', 'Beta sky blue', 'Other vault item', 'Shield']);
            await options(page).getByRole('combobox', { name: 'Search vault', exact: true }).selectOption({ label: 'Second search' });
            await options(page).getByRole('combobox', { name: 'Search color', exact: true }).selectOption('red');
            await unfocus(page); await page.keyboard.press('Alt+n');
            await editor(page).getByLabel('Title', { exact: true }).fill('Created in second');
            await key(page, 's'); await expect(editor(page)).toHaveCount(0);
            await expect(page.locator('.detail__where')).toHaveText('Second search');
            await find(page, 'Created in second'); await options(page).getByRole('combobox', { name: 'Search vault', exact: true }).selectOption({ label: 'Search fixture' }); await titles(page, []);
            await options(page).getByRole('combobox', { name: 'Search vault', exact: true }).selectOption({ label: 'Second search' });
            await options(page).getByRole('combobox', { name: 'Search color', exact: true }).selectOption('red'); await titles(page, ['Created in second']);
        });
        test('keyboard search/list/navigation and modal commands use live visible focus', async ({ page }) => {
            await open(page); await unfocus(page); await page.keyboard.type('Al');
            await expect(search(page)).toBeFocused(); await expect(search(page)).toHaveValue('Al');
            await search(page).press('Escape'); await expect(search(page)).toHaveValue('');
            await search(page).press('ArrowDown'); await expect(page.locator('#entry-title')).toHaveText('Alpha blue sky');
            await page.keyboard.press('ArrowDown'); await expect(page.locator('#entry-title')).toHaveText('Beta sky blue');
            await page.keyboard.press('End'); await expect(page.locator('#entry-title')).toHaveText('Shield');
            await page.keyboard.press('Home'); await expect(page.locator('#entry-title')).toHaveText('Alpha blue sky');
            await key(page, 'f'); await expect(search(page)).toBeFocused();
            await unfocus(page); await key(page, 'g');
            const generator = page.getByRole('dialog', { name: 'Generate password', exact: true });
            await expect(generator).toBeVisible(); await expect(generator.getByLabel('Generated password', { exact: true })).not.toHaveValue('');
            await page.keyboard.press('Alt+n'); await key(page, 'f'); await key(page, 'o');
            await expect(editor(page)).toHaveCount(0); await expect(generator).toBeVisible();
            await page.keyboard.press('Escape'); await expect(generator).toHaveCount(0);
            await unfocus(page); await key(page, ','); await expect(page.getByRole('tab', { name: 'Appearance', exact: true })).toBeVisible();
            const original = await page.locator('#search').inputValue();
            await unfocus(page); await key(page, 'f'); await page.keyboard.press('Alt+n'); await page.keyboard.type('hidden');
            await expect(page.locator('#search')).toHaveValue(original); await expect(editor(page)).toHaveCount(0);
            await page.locator('#settings-back:visible, .settings__phone-back:visible').click();
            await unfocus(page); await page.keyboard.press('Alt+d'); await titles(page, ['Deleted search entry']);
            await page.keyboard.press('Alt+a'); await titles(page, ['Alpha blue sky', 'Beta sky blue', 'Shield']);
            await page.keyboard.press('Alt+c'); await titles(page, ['Alpha blue sky', 'Beta sky blue']);
            await key(page, 'o'); await expect(page.getByRole('dialog', { name: 'Open another vault', exact: true })).toBeVisible();
            await page.keyboard.press('Escape');
        });
        test('editor save/cancel/IME and multiline keys preserve encrypted data across independent reopen', async ({ page, browser }) => {
            await open(page); await rows(page).first().click(); await page.getByRole('button', { name: 'Edit', exact: true }).click();
            await editor(page).getByLabel('Title', { exact: true }).fill('Keyboard saved');
            await editor(page).getByLabel('Title', { exact: true }).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true });
            await expect(editor(page)).toBeVisible();
            const notes = editor(page).getByLabel('Notes', { exact: true });
            await notes.fill('first line'); await notes.press('End'); await notes.press('Enter'); await page.keyboard.type('second line');
            await expect(notes).toHaveValue('first line\nsecond line'); await notes.press('Tab'); await page.keyboard.press('Shift+Tab'); await expect(notes).toBeFocused();
            await key(page, 's'); await expect(editor(page)).toHaveCount(0); await expect(page.locator('#entry-title')).toHaveText('Keyboard saved');
            await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
            await page.getByRole('button', { name: 'Edit', exact: true }).click();
            await editor(page).getByLabel('Title', { exact: true }).fill('Canceled title');
            page.once('dialog', dialog => dialog.dismiss()); await page.keyboard.press('Escape'); await expect(editor(page)).toBeVisible();
            page.once('dialog', dialog => dialog.accept()); await page.keyboard.press('Escape'); await expect(editor(page)).toHaveCount(0);
            const exported = await download(page);
            const entry = exported.db.groups.flatMap(group => [...group.allEntries()]).find(entry => text(entry.fields.get('Title')) === 'Keyboard saved')!;
            expect(text(entry.fields.get('Notes'))).toBe('first line\nsecond line');
            expect(entry.fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
            expect(text(entry.fields.get('Password'))).toBe('passwordneedle');
            expect(text(entry.fields.get('Private'))).toBe('customneedle');
            expect(entry.history.some(item => text(item.fields.get('Title')) === 'ArchiveOnly')).toBe(true);
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            try {
                const reopened = await context.newPage(); await open(reopened, exported.bytes);
                await find(reopened, 'Keyboard saved'); await rows(reopened).click();
                await expect(reopened.locator('#entry-title')).toHaveText('Keyboard saved');
                await expect(reopened.locator('[data-field="password"] .field__value')).toContainText('•');
                await expect(reopened.locator('.entry-notes')).toContainText('second line');
                await key(reopened, 'l'); await expect(reopened.locator('.vault')).toHaveCount(0, { timeout });
                await key(reopened, 'g'); await key(reopened, 'f'); await reopened.keyboard.press('Alt+n');
                await expect(reopened.getByRole('dialog')).toHaveCount(0); await expect(editor(reopened)).toHaveCount(0);
            } finally { await context.close(); }
        });
        test('copy commands honor text selection and focused attachment deletion requires confirmation', async ({ page }) => {
            // Observe the browser clipboard boundary: Firefox does not expose native
            // clipboard read permissions in Playwright. No model methods are mocked.
            await page.addInitScript(() => {
                const writes: string[] = [];
                Object.defineProperty(window, 'clipboardWrites', { value: writes });
                Object.defineProperty(navigator.clipboard, 'writeText', { value: async (text: string) => { writes.push(text); } });
            });
            const writes = () => page.evaluate(() => (window as unknown as { clipboardWrites: string[] }).clipboardWrites);
            await open(page); await rows(page).first().click(); await unfocus(page);
            await key(page, 'c'); await expect.poll(writes).toEqual(['passwordneedle']);
            await key(page, 'b'); await expect.poll(writes).toEqual(['passwordneedle', 'Casey']);
            await key(page, 'u'); await expect.poll(writes).toEqual(['passwordneedle', 'Casey', 'https://search.example/route']);
            await page.keyboard.press('Alt+2'); await expect.poll(async () => (await writes())[3]).toMatch(/^\d{6}$/);
            await page.locator('#entry-title').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
            await key(page, 'c'); expect((await writes()).length).toBe(4);
            await page.evaluate(() => window.getSelection()?.removeAllRanges());
            const attachment = page.locator('[data-attachment="proof.bin"]');
            await attachment.getByRole('button', { name: 'Download', exact: true }).focus();
            page.once('dialog', dialog => dialog.dismiss()); await key(page, 'Delete'); await expect(attachment).toBeVisible();
            page.once('dialog', dialog => dialog.accept()); await key(page, 'Delete'); await expect(attachment).toHaveCount(0);
            await page.getByRole('button', { name: 'Edit', exact: true }).click(); await editor(page).getByLabel('Username', { exact: true }).focus();
            await key(page, 'c'); expect((await writes()).length).toBe(4);
        });
    });
}

test('invalid save retains drafts and recovery refuses all hidden workspace shortcuts', async ({ page }) => {
    await open(page); await rows(page).first().click(); await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Add field', exact: true }).click();
    await editor(page).getByLabel('Field name', { exact: true }).last().fill('Title');
    await key(page, 's'); await expect(editor(page).getByRole('alert')).toContainText('unique names');
    await expect(page.locator('.command-status')).toContainText('Could not save');
    await key(page, 'l');
    await expect(page.getByRole('heading', { name: 'Verify to recover editing', exact: true })).toBeVisible({ timeout });
    const baseline = await editor(page).getByLabel('Title', { exact: true }).inputValue();
    for (const command of ['f', 'o', 's', 'l', 'g', ',', 'c', 'b', 'u']) await key(page, command);
    await page.keyboard.press('Alt+n'); await page.keyboard.press('ArrowDown'); await page.keyboard.type('hidden');
    await expect(editor(page)).toBeHidden(); await expect(editor(page).getByLabel('Title', { exact: true })).toHaveValue(baseline);
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('searchbox')).toHaveCount(0);
});

test('failed local save retains applied edits and succeeds after storage becomes available', async ({ page }) => {
    await open(page); await rows(page).first().click();
    await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
            if (this.name === 'files') throw new DOMException('Storage unavailable', 'QuotaExceededError');
            return put.apply(this, args);
        };
        window.addEventListener('restore-test-storage', () => { IDBObjectStore.prototype.put = put; }, { once: true });
    });
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByLabel('Title', { exact: true }).fill('Retained after save error');
    await key(page, 's'); await expect(page.locator('.command-status')).toContainText('Could not save', { timeout });
    await expect(page.locator('#entry-title')).toHaveText('Retained after save error');
    await page.evaluate(() => window.dispatchEvent(new Event('restore-test-storage')));
    await key(page, 's'); await expect(page.locator('.command-status')).toContainText('Saved.', { timeout });
    await key(page, 'l'); await expect(page.locator('.vault')).toHaveCount(0, { timeout });
    await page.reload();
    await page.locator('.vault-row[data-vault="Search fixture"]').click();
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(rows(page).filter({ hasText: 'Retained after save error' })).toBeVisible({ timeout });
});

test('Command modifier follows Mac platform and Ctrl does not activate vault commands', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { value: 'MacIntel' }));
    await open(page); await unfocus(page); await page.keyboard.press('Meta+f'); await expect(search(page)).toBeFocused();
    await search(page).fill('Alpha'); await titles(page, ['Alpha blue sky']);
    await unfocus(page); await key(page, 'g'); await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.keyboard.press('Meta+g'); await expect(page.getByRole('dialog', { name: 'Generate password', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await unfocus(page); await page.keyboard.press('Meta+l');
    await expect(page.locator('.vault')).toHaveCount(0, { timeout });
});

test('Chromium password shortcut reaches the native clipboard', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Playwright Firefox does not support clipboard-read permissions; portable clipboard-boundary coverage runs above.');
    await open(page); await rows(page).first().click(); await unfocus(page); await key(page, 'c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('passwordneedle');
});

test('open shortcut on the locked start screen uses the visible local-file workflow', async ({ page }) => {
    await page.goto('/next.html'); await unfocus(page);
    const chooser = page.waitForEvent('filechooser');
    await key(page, 'o');
    await (await chooser).setFiles({ name: 'Search fixture.kdbx', mimeType: 'application/octet-stream', buffer: source });
    await expect(page.locator('#password')).toBeVisible();
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(rows(page)).toHaveCount(3, { timeout });
});

test('short 320px screen keeps search controls and filtered results reachable', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await open(page); await showOptions(page);
    await options(page).getByLabel('Passwords', { exact: true }).check();
    await search(page).fill('passwordneedle'); await titles(page, ['Alpha blue sky']);
    await rows(page).click(); await expect(page.locator('#entry-title')).toBeVisible();
    await find(page, 'research');
    await options(page).getByRole('combobox', { name: 'Search color', exact: true }).selectOption('red');
    await titles(page, ['Alpha blue sky']); await rows(page).click();
    await expect(page.locator('#entry-title')).toHaveText('Alpha blue sky');
    await find(page, ''); await options(page).getByRole('button', { name: 'Reset search and filters', exact: true }).click();
    await titles(page, ['Alpha blue sky', 'Beta sky blue', 'Shield']);
    await options(page).locator('summary').first().click();
    await expect(page.getByRole('button', { name: 'Save vaults', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Password generator', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('short-search.png') });
});

test('filter and search focus changes require consent before discarding an inline draft', async ({ page }) => {
    await open(page); await showOptions(page); await rows(page).first().click();
    await page.getByRole('button', { name: 'Edit notes', exact: true }).click();
    await page.locator('.notes__editor').fill('retain this inline draft');
    page.once('dialog', dialog => dialog.dismiss());
    await options(page).getByLabel('Passwords', { exact: true }).click();
    await expect(options(page).getByLabel('Passwords', { exact: true })).not.toBeChecked();
    await expect(page.locator('.notes__editor')).toHaveValue('retain this inline draft');
    await page.locator('.notes__editor').focus();
    page.once('dialog', dialog => dialog.dismiss()); await key(page, 'f');
    await expect(page.locator('.notes__editor')).toBeFocused();
    page.once('dialog', dialog => dialog.accept()); await key(page, 'f');
    await expect(search(page)).toBeFocused(); await expect(page.locator('.notes__editor')).toHaveCount(0);
    await search(page).fill('Alpha'); await rows(page).click();
    await expect(page.locator('.entry-notes')).toContainText('ordinarynotes');
});
