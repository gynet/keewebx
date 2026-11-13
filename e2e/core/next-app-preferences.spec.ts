import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'Disposable preferences master';
const strong = 'Synthet!cLongSecretForChecks42';
const timeout = 30_000;
async function fixture() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Preferences');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const customIcon = kdbx.KdbxUuid.random();
    db.meta.customIcons.set(customIcon.id, { data: new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64')).buffer });
    const group = db.createGroup(db.groups[0], 'Parent'); group.icon = 61;
    const child = db.createGroup(group, 'Child');
    for (const [title, secret, target] of [['Strong record', strong, group], ['Weak record', 'abc', group], ['PIN record', '1234', child]] as const) {
        const entry = db.createEntry(target);
        if (title === 'Strong record') entry.customIcon = customIcon;
        entry.fields.set('Title', title); entry.fields.set('Password', kdbx.ProtectedValue.fromString(secret));
        entry.fields.set('URL', 'https://example.com'); entry.tags = ['Synthetic tag'];
        entry.times.lastModTime = new Date('2010-01-01');
    }
    return { name: 'preferences.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) };
}
async function unlock(page: Page) {
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}
async function open(page: Page) {
    await page.goto('/next.html'); await page.locator('#open-file-input').setInputFiles(await fixture()); await unlock(page);
}
async function browse(page: Page) {
    const menu = page.getByRole('button', { name: 'Show menu', exact: true });
    if (await menu.isVisible()) await menu.click();
    if (!await page.getByRole('navigation', { name: 'Vault', exact: true }).isVisible())
        await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
}
async function settings(page: Page, section = 'Appearance') {
    await browse(page); await page.locator('#open-settings').click();
    await page.getByRole('tab', { name: section, exact: true }).click();
}
async function back(page: Page) { await page.locator('#settings-back:visible, .settings__phone-back:visible').click(); }
async function reload(page: Page) {
    await back(page); await browse(page); await page.locator('#lock').click();
    await expect(page.locator('#password')).toBeVisible({ timeout }); await page.reload(); await unlock(page);
}
async function stored(page: Page, name: string) {
    return page.evaluate(name => JSON.parse(localStorage.getItem('appSettings') || '{}')[name], name);
}
async function selectEntry(page: Page, title: string) {
    const close = page.getByRole('button', { name: 'Close navigation', exact: true });
    if (await close.isVisible()) await close.click();
    await page.locator(`.entry-row[data-entry="${title}"]`).click();
}
test('per-entry audit exclusion persists in encrypted storage and can be resumed', async ({ page }) => {
    await open(page); await selectEntry(page, 'Weak record');
    await expect(page.locator('.password-audit')).toHaveText('This password is weak.');
    await page.getByRole('button', { name: 'Ignore password issues for this entry', exact: true }).click();
    await expect(page.locator('.password-audit')).toHaveCount(0);
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await settings(page, 'Database');
    const exported = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const chunks: Buffer[] = [], stream = await (await exported).createReadStream();
    if (!stream) throw new Error('Missing encrypted download');
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const db = await kdbx.Kdbx.load(new Uint8Array(Buffer.concat(chunks)).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
    const entry = [...db.groups[0].allEntries()].find(entry => entry.fields.get('Title') === 'Weak record')!;
    expect(entry.customData?.get('IgnorePwIssues')?.value).toBe('1');
    expect(entry.history.some(revision => !revision.customData?.has('IgnorePwIssues'))).toBe(true);
    await reload(page); await selectEntry(page, 'Weak record');
    await expect(page.locator('.password-audit')).toHaveCount(0);
    await page.getByRole('button', { name: 'Resume password checks for this entry', exact: true }).click();
    await expect(page.locator('.password-audit')).toHaveText('This password is weak.');
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await settings(page); await reload(page); await selectEntry(page, 'Weak record');
    await expect(page.locator('.password-audit')).toHaveText('This password is weak.');
});
for (const width of [1280, 390]) {
    test(`preferences persist and subgroup/icon/tag rendering follows them at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 }); await open(page);
        await browse(page); await page.getByRole('button', { name: 'Parent', exact: true }).click();
        await expect(page.locator('.entry-row')).toHaveCount(3);
        await settings(page);
        await page.getByLabel('Include entries from subgroups', { exact: true }).uncheck();
        await page.getByRole('combobox', { name: 'Text size', exact: true }).selectOption('2');
        await page.getByLabel('Large list icons', { exact: true }).check();
        await page.getByLabel('Colorful custom icons', { exact: true }).uncheck();
        await page.getByRole('combobox', { name: 'Tag style', exact: true }).selectOption('dot');
        await page.getByLabel('Use group icon for new entries', { exact: true }).check();
        await page.screenshot({ path: test.info().outputPath(`appearance-${width}.png`), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await back(page); await expect(page.locator('.entry-row')).toHaveCount(2);
        await expect(page.locator('.entry-row .tile').first()).toHaveCSS('width', '54px');
        await expect(page.locator('[data-entry="Strong record"] .tile img')).toHaveCSS('filter', 'grayscale(1)');
        await expect(page.locator('.entry-row__title').first()).toHaveCSS('font-size', '17.36px');
        await browse(page); await expect(page.locator('.tags')).toHaveClass(/tags--dots/);
        await settings(page); await reload(page); await settings(page);
        await expect(page.getByLabel('Include entries from subgroups', { exact: true })).not.toBeChecked();
        await expect(page.getByRole('combobox', { name: 'Text size', exact: true })).toHaveValue('2');
        await expect(page.getByLabel('Large list icons', { exact: true })).toBeChecked();
        await expect(page.getByLabel('Use group icon for new entries', { exact: true })).toBeChecked();
        await expect(page.locator('html')).toHaveAttribute('data-text-size', '2');
        await page.getByLabel('Include entries from subgroups', { exact: true }).check();
        await back(page); await browse(page); await page.getByRole('button', { name: 'Parent', exact: true }).click();
        await expect(page.locator('.entry-row')).toHaveCount(3);
        await page.getByRole('button', { name: 'New entry', exact: true }).click();
        await page.locator('.entry-editor').getByLabel('Title', { exact: true }).fill('Inherited icon');
        await page.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
        await settings(page, 'Database');
        const waiting = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
        const stream = await (await waiting).createReadStream(); const chunks: Buffer[] = [];
        if (!stream) throw new Error('Missing exported vault');
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const reopened = await kdbx.Kdbx.load(new Uint8Array(Buffer.concat(chunks)).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
        expect([...reopened.groups[0].allEntries()].find(entry => entry.fields.get('Title') === 'Inherited icon')?.icon).toBe(61);
    });
    test(`audit rules and explicit HIBP consent govern findings at ${width}px`, async ({ page, context }) => {
        await page.setViewportSize({ width, height: 900 });
        const requests: string[] = [];
        const hash = createHash('sha1').update(strong).digest('hex').toUpperCase();
        await page.route('https://api.pwnedpasswords.com/range/*', async route => {
            requests.push(route.request().url());
            await route.fulfill({ body: `${hash.slice(5)}:12\r\n${'0'.repeat(35)}:0`, contentType: 'text/plain' });
        });
        await open(page); await selectEntry(page, 'Weak record');
        await expect(page.locator('.password-audit')).toHaveText('This password is weak.');
        await settings(page, 'Security'); await page.getByLabel('Warn about weak passwords', { exact: true }).uncheck();
        await back(page); await expect(page.locator('.password-audit')).toHaveCount(0);
        await settings(page, 'Security'); await page.getByLabel('Warn about weak passwords', { exact: true }).check(); await back(page);
        if (width < 760) await page.getByRole('button', { name: 'Back', exact: true }).click();
        await selectEntry(page, 'PIN record'); await expect(page.locator('.password-audit')).toHaveCount(0);
        await settings(page, 'Security'); await page.getByLabel('Exclude PINs of up to six digits', { exact: true }).uncheck(); await back(page);
        await expect(page.locator('.password-audit')).toHaveText('This password is weak.');
        if (width < 760) await page.getByRole('button', { name: 'Back', exact: true }).click();
        await selectEntry(page, 'Strong record'); expect(requests).toHaveLength(0);
        await settings(page, 'Security');
        const consent = page.getByLabel('Check Have I Been Pwned', { exact: true }); await expect(consent).not.toBeChecked();
        await page.getByText('How online password checks work', { exact: true }).click();
        await context.route('https://haveibeenpwned.com/**', route => route.fulfill({ body: 'Privacy information' }));
        const popup = page.waitForEvent('popup'); await page.getByRole('link', { name: 'Have I Been Pwned privacy information', exact: true }).click();
        await (await popup).close(); await expect(consent).not.toBeChecked(); expect(requests).toHaveLength(0);
        await page.getByRole('combobox', { name: 'Warn about password age', exact: true }).selectOption('1'); await back(page);
        await expect(page.locator('.password-audit')).toHaveText('This password is older than your chosen limit.');
        await settings(page, 'Security'); await page.getByRole('combobox', { name: 'Warn about password age', exact: true }).selectOption('0');
        await consent.check(); await back(page);
        await expect(page.locator('.password-audit')).toHaveText('This password appears in known breaches.');
        expect(requests).toEqual([`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`]);
        await settings(page, 'Security'); await page.getByLabel('Check passwords for issues', { exact: true }).uncheck(); await back(page);
        await expect(page.locator('.password-audit')).toHaveCount(0);
        await settings(page, 'Security'); await reload(page); await settings(page, 'Security');
        await expect(page.getByLabel('Check passwords for issues', { exact: true })).not.toBeChecked();
        await expect(page.getByLabel('Check Have I Been Pwned', { exact: true })).toBeChecked();
        expect(requests).toHaveLength(1);
    });
}

test('all idle choices round-trip and interaction in settings resets idle locking', async ({ page }) => {
    await page.clock.install();
    await open(page); await settings(page, 'Security');
    const options = ['0', '5', '10', '15', '30', '60', '180', '360', '720', '1440'];
    expect(await page.locator('#setting-auto-lock option').evaluateAll(options => options.map(o => (o as HTMLOptionElement).value))).toEqual(options);
    for (const value of options) {
        await page.locator('#setting-auto-lock').selectOption(value);
        await reload(page); await settings(page, 'Security');
        await expect(page.locator('#setting-auto-lock')).toHaveValue(value);
    }
    await page.locator('#setting-auto-lock').selectOption('5');
    await page.clock.fastForward(4 * 60_000);
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await page.clock.fastForward(2 * 60_000); await expect(page.locator('#settings-panel-appearance')).toBeVisible();
    await page.clock.fastForward(5 * 60_000); await expect(page.locator('#password')).toBeVisible({ timeout });
});

test('provider and save preferences persist; disabled WebDAV disappears after reload', async ({ page }) => {
    await page.goto('/next.html'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Saving and content', exact: true }).click();
    await page.getByLabel('Verify saves', { exact: true }).uncheck();
    await page.getByLabel('Do not retain provider sessions', { exact: true }).check();
    await page.locator('#provider-setting-webdav-webdavSaveMethod').selectOption('put');
    await page.locator('#provider-setting-webdav-webdavStatReload').check();
    await page.locator('#provider-webdav').uncheck();
    await page.reload(); await expect(page.locator('#open-webdav')).toBeHidden();
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Saving and content', exact: true }).click();
    await expect(page.getByLabel('Verify saves', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel('Do not retain provider sessions', { exact: true })).toBeChecked();
    await page.locator('#provider-webdav').check();
    await expect(page.locator('#provider-setting-webdav-webdavSaveMethod')).toHaveValue('put');
    await expect(page.locator('#provider-setting-webdav-webdavStatReload')).toBeChecked();
    await page.getByLabel('Verify saves', { exact: true }).check();
    await back(page); await expect(page.locator('#open-webdav')).toBeVisible();
    expect(await stored(page, 'saveVerify')).toBeUndefined(); // enabled is the persisted default
});

test('host restrictions hide entry points and reject synthetic input and stale button dispatch', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('appSettings', JSON.stringify({
        canOpen: false, canCreate: false, canOpenDemo: false, canOpenStorage: false, canOpenSettings: false
    })));
    await page.goto('/next.html');
    for (const id of ['open-file', 'create-vault', 'open-demo', 'open-webdav']) await expect(page.locator(`#${id}`)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
    await page.locator('#open-file-input').setInputFiles(await fixture());
    await page.locator('#open-demo').evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('#open-webdav').evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator('#password')).toHaveCount(0); await expect(page.locator('#webdav-url')).toHaveCount(0);
    await expect(page.locator('.entry-row')).toHaveCount(0);
});

test('host export restriction denies hidden download dispatch while ordinary saving works', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('appSettings', JSON.stringify({ canSaveTo: false })));
    await open(page); await settings(page, 'Database');
    const download = page.getByRole('button', { name: 'Download KDBX', exact: true, includeHidden: true });
    await expect(download).toBeHidden(); let downloads = 0; page.on('download', () => downloads++);
    await download.evaluate((button: HTMLButtonElement) => button.click());
    await page.getByRole('button', { name: 'Save database settings', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved in browser storage', { timeout });
    expect(downloads).toBe(0);
});

test('verify saves control changes the actual save path and re-enabling catches decrypt failures', async ({ page }) => {
    await open(page); await settings(page, 'Saving and content');
    await page.locator('#setting-auto-save').selectOption('0');
    await page.getByLabel('Verify saves', { exact: true }).uncheck();
    await page.evaluate(() => {
        const original = SubtleCrypto.prototype.decrypt;
        const state = { calls: 0, restore: () => { SubtleCrypto.prototype.decrypt = original; } };
        (window as any).__preferenceVerification = state;
        SubtleCrypto.prototype.decrypt = async function (...args) {
            if ((typeof args[0] === 'string' ? args[0] : args[0].name) === 'AES-CBC') {
                state.calls++; throw new DOMException('Synthetic verification failure', 'OperationError');
            }
            return original.apply(this, args);
        };
    });
    const edit = async (name: string) => {
        await back(page); await selectEntry(page, name === 'First saved title' ? 'Strong record' : 'First saved title');
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('.entry-editor').getByLabel('Title', { exact: true }).fill(name);
        await page.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
        await settings(page, 'Saving and content'); await page.getByRole('button', { name: 'Save now', exact: true }).click();
    };
    await edit('First saved title');
    await expect(page.getByRole('region', { name: 'Saving and content', exact: true }).getByRole('status')).toContainText('saved in this browser', { timeout });
    expect(await page.evaluate(() => (window as any).__preferenceVerification.calls)).toBe(0);
    await page.getByLabel('Verify saves', { exact: true }).check(); await edit('Second saved title');
    await expect(page.getByRole('alert', { name: 'Save verification failed', exact: true })).toBeVisible({ timeout });
    expect(await page.evaluate(() => (window as any).__preferenceVerification.calls)).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).__preferenceVerification.restore());
    await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await expect(page.getByRole('alert', { name: 'Save verification failed', exact: true })).toHaveCount(0, { timeout });
});

