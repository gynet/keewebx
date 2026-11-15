import { choosePasswordUnlock, choosePasskeyUnlock, expectUnlockScreen } from './unlock-mode';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';
import { activateVaultUtility } from './vault-utilities';

// Same CDP WebAuthn harness as Classic passkey-unlock.spec.ts. Successful ceremonies
// use Chromium's virtual authenticator. Cancellation/delays are explicitly simulated.
// No physical authenticator, OS biometric UI, or remote service is exercised.
test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium CDP virtual authenticator required');
const password = 'Disposable passkey fixture password';
const title = 'Passkey preserved entry';
const timeout = 30_000;
const section = (page: Page) => page.getByRole('region', { name: 'Local passkey unlock', exact: true });
const payload = (buffer: Uint8Array, name: string) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(buffer) });
async function fixture(name = 'passkey-one', withKey = false, entryTitle = title) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const key = withKey ? await kdbx.Credentials.createRandomKeyFile(2) : undefined;
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key), name);
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', entryTitle);
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Preserved disposable entry secret'));
    return { name, key, bytes: new Uint8Array(await db.save()), entryId: entry.uuid.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function authenticator(context: BrowserContext, page: Page, hasPrf = true) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
        protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
        hasPrf, isUserVerified: true, automaticPresenceSimulation: true
    } });
    return { cdp, authenticatorId, credentials: () => cdp.send('WebAuthn.getCredentials', { authenticatorId }) };
}
async function unlockOptions(page: Page) {
    const options = page.locator('.unlock-card__options');
    if (!await options.evaluate(element => element.hasAttribute('open'))) await options.locator('summary').click();
}
async function infos(page: Page): Promise<any[]> {
    return page.evaluate(() => JSON.parse(localStorage.getItem('fileInfo') || '[]'));
}
async function record(page: Page, name = 'passkey-one') { return (await infos(page)).find((value) => value.name === name); }
async function passwordOpen(page: Page, source: Fixture) {
    await choosePasswordUnlock(page);
    await page.locator('#password').fill(password);
    if (source.key) await page.locator('#unlock-key-file').setInputFiles(payload(source.key, 'fixture.keyx'));
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}
async function openFile(page: Page, source: Fixture) {
    await page.locator('#open-file-input').setInputFiles(payload(source.bytes, `${source.name}.kdbx`));
    await passwordOpen(page, source);
}
async function openSettings(page: Page) {
    await activateVaultUtility(page, 'Settings');
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    await expect(section(page)).toBeVisible();
}
async function enroll(page: Page, source: Fixture, currentPassword = password) {
    await section(page).getByLabel('Current master password', { exact: true }).fill(currentPassword);
    if (source.key) await section(page).getByLabel('Current key file (if required)', { exact: true }).setInputFiles(payload(source.key, 'fixture.keyx'));
    await section(page).getByRole('button', { name: 'Enable local passkey', exact: true }).click();
    await section(page).getByRole('button', { name: 'Verify passkey', exact: true }).click();
    await expect(section(page).getByRole('status')).toContainText('Passkey unlock saved in this browser', { timeout });
    await expect(section(page).getByLabel('Current master password', { exact: true })).toHaveValue('');
}
async function lock(page: Page) {
    if (await page.getByRole('button', { name: 'Back to vault', exact: true }).isVisible()) {
        await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    }
    await activateVaultUtility(page, 'Lock');
    await expectUnlockScreen(page);
}
async function screenshot(page: Page, name: string) {
    const path = test.info().outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true });
    await test.info().attach(name, { path, contentType: 'image/png' });
}
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        (window as any).__keewebx_passkey_capability_override = { prf: 'supported', reason: 'Virtual authenticator test',
            platform: { os: 'macos', browser: 'chrome', osVersion: '15.0.0' } };
    });
    await page.goto('/next.html');
});


test('registered vault: passkey first, one primary, explicit keyboard recovery, declined forget and Enter', async ({ page, context }) => {
    const auth = await authenticator(context, page), source = await fixture();
    await openFile(page, source); await openSettings(page); await enroll(page, source); await lock(page); await page.reload();
    const passkey = page.getByRole('button', { name: 'Unlock with passkey', exact: true });
    await expect(passkey).toBeFocused();
    await expect(page.locator('#password')).toBeHidden();
    await expect(page.locator('#password')).toBeDisabled();
    await expect(page.locator('#unlock')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Forget local passkey', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel unlock', exact: true })).toBeVisible();
    for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await expectUnlockScreen(page);
        expect((await passkey.boundingBox())!.height).toBe(46);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await screenshot(page, `after-passkey-first-${width}`);
    }
    // A native form submit cannot invoke the password pipeline while its input is folded.
    await page.locator('.unlock-card').evaluate(form => (form as HTMLFormElement).requestSubmit());
    await expect(page.locator('#unlock-error')).toHaveCount(0);
    await expect(page.locator('.entry-row')).toHaveCount(0);
    await expect(passkey).toBeEnabled();
    await passkey.press('Enter');
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible();
    await lock(page);
    const fallback = page.getByRole('button', { name: 'Use password', exact: true });
    await fallback.focus(); await fallback.press('Enter');
    await expect(fallback).toHaveCount(0);
    await expect(page.locator('#password')).toBeFocused();
    await expect(passkey).toHaveCount(0);
    await expectUnlockScreen(page);
    await page.getByRole('button', { name: 'Show password', exact: true }).click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide password', exact: true }).click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'password');
    await screenshot(page, 'after-explicit-password-mode');
    await page.locator('#password').fill('wrong'); await page.locator('#password').press('Enter');
    await expect(page.locator('#unlock-error')).toHaveText('Wrong password');
    await page.locator('#password').fill(password); await page.locator('#password').press('Enter');
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible();
    await lock(page); // mode resets per newly mounted vault card
    await expect(passkey).toBeVisible(); await expect(page.locator('#password')).toBeHidden();
    const before = await record(page);
    await unlockOptions(page);
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Forget local passkey', exact: true }).click();
    expect(await record(page)).toEqual(before);
    await expect(passkey).toBeEnabled();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Forget local passkey', exact: true }).click();
    await expect(passkey).toHaveCount(0);
    await expect(page.locator('#password')).toBeFocused();
    await expectUnlockScreen(page);
    expect((await auth.credentials()).credentials).toHaveLength(1);
    await expect(page.locator('#unlock-error')).toContainText('authenticator credential was not deleted');
    await page.locator('#password').fill(password); await page.locator('#password').press('Enter');
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible();
});

