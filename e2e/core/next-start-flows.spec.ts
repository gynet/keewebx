import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';
test.use({ serviceWorkers: 'block' });
const password = 'disposable startup password';
let data: Buffer;
let key: Buffer;
let plain: Buffer;
const timeout = 30_000;
type Payload = { name: string; bytes: Buffer };
async function drop(page: Page, files: Payload[]) {
    const transfer = await page.evaluateHandle(files => {
        const result = new DataTransfer();
        for (const file of files) result.items.add(new File([Uint8Array.from(atob(file.data), ch => ch.charCodeAt(0))], file.name));
        return result;
    }, files.map(file => ({ name: file.name, data: file.bytes.toString('base64') })));
    try { await page.locator('.start').dispatchEvent('drop', { dataTransfer: transfer }); }
    finally { await transfer.dispose(); }
}
async function unlock(page: Page) {
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').filter({ hasText: 'Startup secret' })).toBeVisible({ timeout });
}
async function config(page: Page, settings: Record<string, unknown>, rest = {}) {
    await page.route(url => url.pathname === '/startup-config.json', route => route.fulfill({ json: { settings, ...rest } }));
}
test.beforeAll(async () => {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    key = Buffer.from(await kdbx.Credentials.createRandomKeyFile(2));
    const make = async (withKey: boolean) => {
        const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), withKey ? key : undefined), 'Startup');
        const entry = db.createEntry(db.groups[0]); entry.fields.set('Title', 'Startup secret');
        entry.fields.set('Password', kdbx.ProtectedValue.fromString('preserved startup secret'));
        entry.fields.set('Notes', 'history marker'); entry.pushHistory(); entry.fields.set('Notes', 'current notes');
        return Buffer.from(await db.save());
    };
    data = await make(true); plain = await make(false);
});
for (const width of [1280, 320]) test.describe(`${width}px startup`, () => {
    test.use({ viewport: { width, height: 800 } });
    test('database/key pair drop opens actual encrypted data, removal fails safely and picker remains equivalent', async ({ page, browser }) => {
        await page.goto('/next.html');
        await drop(page, [{ name: 'paired.keyx', bytes: key }, { name: 'Paired.KDBX', bytes: data }]);
        await expect(page.getByRole('button', { name: 'Key file: paired.keyx', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Remove key file', exact: true }).click();
        await page.locator('#password').fill(password); await page.locator('#unlock').click();
        await expect(page.locator('#unlock-error')).toContainText('Wrong password', { timeout });
        await page.locator('#unlock-key-file').setInputFiles({ name: 'paired.keyx', mimeType: 'application/octet-stream', buffer: key });
        await page.screenshot({ path: test.info().outputPath('paired-start.png') });
        await unlock(page);
        await page.locator('.entry-row').click();
        await expect(page.locator('[data-field="password"] .field__value')).toContainText('•');
        const context = await browser.newContext({ viewport: { width, height: 800 } });
        try {
            const fresh = await context.newPage(); await fresh.goto('/next.html');
            await fresh.locator('#open-file-input').setInputFiles({ name: 'Paired.kdbx', mimeType: 'application/octet-stream', buffer: data });
            await fresh.locator('#unlock-key-file').setInputFiles({ name: 'paired.keyx', mimeType: 'application/octet-stream', buffer: key });
            await unlock(fresh);
        } finally { await context.close(); }
        const independent = await kdbx.Kdbx.load(new Uint8Array(data).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key));
        expect(independent.groups[0].entries[0].history).toHaveLength(1);
        expect(independent.groups[0].entries[0].fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
    });
    test('ambiguous and unreadable drops retain the prior selection and retry the complete pair', async ({ page }) => {
        await page.goto('/next.html'); await drop(page, [{ name: 'Prior.kdbx', bytes: plain }]);
        await expect(page.locator('.card__title')).toHaveText('Prior.kdbx');
        await drop(page, [{ name: 'A.kdbx', bytes: plain }, { name: 'B.kdbx', bytes: data }]);
        await expect(page.locator('#open-file-error')).toContainText('exactly one');
        await expect(page.locator('.card__title')).toHaveText('Prior.kdbx');
        await page.evaluate(() => {
            const read = File.prototype.arrayBuffer; let failed = false;
            File.prototype.arrayBuffer = function () {
                if (this.name === 'fail.key' && !failed) { failed = true; return Promise.reject(new Error('File read unavailable')); }
                return read.call(this);
            };
        });
        await drop(page, [{ name: 'Pair.kdbx', bytes: data }, { name: 'fail.key', bytes: key }]);
        await expect(page.locator('#open-file-error')).toContainText('Unable to read');
        await expect(page.locator('.card__title')).toHaveText('Prior.kdbx');
        await page.getByRole('button', { name: 'Retry reading file', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Key file: fail.key', exact: true })).toBeVisible();
        await unlock(page);
    });
    test('recent vault keyboard selection clears credentials and Caps Lock uses browser modifier state', async ({ page }) => {
        await page.goto('/next.html');
        for (const name of ['First.kdbx', 'Second.kdbx']) {
            await drop(page, [{ name, bytes: plain }]); await unlock(page);
            await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
            await page.keyboard.press('Control+l'); await expect(page.locator('#password')).toBeVisible();
        }
        const rows = page.locator('.vault-row[data-vault]');
        await expect(rows).toHaveCount(2);
        await page.locator('#password').fill('discarded selection password');
        await rows.first().focus(); await page.keyboard.press('End'); await expect(rows.last()).toBeFocused();
        await page.keyboard.press('Home'); await expect(rows.first()).toBeFocused();
        await page.keyboard.press('ArrowDown'); await expect(rows.last()).toBeFocused();
        await page.keyboard.press('Enter'); await expect(page.locator('.card__title')).toHaveText('First.kdbx');
        await expect(page.locator('#password')).toHaveValue('');
        await expect(page.locator('#password')).toHaveAttribute('type', 'password');
        await page.locator('#password').focus();
        // Playwright has no portable physical Caps Lock toggle; exercise the browser-reported modifier boundary.
        await page.locator('#password').dispatchEvent('keydown', { key: 'A', modifierCapsLock: true });
        await expect(page.locator('#unlock-caps-lock')).toHaveText('Caps Lock is on');
        await page.locator('#password').dispatchEvent('keyup', { key: 'CapsLock', modifierCapsLock: false });
        await expect(page.locator('#unlock-caps-lock')).toHaveCount(0);
        await page.locator('#password').dispatchEvent('keydown', { key: 'A', modifierCapsLock: true });
        await page.locator('#unlock').focus(); await expect(page.locator('#unlock-caps-lock')).toHaveCount(0);
        await expect(rows).toHaveCount(2); await unlock(page);
    });
    test('fragment links prefill a remote form without fetching; demo is consumed once and obeys policy', async ({ page }) => {
        let remoteReads = 0;
        await page.route('https://cloud.example/vault.kdbx', route => { remoteReads++; return route.abort(); });
        await page.goto('/next.html#open=' + encodeURIComponent('https://cloud.example/vault.kdbx'));
        await expect(page.locator('#webdav-url')).toHaveValue('https://cloud.example/vault.kdbx');
        await expect(page.locator('#webdav-user')).toHaveValue(''); await expect(page.locator('#webdav-pass')).toHaveValue('');
        expect(remoteReads).toBe(0); expect(page.url()).not.toContain('#');
        await page.goto('about:blank');
        await page.goto('/next.html#open=' + encodeURIComponent('https://user:secret@cloud.example/vault.kdbx'));
        await expect(page.locator('#open-file-error')).toContainText('without embedded credentials');
        expect(page.url()).not.toContain('secret'); expect(remoteReads).toBe(0);
        await page.goto('/next.html?demo=1'); await expect(page.locator('.entry-row')).toHaveCount(21, { timeout });
        await page.keyboard.press('Control+l'); await expect(page.locator('#open-demo')).toBeVisible({ timeout });
        await expect(page.locator('.entry-row')).toHaveCount(0); expect(page.url()).not.toContain('demo=');
        await config(page, { canOpenDemo: false });
        await page.goto('/next.html?config=/startup-config.json#demo');
        await expect(page.locator('#open-file-error')).toContainText('demo is disabled');
        await expect(page.locator('.entry-row')).toHaveCount(0);
    });
});

test('configured restrictions load before controls and preserve permitted local cached unlock', async ({ page }) => {
    await page.goto('/next.html'); await drop(page, [{ name: 'Cached.kdbx', bytes: plain }]); await unlock(page);
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await page.keyboard.press('Control+l'); await expect(page.locator('.entry-row')).toHaveCount(0, { timeout });
    await config(page, { canOpen: false, canOpenStorage: false, canOpenDemo: false, canCreate: false, canImportCsv: false, canImportXml: false, canOpenGenerator: false, canOpenSettings: false });
    await page.goto('/next.html?config=%2Fstartup-config.json');
    for (const id of ['open-file', 'open-webdav', 'open-demo', 'create-vault']) await expect(page.locator('#' + id)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Password generator', exact: true })).toHaveCount(0);
    await drop(page, [{ name: 'Denied.kdbx', bytes: plain }]); await expect(page.locator('#open-file-error')).toContainText('disabled');
    await unlock(page); await expect(page.locator('.entry-row')).toHaveCount(1);
});

test('same-origin config selects a preset connection, malformed/external config fails closed, frame policy is applied', async ({ page }) => {
    await config(page, { canOpen: false, allowIframes: false }, { files: [{ storage: 'webdav', name: 'Configured vault', path: 'https://cloud.example/preset.kdbx' }], showOnlyFilesFromConfig: true });
    await page.goto('/next.html?config=/startup-config.json');
    await expect(page.locator('.card__title')).toHaveText('Configured vault.kdbx');
    await page.route(url => url.pathname === '/bad-config.json', route => route.fulfill({ status: 503, json: { settings: { canOpen: true } } }));
    await page.goto('/next.html?config=/bad-config.json'); await expect(page.getByRole('heading', { name: 'Unable to open the vault', exact: true })).toBeVisible();
    await expect(page.locator('.start')).toHaveCount(0);
    let external = 0; await page.route('https://other.example/**', route => { external++; return route.abort(); });
    await page.goto('/next.html?config=' + encodeURIComponent('https://other.example/config.json'));
    await expect(page.getByRole('heading', { name: 'Unable to open the vault', exact: true })).toBeVisible(); expect(external).toBe(0);
    await page.route('**/frame.html', route => route.fulfill({ contentType: 'text/html', body: '<iframe src="/next.html?config=/startup-config.json"></iframe>' }));
    await page.goto('/frame.html'); await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Unable to open the vault', exact: true })).toBeVisible();
    await page.unroute(url => url.pathname === '/startup-config.json'); await config(page, { allowIframes: true, canOpen: false });
    await page.reload(); await expect(page.frameLocator('iframe').locator('.start')).toBeVisible();
});

test('CSV drop reaches the existing import preview and policy rejects disabled formats', async ({ page }) => {
    await page.goto('/next.html');
    await drop(page, [{ name: 'accounts.csv', bytes: Buffer.from('Title,UserName,Password\nImported startup,user,secret\n') }]);
    await expect(page.getByRole('form', { name: 'Import preview', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'CSV rows', exact: true })).toHaveCount(0);
    await config(page, { canImportCsv: false }); await page.goto('/next.html?config=/startup-config.json');
    await drop(page, [{ name: 'accounts.csv', bytes: Buffer.from('Title,Password\nDenied,secret') }]);
    await expect(page.locator('#open-file-error')).toContainText('disabled'); await expect(page.getByRole('form', { name: 'Import preview', exact: true })).toHaveCount(0);
});

test('late file-read completion cannot replace a newer selection', async ({ page }) => {
    await page.goto('/next.html');
    await page.evaluate(() => {
        const read = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = async function () {
            if (this.name === 'late.kdbx') await new Promise<void>(resolve => window.addEventListener('release-late-read', () => resolve(), { once: true }));
            return read.call(this);
        };
    });
    await drop(page, [{ name: 'late.kdbx', bytes: data }, { name: 'late.keyx', bytes: key }]);
    await expect(page.getByRole('status')).toContainText('Reading file');
    await drop(page, [{ name: 'Current.kdbx', bytes: plain }]);
    await expect(page.locator('.card__title')).toHaveText('Current.kdbx');
    await page.evaluate(() => window.dispatchEvent(new Event('release-late-read')));
    await expect(page.getByRole('button', { name: 'Use a key file', exact: true })).toBeVisible();
    await unlock(page);
});

test('malformed config cannot enable its own cache fallback or persist partial restrictions', async ({ page }) => {
    await page.route(url => url.pathname === '/malformed-config.json', route => route.fulfill({ json: { settings: { canOpen: false, cacheConfigSettings: true }, files: {} } }));
    await page.goto('/next.html?config=/malformed-config.json');
    await expect(page.getByRole('heading', { name: 'Unable to open the vault', exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.appSettings || '{}').cacheConfigSettings)).not.toBe(true);
    await page.goto('/next.html'); await expect(page.locator('#open-file')).toBeVisible();
});
