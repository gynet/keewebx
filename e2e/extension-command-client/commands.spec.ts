import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

// Install a compatible client and use its visible controls over the production
// tab bridge. App consent and mutations are real; exported KDBX is read separately.
const origin = `http://localhost:${process.env.KEEWEBX_E2E_PORT || 8127}`;
const extension = process.env.KW_E2E_COMMAND_CLIENT_DIR || path.resolve(__dirname, '../../.cache/extension-command-client');
const password = 'Disposable command vault password';
const timestamp = Date.UTC(2026, 10, 13, 12, 0, 5);
let context: BrowserContext, app: Page, client: Page, profile: string;
const credentials = () => new kdbx.Credentials(kdbx.ProtectedValue.fromString(password));
async function fixture(name: string) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(credentials(), name);
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const group = db.createGroup(db.createGroup(db.getDefaultGroup(), 'Team'), 'Accounts');
    const entry = db.createEntry(group);
    entry.fields.set('Title', `${name} login`);
    entry.fields.set('URL', `https://${name.toLowerCase()}.example.test/login`);
    entry.fields.set('UserName', `${name}-user`);
    entry.fields.set('Password', kdbx.ProtectedValue.fromString(`${name}-password`));
    entry.fields.set('Recovery code', kdbx.ProtectedValue.fromString(`${name}-recovery`));
    entry.fields.set('Other secret', kdbx.ProtectedValue.fromString(`${name}-unselected-secret`));
    entry.fields.set('otp', kdbx.ProtectedValue.fromString('otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=6&period=30'));
    return { name, buffer: Buffer.from(await db.save()), uuid: kdbx.ByteUtils.bytesToHex(entry.uuid.bytes), group: group.uuid.id };
}
async function open(source: Awaited<ReturnType<typeof fixture>>, additional = false) {
    if (additional) await app.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await app.locator('#open-file-input').setInputFiles({ name: source.name + '.kdbx', mimeType: 'application/octet-stream', buffer: source.buffer });
    await app.locator('#password').fill(password);
    await app.locator('#unlock').click();
    await expect(app.locator('.entry-row').first()).toBeVisible();
    await expect(app.getByRole('dialog', { name: 'Open another vault', exact: true })).toHaveCount(0);
}
async function start(name: string) {
    await client.getByRole('button', { name, exact: true }).click();
}
async function result(ok = true) {
    const output = client.getByRole('status', { name: 'Command result' });
    await expect(output).toHaveText(/^\{/);
    const response = JSON.parse(await output.innerText());
    expect(response.ok, JSON.stringify(response)).toBe(ok);
    return response;
}
async function command(name: string, ok = true) { await start(name); return result(ok); }
async function consent() {
    const dialog = app.getByRole('dialog', { name: 'Allow browser extension access', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await dialog.getByRole('checkbox', { name: 'All databases, including ones opened later' }).uncheck();
    await dialog.getByRole('button', { name: 'Allow', exact: true }).click();
}
async function sessions() {
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    await app.getByRole('tab', { name: 'Browser extension', exact: true }).click();
    return app.getByRole('region', { name: 'Browser extension sessions', exact: true });
}
async function back() { await app.getByRole('button', { name: 'Back to vault', exact: true }).filter({ visible: true }).click(); }
async function readExport(name: string) {
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    await app.getByRole('tab', { name: 'Database', exact: true }).click();
    const pending = app.waitForEvent('download');
    await app.getByRole('form', { name: `Database settings: ${name}`, exact: true })
        .getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    const stream = await download.createReadStream();
    if (!stream) throw new Error('No encrypted download');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    expect(bytes.includes(Buffer.from('new-secret'))).toBe(false);
    await back();
    return kdbx.Kdbx.load(new Uint8Array(bytes).buffer, credentials());
}
function text(entry: kdbx.KdbxEntry, key: string) {
    const value = entry.fields.get(key);
    return value instanceof kdbx.ProtectedValue ? value.getText() : value;
}
function expectedOtp() {
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30_000)));
    const hash = createHmac('sha1', '12345678901234567890').update(counter).digest();
    return String((hash.readUInt32BE(hash[19] & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
async function otherField() {
    await start('Read other field');
    const entry = app.getByRole('dialog', { name: 'Select an entry', exact: true });
    await entry.getByRole('option').filter({ hasText: 'A login' }).click();
    const field = app.getByRole('dialog', { name: 'Select a field', exact: true });
    await expect(field).toBeVisible();
    await expect(field).not.toContainText('A-recovery');
    await expect(field).not.toContainText('A-unselected-secret');
    await expect(field).not.toContainText('A-password');
    return field;
}
test.beforeEach(async ({}, info) => {
    expect(fs.existsSync(path.join(extension, 'manifest.json')), 'Build compatible command fixture first').toBe(true);
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-commands-'));
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
        viewport: { width: info.title.includes('320px') ? 320 : 1280, height: 850 },
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    context.setDefaultTimeout(10_000);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    app = await context.newPage(); await app.goto(origin + '/next.html');
    await app.clock.setFixedTime(timestamp);
    client = await context.newPage();
    await client.goto(`chrome-extension://${new URL(worker.url()).host}/client.html`);
    await client.getByLabel('App URL').fill(origin + '/next.html');
    await client.getByLabel('Login URL').fill('https://a.example.test/login');
});
test.afterEach(async ({}, info) => {
    if (!context) return;
    if (info.status !== info.expectedStatus) {
        for (const [i, page] of context.pages().entries()) {
            fs.writeFileSync(info.outputPath(`page-${i}.txt`), await page.locator('body').innerText().catch(() => ''));
            await page.screenshot({ path: info.outputPath(`page-${i}.png`) }).catch(() => {});
        }
    }
    await context.tracing.stop({ path: info.outputPath('trace.zip') });
    await context.close(); fs.rmSync(profile, { recursive: true, force: true });
});

for (const width of [1280, 320]) test(`OTP, protected Other, selected Save/update and nested group commands at ${width}px`, async ({}, info) => {
    const a = await fixture('A'), b = await fixture('B');
    await open(a); await open(b, true);
    await command('Connect');
    await start('Read OTP'); await consent();
    expect((await result()).value.totp).toBe(expectedOtp());
    const field = await otherField();
    await field.getByRole('radio', { name: /Recovery code/ }).check();
    await field.getByRole('button', { name: 'Use field', exact: true }).click();
    const other = await result();
    expect(other.value).toMatchObject({ field: 'Recovery code', value: 'A-recovery' });
    expect(JSON.stringify(other)).not.toMatch(/A-password|A-unselected-secret|otpauth/);
    const canceled = await otherField();
    await canceled.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(JSON.stringify(await result(false))).not.toMatch(/A-recovery|A-password|A-unselected-secret/);
    await client.getByLabel('Login URL').fill('https://new.example.test/login');
    await start('Save login');
    const save = app.getByRole('dialog', { name: 'Save login', exact: true });
    const destination = save.getByLabel('Destination group');
    const target = destination.locator('option').filter({ hasText: 'B (2) / B / Team / Accounts' });
    await expect(target).toHaveCount(1);
    await destination.selectOption((await target.getAttribute('value'))!);
    await save.screenshot({ path: info.outputPath('selected-save.png') });
    await save.getByRole('button', { name: 'Allow', exact: true }).click(); await result();
    const login = (await command('Read logins')).value.entries[0];
    expect(login).toMatchObject({ login: 'new-user', password: 'new-secret' });
    // Shared history groups edits until synchronization. Finish the first save
    // through the UI before testing a separate update and its prior revision.
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    await app.getByRole('tab', { name: 'Saving and content', exact: true }).click();
    await app.getByRole('button', { name: 'Save now', exact: true }).click();
    await expect(app.getByRole('status').filter({ hasText: 'B: saved in this browser.' })).toBeVisible();
    await back();
    await app.clock.setFixedTime(timestamp + 60_000);
    await client.getByLabel('Entry UUID').fill(login.uuid);
    await client.getByLabel('Password', { exact: true }).fill('updated-secret');
    await start('Save login');
    const update = app.getByRole('dialog', { name: 'Update login', exact: true });
    await expect(update.getByLabel('Destination group')).toBeDisabled();
    await expect(update.getByLabel('Destination group').locator('option:checked')).toContainText('B (2) / B / Team / Accounts');
    await update.getByRole('button', { name: 'Allow', exact: true }).click();
    const beforeGroup = await result();
    await start('Create group');
    const group = app.getByRole('dialog', { name: 'Create extension group', exact: true });
    await group.getByRole('combobox', { name: /^Database/ }).selectOption({ label: 'B (2)' });
    expect(await group.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await group.screenshot({ path: info.outputPath('selected-group.png') });
    await group.getByRole('button', { name: 'Allow', exact: true }).click();
    const groupResponse = await result();
    expect(groupResponse.attention).toBeGreaterThan(beforeGroup.attention);
    const created = groupResponse.value;
    expect(created.name).toBe('Nested');
    const existingGroup = await command('Create group');
    expect(existingGroup.value.uuid).toBe(created.uuid);
    expect(existingGroup.attention).toBe(groupResponse.attention);
    const tree = (await command('Read groups')).value.groups.groups;
    expect(tree.map((g: any) => g.name)).toEqual(['A', 'B']);
    const browser = tree[1].children.find((g: any) => g.name === 'Browser');
    expect(browser.children).toContainEqual({ name: 'Nested', uuid: created.uuid, children: [] });
    const section = await sessions();
    await expect(section).toContainText('Passwords read: 4');
    await expect(section).toContainText('Passwords written: 2');
    expect(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await section.screenshot({ path: info.outputPath('sessions.png') });
    await back();
    const savedA = await readExport('A'), savedB = await readExport('B');
    expect([...savedA.getDefaultGroup().allEntries()]).toHaveLength(1);
    expect([...savedA.getDefaultGroup().allGroups()].some(g => g.name === 'Browser')).toBe(false);
    const entries = [...savedB.getDefaultGroup().allEntries()];
    const saved = entries.find(e => kdbx.ByteUtils.bytesToHex(e.uuid.bytes) === login.uuid)!;
    expect(entries).toHaveLength(2); expect(saved.parentGroup?.uuid.id).toBe(b.group);
    expect(saved.fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
    expect(text(saved, 'Password')).toBe('updated-secret');
    expect(saved.history.some(e => text(e, 'Password') === 'new-secret')).toBe(true);
    const untouched = entries.find(e => kdbx.ByteUtils.bytesToHex(e.uuid.bytes) === b.uuid)!;
    expect(text(untouched, 'Recovery code')).toBe('B-recovery');
    expect(untouched.fields.get('Recovery code')).toBeInstanceOf(kdbx.ProtectedValue);
    const nested = [...savedB.getDefaultGroup().allGroups()].filter(g => g.name === 'Nested');
    expect(nested).toHaveLength(1); expect(kdbx.ByteUtils.bytesToHex(nested[0].uuid.bytes)).toBe(created.uuid);
});

async function approveWithLogin() {
    await command('Connect'); await start('Read logins'); await consent();
    expect((await result()).value.entries[0].password).toBe('A-password');
}
async function delayOtp() {
    // Delay only completion of the browser's real HMAC operation. This is an
    // async boundary fault injection, without app model/protocol/prompt hooks.
    await app.evaluate(() => {
        const original = crypto.subtle.sign.bind(crypto.subtle);
        (window as any).otpPending = false;
        crypto.subtle.sign = async (...args: Parameters<SubtleCrypto['sign']>) => {
            const value = await original(...args);
            if (args[1].algorithm.name !== 'HMAC') return value;
            (window as any).otpPending = true;
            return new Promise<ArrayBuffer>(resolve => { (window as any).releaseOtp = () => {
                crypto.subtle.sign = original; resolve(value);
            }; });
        };
    });
    await start('Read OTP');
    await expect.poll(() => app.evaluate(() => (window as any).otpPending)).toBe(true);
}
for (const guard of ['revoke', 'lock'] as const) test(`pending OTP ${guard} and subsequent command denial`, async () => {
    await open(await fixture('A')); await approveWithLogin();
    const section = await sessions();
    await expect(section).toContainText('Passwords read: 1');
    if (guard === 'lock') await back();
    await delayOtp();
    if (guard === 'revoke') {
        // The counter must update while this mounted panel is already visible.
        await expect(section).toContainText('Passwords read: 2');
        await section.getByRole('checkbox', { name: 'A (1)', exact: true }).click();
    } else await app.locator('#lock').click();
    const denied = await result(false);
    expect(JSON.stringify(denied)).not.toContain(expectedOtp());
    await app.evaluate(() => (window as any).releaseOtp());
    expect(await client.getByRole('status').innerText()).not.toContain(expectedOtp());
    if (guard === 'lock') {
        const status = await command('Status');
        expect(status.value.locked).toBe(true);
        expect(status.events).toContain('database-locked');
    }
    await start('Read OTP');
    if (guard === 'revoke') {
        // Empty scope may produce an empty picker, never another vault's match.
        const picker = app.getByRole('dialog', { name: 'Select an entry', exact: true });
        await expect(picker.getByRole('option')).toHaveCount(0);
        if (await picker.isVisible()) await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    } else {
        await expect(app.getByText('Unlock to connect a browser extension', { exact: true })).toBeVisible();
        await app.locator('#password').fill('wrong password');
        await app.locator('#unlock').click();
        await expect(app.locator('#unlock-error')).toHaveText('Wrong password');
        await app.getByRole('button', { name: 'Cancel extension request', exact: true }).click();
    }
    expect(JSON.stringify(await result(false))).not.toMatch(/A-password|A-recovery/);
    if (guard === 'lock') {
        await app.locator('#password').fill(password); await app.locator('#unlock').click();
        await expect(app.locator('.entry-row').first()).toBeVisible();
        expect((await command('Read OTP')).value.totp).toBe(expectedOtp());
        expect((await command('Status')).value.locked).toBe(false);
    }
});

test('Save and group cancellation leave independently decrypted vaults unchanged', async () => {
    const a = await fixture('A'), b = await fixture('B');
    await open(a); await open(b, true); await approveWithLogin();
    await start('Save login');
    await app.getByRole('dialog', { name: 'Save login', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await result(false);
    await start('Create group');
    await app.getByRole('dialog', { name: 'Create extension group', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await result(false);
    const section = await sessions(); await expect(section).toContainText('Passwords written: 0'); await back();
    for (const source of [a, b]) {
        const db = await readExport(source.name);
        const entries = [...db.getDefaultGroup().allEntries()];
        expect(entries).toHaveLength(1);
        expect(kdbx.ByteUtils.bytesToHex(entries[0].uuid.bytes)).toBe(source.uuid);
        expect(text(entries[0], 'Password')).toBe(source.name + '-password');
        expect([...db.getDefaultGroup().allGroups()].some(g => g.name === 'Browser')).toBe(false);
    }
});

test('explicitly permitted closed recent vault can be revoked before reopening', async ({}, info) => {
    const a = await fixture('A'), b = await fixture('B');
    await open(a); await open(b, true); await approveWithLogin();
    await app.locator('#lock').click();
    await expect(app.locator('#password')).toBeVisible();
    await app.locator('.vault-row[data-vault="A"]').click();
    await app.locator('#password').fill(password); await app.locator('#unlock').click();
    await expect(app.locator('.entry-row').first()).toBeVisible();
    const section = await sessions();
    const closed = section.getByRole('checkbox', { name: 'B (2) — closed', exact: true });
    await expect(closed).toBeChecked();
    await section.screenshot({ path: info.outputPath('closed-permission.png') });
    await closed.click(); await expect(closed).toHaveCount(0);
    await expect(section.getByRole('checkbox', { name: 'A (1)', exact: true })).toBeChecked();
    await back();
    await app.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await app.getByRole('dialog', { name: 'Open another vault', exact: true }).locator('.vault-row[data-vault="B"]').click();
    await app.locator('#password').fill(password); await app.locator('#unlock').click();
    await expect(app.getByRole('dialog', { name: 'Open another vault', exact: true })).toHaveCount(0);
    await client.getByLabel('Login URL').fill('https://b.example.test/login');
    await start('Read logins');
    const picker = app.getByRole('dialog', { name: 'Select an entry', exact: true });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('option').filter({ hasText: 'B login' })).toHaveCount(0);
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(JSON.stringify(await result(false))).not.toContain('B-password');
    await client.getByLabel('Login URL').fill('https://a.example.test/login');
    expect((await command('Read logins')).value.entries[0].password).toBe('A-password');
    expect((await command('Read groups')).value.groups.groups.map((group: any) => group.name)).toEqual(['A']);
    await start('Save login');
    const save = app.getByRole('dialog', { name: 'Save login', exact: true });
    await expect(save.getByLabel('Destination group').locator('option').filter({ hasText: 'B (' })).toHaveCount(0);
    await save.getByRole('button', { name: 'Cancel', exact: true }).click(); await result(false);
    await start('Create group');
    const group = app.getByRole('dialog', { name: 'Create extension group', exact: true });
    await expect(group.getByRole('combobox').locator('option')).toHaveText(['A (1)']);
    await group.getByRole('button', { name: 'Cancel', exact: true }).click(); await result(false);
});

test('Other field Escape cancels pending disclosure and revoked next request is denied', async () => {
    await open(await fixture('A')); await approveWithLogin();
    const field = await otherField();
    await field.getByRole('radio', { name: /Recovery code/ }).check();
    await app.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    expect(JSON.stringify(await result(false))).not.toMatch(/A-password|A-recovery|A-unselected-secret/);
    const section = await sessions();
    await section.getByRole('checkbox', { name: 'A (1)', exact: true }).click();
    await start('Read other field');
    expect(JSON.stringify(await result(false))).not.toMatch(/A-password|A-recovery|A-unselected-secret/);
    await expect(app.getByRole('dialog', { name: 'Select a field', exact: true })).toHaveCount(0);
});