test('website icons are opt-in, custom icons take priority, failed images fall back', async ({ page }) => {
    const requests: string[] = [];
    await page.route('https://icons.duckduckgo.com/**', async route => {
        requests.push(route.request().url()); await route.fulfill({ status: 404, body: '' });
    });
    await open(page); expect(requests).toHaveLength(0);
    await settings(page); await page.getByLabel('Show website icons', { exact: true }).check(); await back(page);
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    await expect(page.locator('[data-entry="Weak record"] .tile svg')).toBeVisible();
    await expect(page.locator('[data-entry="Strong record"] .tile img')).toHaveAttribute('src', /^data:/);
    await settings(page); await reload(page); await settings(page);
    await expect(page.getByLabel('Show website icons', { exact: true })).toBeChecked();
    await page.getByLabel('Show website icons', { exact: true }).uncheck(); await back(page);
    await expect(page.locator('.entry-row img[src^="https://icons.duckduckgo.com"]')).toHaveCount(0);
});

test('WebDAV save-method and stat-reload controls change real provider requests', async ({ page }) => {
    let bytes = (await fixture()).buffer;
    let temporary = bytes;
    const requests: string[] = [];
    let revision = Date.UTC(2026, 0, 1);
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,MOVE,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization,Cache-Control,Content-Type,If-Match,If-None-Match,Destination,Overwrite');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified,ETag');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        requests.push(req.method!);
        if (req.method === 'PUT') {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            if (req.url?.startsWith('/.')) temporary = Buffer.concat(chunks);
            else { bytes = Buffer.concat(chunks); revision += 1000; }
            res.writeHead(201).end(); return;
        }
        if (req.method === 'MOVE') { bytes = temporary; revision += 1000; res.writeHead(201).end(); return; }
        if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
        res.setHeader('Last-Modified', new Date(revision).toUTCString());
        res.setHeader('ETag', `"${revision}"`);
        res.writeHead(200).end(req.method === 'HEAD' ? undefined : bytes);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await page.goto('/next.html'); await page.locator('#open-webdav').click();
        await page.locator('#webdav-url').fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}/preferences.kdbx`);
        await page.locator('#webdav-next').click(); await unlock(page);
        await settings(page, 'Saving and content'); await page.locator('#setting-auto-save').selectOption('0');
        await page.locator('#provider-setting-webdav-webdavSaveMethod').selectOption('put');
        await page.locator('#provider-setting-webdav-webdavStatReload').check();
        await back(page); await selectEntry(page, 'Strong record'); await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('.entry-editor').getByLabel('Title', { exact: true }).fill('Saved directly');
        await page.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
        requests.length = 0; await settings(page, 'Saving and content'); await page.getByRole('button', { name: 'Save now', exact: true }).click();
        await expect(page.getByRole('region', { name: 'Saving and content', exact: true }).getByRole('status')).toContainText('synchronized', { timeout });
        expect(requests).toContain('PUT'); expect(requests).toContain('GET'); expect(requests).not.toContain('MOVE'); expect(requests).not.toContain('HEAD');
        const reopened = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
        expect([...reopened.groups[0].allEntries()].some(entry => entry.fields.get('Title') === 'Saved directly')).toBe(true);
        await page.locator('#provider-setting-webdav-webdavSaveMethod').selectOption('default');
        await page.locator('#provider-setting-webdav-webdavStatReload').uncheck(); await back(page);
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('.entry-editor').getByLabel('Title', { exact: true }).fill('Saved with move');
        await page.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
        requests.length = 0; await settings(page, 'Saving and content'); await page.getByRole('button', { name: 'Save now', exact: true }).click();
        await expect(page.getByRole('region', { name: 'Saving and content', exact: true }).getByRole('status')).toContainText('synchronized', { timeout });
        expect(requests).toContain('HEAD'); expect(requests).toContain('MOVE');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