test('key file stays visible with options closed; missing and wrong keys fail; correct key enables real passkey', async ({ page, context }) => {
    await authenticator(context, page); const source = await fixture('passkey-keyfile', true);
    await openFile(page, source); await openSettings(page); await enroll(page, source); await lock(page); await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.unlock-card__options')).not.toHaveAttribute('open');
    await expect(page.getByRole('button', { name: 'Use a key file', exact: true })).toBeVisible();
    const passkey = page.getByRole('button', { name: 'Unlock with passkey', exact: true });
    await expect(page.locator('#password')).toBeHidden();
    await passkey.click(); await expect(page.locator('#unlock-error')).toContainText('Select the key file');
    await expect(page.locator('#password')).toBeFocused();
    await expectUnlockScreen(page);
    await page.locator('#unlock-key-file').setInputFiles(payload(new Uint8Array([1, 2, 3]), 'wrong.key'));
    await choosePasskeyUnlock(page);
    await passkey.click(); await expect(page.locator('#unlock-error')).toContainText('Wrong password or key file');
    await expect(page.locator('#password')).toBeFocused();
    await expectUnlockScreen(page);
    const longName = 'required-key-'.repeat(14) + '.keyx';
    await page.locator('#unlock-key-file').setInputFiles(payload(source.key!, longName));
    const options = page.locator('.unlock-card__options');
    if (await options.evaluate(element => element.hasAttribute('open'))) await options.locator('summary').click();
    await expect(page.getByRole('button', { name: `Key file: ${longName}`, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await choosePasskeyUnlock(page);
    await expect(page.locator('#password')).toBeHidden();
    await expect(page.getByRole('button', { name: `Key file: ${longName}`, exact: true })).toBeVisible();
    await screenshot(page, 'after-required-key-mobile');
    await passkey.click(); await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible();
    await lock(page);
    await passwordOpen(page, source);
});

test('unregistered password form: keyboard options, visibility, error recovery and cancel remain available', async ({ page }) => {
    const source = await fixture();
    await page.locator('#open-file-input').setInputFiles(payload(source.bytes, `${source.name}.kdbx`));
    await expect(page.getByRole('button', { name: 'Unlock with passkey', exact: true })).toHaveCount(0);
    const summary = page.locator('.unlock-card__options > summary');
    await summary.focus(); await summary.press('Enter');
    await expect(page.getByRole('checkbox', { name: 'Set up passkey after unlocking', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Show password', exact: true }).click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide password', exact: true }).click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'password');
    await summary.click();
    await page.locator('#password').fill('wrong'); await page.locator('#password').press('Enter');
    await expect(page.locator('#unlock-error')).toHaveText('Wrong password');
    await expect(page.getByRole('button', { name: 'Use a key file', exact: true })).toBeVisible();
    await expect(page.locator('#password')).toHaveAttribute('aria-describedby', 'unlock-error');
    await screenshot(page, 'after-password-error-options');
    await page.getByRole('button', { name: 'Cancel unlock', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Open a vault', exact: true })).toBeVisible();
    await page.locator('#open-file-input').setInputFiles(payload(source.bytes, `${source.name}.kdbx`));
    await page.locator('#password').fill(password); await page.locator('#password').press('Enter');
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible();
});


test('registered vault with unavailable browser WebAuthn defaults to password without hiding recovery', async ({ page, context }) => {
    await authenticator(context, page); const source = await fixture();
    await openFile(page, source); await openSettings(page); await enroll(page, source); await lock(page);
    const before = await record(page);
    // Explicit browser API absence simulation; registration and KDBX remain real.
    await page.addInitScript(() => { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Unlock with passkey', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Use password', exact: true })).toHaveCount(0);
    await expect(page.locator('#password')).toBeFocused();
    await expect(page.getByRole('status')).toContainText('Passkey unlock is unavailable here');
    await expectUnlockScreen(page);
    await screenshot(page, 'after-unsupported-password-default');
    expect(await record(page)).toEqual(before);
    await passwordOpen(page, source);
});

test('canceled passkey automatically reveals focused password recovery and keeps registration', async ({ page, context }) => {
    await authenticator(context, page); const source = await fixture();
    await openFile(page, source); await openSettings(page); await enroll(page, source); await lock(page);
    const before = await record(page);
    await page.evaluate(() => { navigator.credentials.get = async () => { throw new DOMException('Explicit test cancellation', 'NotAllowedError'); }; });
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await expect(page.locator('#unlock-error')).toContainText('canceled');
    await expect(page.locator('#password')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Show password', exact: true })).toBeVisible();
    await expectUnlockScreen(page);
    await screenshot(page, 'after-passkey-failure-recovery');
    expect(await record(page)).toEqual(before);
    await page.locator('#password').fill(password); await page.locator('#password').press('Enter');
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible();
});
