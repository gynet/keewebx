import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

// Same CDP WebAuthn harness as Classic passkey-unlock.spec.ts. Successful ceremonies
// use Chromium's virtual authenticator. Cancellation/delays are explicitly simulated.
// No physical authenticator, OS biometric UI, or remote service is exercised.
test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium CDP virtual authenticator required');
const password = 'Disposable passkey fixture password';
const title = 'Passkey preserved entry';
const timeout = 30_000;
const section = (page: Page) => page.getByRole('region', { name: 'Local passkey unlock', exact: true });
const settings = (page: Page) => page.getByRole('form', { name: /^Database settings: / });
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
async function infos(page: Page): Promise<any[]> {
    return page.evaluate(() => JSON.parse(localStorage.getItem('fileInfo') || '[]'));
}
async function record(page: Page, name = 'passkey-one') { return (await infos(page)).find((value) => value.name === name); }
async function passwordOpen(page: Page, source: Fixture) {
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
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    await expect(section(page)).toBeVisible();
}
async function enroll(page: Page, source: Fixture) {
    await section(page).getByLabel('Current master password', { exact: true }).fill(password);
    if (source.key) await section(page).getByLabel('Current key file (if required)', { exact: true }).setInputFiles(payload(source.key, 'fixture.keyx'));
    await section(page).getByRole('button', { name: 'Enable local passkey', exact: true }).click();
    await expect(section(page).getByRole('status')).toContainText('Passkey unlock saved in this browser', { timeout });
    await expect(section(page).getByLabel('Current master password', { exact: true })).toHaveValue('');
}
async function lock(page: Page) {
    if (await page.getByRole('button', { name: 'Back to vault', exact: true }).isVisible()) {
        await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('#password')).toBeVisible({ timeout });
}
async function screenshot(page: Page, name: string) {
    const path = test.info().outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true });
    await test.info().attach(name, { path, contentType: 'image/png' });
}
async function provesExport(page: Page, source: Fixture) {
    const pending = page.waitForEvent('download');
    await settings(page).getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    const stream = await download.createReadStream();
    if (!stream) throw new Error('No encrypted export');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    expect(bytes.includes(Buffer.from('Preserved disposable entry secret'))).toBe(false);
    const db = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer,
        new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), source.key));
    const entry = [...db.getDefaultGroup().allEntries()].find((value) => value.uuid.id === source.entryId);
    expect(entry?.fields.get('Title')).toBe(title);
    expect((entry?.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('Preserved disposable entry secret');
    await test.info().attach('verified-encrypted-export.kdbx', { body: bytes, contentType: 'application/octet-stream' });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        (window as any).__keewebx_passkey_capability_override = { prf: 'supported', reason: 'Virtual authenticator test',
            platform: { os: 'macos', browser: 'chrome', osVersion: '15.0.0' } };
    });
    await page.goto('/next.html');
});

test('virtual PRF: fresh password verification, durable unlock, forget preserves KDBX and other recent records', async ({ page, context }) => {
    const auth = await authenticator(context, page), source = await fixture();
    await openFile(page, source); await openSettings(page);
    await section(page).getByLabel('Current master password', { exact: true }).fill('wrong');
    await section(page).getByRole('button', { name: 'Enable local passkey', exact: true }).click();
    await expect(section(page).getByRole('status')).toHaveText('Wrong password or key file.');
    expect((await auth.credentials()).credentials).toHaveLength(0);
    expect((await record(page)).passkeyCredentialId).toBeFalsy();
    await enroll(page, source);
    const saved = await record(page);
    expect(saved.passkeyWrappedKey).toBeTruthy(); expect(saved.passkeyWrappedKey).not.toContain(password);
    expect((await auth.credentials()).credentials).toHaveLength(1);
    await provesExport(page, source); await screenshot(page, 'enrolled-verified-settings');
    await lock(page); await page.reload();
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout });
    await lock(page);
    const other = await fixture('other-vault'); await openFile(page, other); await lock(page);
    const otherBefore = await record(page, 'other-vault');
    await page.locator('[data-vault="passkey-one"]').click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Forget local passkey', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Unlock with passkey', exact: true })).toHaveCount(0);
    const forgotten = await record(page);
    for (const key of ['passkeyCredentialId', 'passkeyPrfSalt', 'passkeyWrappedKey', 'passkeyCreatedDate']) expect(forgotten[key]).toBeNull();
    expect((await infos(page)).map((value) => value.id).sort()).toEqual([saved.id, otherBefore.id].sort());
    expect(await record(page, 'other-vault')).toEqual(otherBefore);
    expect((await auth.credentials()).credentials).toHaveLength(1); // local forget does not revoke device credential
    await screenshot(page, 'forgotten-local-only');
    await page.reload(); await page.locator('[data-vault="passkey-one"]').click();
    await passwordOpen(page, source); await openSettings(page); await provesExport(page, source);
});

test('password unlock setup choice opens the selected passkey region without enrolling automatically', async ({ page, context }) => {
    const auth = await authenticator(context, page), source = await fixture();
    await page.locator('#open-file-input').setInputFiles(payload(source.bytes, `${source.name}.kdbx`));
    const setup = page.getByRole('checkbox', { name: 'Set up passkey after unlocking', exact: true });
    await setup.check();
    await page.locator('#password').fill('wrong password'); await page.locator('#unlock').click();
    await expect(page.locator('#unlock-error')).toBeVisible();
    await expect(setup).toBeChecked();
    await expect(page.getByRole('tab', { name: 'Database', exact: true })).toHaveCount(0);
    expect((await auth.credentials()).credentials).toHaveLength(0);
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.getByRole('tab', { name: 'Database', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(section(page)).toBeVisible();
    await expect(section(page)).toBeFocused();
    expect((await auth.credentials()).credentials).toHaveLength(0);
    expect((await record(page)).passkeyCredentialId).toBeFalsy();
    await page.getByRole('tab', { name: 'Security', exact: true }).click();
    await page.getByRole('button', { name: `Set up or manage passkey unlock · ${source.name}`, exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Database', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(section(page)).toBeFocused();
    expect((await auth.credentials()).credentials).toHaveLength(0);
    await enroll(page, source);
    expect((await auth.credentials()).credentials).toHaveLength(1);
    await provesExport(page, source);
    await lock(page); await page.reload();
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout });
});

for (const unlockSecond of [false, true]) test(`late setup-requested decrypt cannot open Settings after ${unlockSecond ? 'ordinary unlock of B' : 'selection of B without unlocking'}`, async ({ page, context }) => {
    const auth = await authenticator(context, page);
    const first = await fixture('setup-race-a', false, 'Setup race entry A');
    const second = await fixture('setup-race-b', false, 'Setup race entry B');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#open-file-input').setInputFiles(payload(first.bytes, `${first.name}.kdbx`));
    await page.getByRole('checkbox', { name: 'Set up passkey after unlocking', exact: true }).check();
    // Delay only A's first real AES-CBC decrypt result; B uses the original crypto path.
    await page.evaluate(() => {
        const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
        crypto.subtle.decrypt = async (...args) => {
            const result = await decrypt(...args);
            const algorithm = typeof args[0] === 'string' ? args[0] : args[0].name;
            if (algorithm !== 'AES-CBC') return result;
            crypto.subtle.decrypt = decrypt;
            (window as any).__setupRaceHeld = true;
            await new Promise<void>(resolve => { (window as any).__releaseSetupRace = resolve; });
            return result;
        };
    });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect.poll(() => page.evaluate(() => !!(window as any).__setupRaceHeld)).toBe(true);
    try {
        await page.locator('#open-file-input').setInputFiles(payload(second.bytes, `${second.name}.kdbx`));
        await expect(page.getByRole('checkbox', { name: 'Set up passkey after unlocking', exact: true })).not.toBeChecked();
        if (unlockSecond) {
            await page.locator('#password').fill(password); await page.locator('#unlock').click();
            await page.locator('.entry-row[data-entry="Setup race entry B"]').click();
            await expect(page.locator('#entry-title')).toHaveText('Setup race entry B');
        } else {
            await expect(page.getByRole('heading', { name: `${second.name}.kdbx`, exact: true })).toBeVisible();
        }
        await expect(page.getByRole('tablist', { name: 'Settings categories', exact: true })).toHaveCount(0);
        await page.evaluate(() => (window as any).__releaseSetupRace());
        // Waiting for A's durable recent-file record proves its open continued past decrypt.
        await expect.poll(async () => (await record(page, first.name))?.name, { timeout }).toBe(first.name);
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect(page.getByRole('tablist', { name: 'Settings categories', exact: true })).toHaveCount(0);
        await expect(section(page)).toHaveCount(0);
        if (unlockSecond) {
            await expect(page.locator('#entry-title')).toHaveText('Setup race entry B');
            await expect(page.locator('.entry-row[data-entry="Setup race entry B"]')).toBeVisible();
            expect((await record(page, second.name)).passkeyCredentialId).toBeFalsy();
        } else {
            expect(await record(page, second.name)).toBeUndefined();
        }
        expect((await auth.credentials()).credentials).toHaveLength(0);
        expect((await record(page, first.name)).passkeyCredentialId).toBeFalsy();
        expect(errors).toEqual([]);
    } finally {
        await page.evaluate(() => (window as any).__releaseSetupRace?.());
    }
});

test('simulated cancellation preserves registration and password fallback', async ({ page, context }) => {
    await authenticator(context, page); const source = await fixture();
    await openFile(page, source); await openSettings(page); await enroll(page, source); await lock(page);
    const before = await record(page);
    // Leave a real unlock failure on this same recent-vault card before the passkey attempt.
    await page.evaluate(() => {
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        crypto.subtle.digest = async () => {
            crypto.subtle.digest = digest;
            throw new Error('Injected unlock diagnostic');
        };
    });
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await expect(page.locator('#unlock-error-details pre')).toHaveText('Error: Injected unlock diagnostic');
    await expect(page.locator('#unlock-error-details pre')).toBeHidden();
    await page.evaluate(() => { navigator.credentials.get = async () => { throw new DOMException('Simulated user cancellation', 'NotAllowedError'); }; });
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await expect(page.locator('#unlock-error')).toContainText('canceled');
    await expect(page.locator('#unlock-error-details')).toHaveCount(0);
    expect(await record(page)).toEqual(before);
    await screenshot(page, 'canceled-passkey-password-fallback');
    await passwordOpen(page, source);
});

test('simulated canceled enrollment and virtual authenticator without PRF never publish a descriptor', async ({ page, context }) => {
    const auth = await authenticator(context, page, false), source = await fixture();
    await openFile(page, source); await openSettings(page);
    await page.evaluate(() => {
        const original = navigator.credentials.create.bind(navigator.credentials);
        navigator.credentials.create = async (...args) => { navigator.credentials.create = original; throw new DOMException('Simulated cancellation', 'AbortError'); };
    });
    await section(page).getByLabel('Current master password', { exact: true }).fill(password);
    await section(page).getByRole('button', { name: 'Enable local passkey', exact: true }).click();
    await expect(section(page).getByRole('status')).toContainText('canceled');
    expect((await auth.credentials()).credentials).toHaveLength(0);
    await section(page).getByLabel('Current master password', { exact: true }).fill(password);
    await section(page).getByRole('button', { name: 'Enable local passkey', exact: true }).click();
    await expect(section(page).getByRole('status')).toContainText('does not support passkey unlock', { timeout });
    expect((await record(page)).passkeyCredentialId).toBeFalsy();
    await screenshot(page, 'virtual-authenticator-no-prf');
    await lock(page); await passwordOpen(page, source);
});

test('key-file vault rejects missing/wrong enrollment factors and still requires key file for passkey unlock', async ({ page, context }) => {
    await authenticator(context, page); const source = await fixture('passkey-keyfile', true);
    await openFile(page, source); await openSettings(page);
    await section(page).getByLabel('Current master password', { exact: true }).fill(password);
    await section(page).getByRole('button', { name: 'Enable local passkey', exact: true }).click();
    await expect(section(page).getByRole('status')).toContainText('current key file');
    await section(page).getByLabel('Current master password', { exact: true }).fill(password);
    await section(page).getByLabel('Current key file (if required)', { exact: true }).setInputFiles(payload(new Uint8Array([1, 2, 3]), 'wrong.key'));
    await section(page).getByRole('button', { name: 'Enable local passkey', exact: true }).click();
    await expect(section(page).getByRole('status')).toHaveText('Wrong password or key file.');
    await enroll(page, source); await lock(page);
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await expect(page.locator('#unlock-error')).toContainText('Select the key file');
    await page.locator('#unlock-key-file').setInputFiles(payload(source.key!, 'fixture.keyx'));
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout });
    await openSettings(page); await provesExport(page, source); await screenshot(page, 'keyfile-still-required');
});

// Hold a completed, genuine virtual-authenticator result to simulate an async race.
async function holdCeremony(page: Page, method: 'create' | 'get') {
    await page.evaluate((method) => {
        if (method === 'get') {
            const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
            crypto.subtle.decrypt = async (...args) => {
                const result = await decrypt(...args);
                (window as any).__passkeyUnwrapped = true;
                return result;
            };
        }
        const original = navigator.credentials[method].bind(navigator.credentials);
        (navigator.credentials as any)[method] = async (...args: any[]) => {
            const result = await (original as any)(...args);
            (window as any).__passkeyHeld = true;
            return new Promise((resolve) => { (window as any).__releasePasskey = () => resolve(result); });
        };
    }, method);
}
async function releaseCeremony(page: Page) { await page.evaluate(() => (window as any).__releasePasskey()); }

for (const failRead of [false, true]) {
    test(`held file read ${failRead ? 'failure' : 'success'} cannot replace an active virtual passkey unlock`, async ({ page, context }) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await authenticator(context, page); const source = await fixture();
        await openFile(page, source); await openSettings(page); await enroll(page, source); await lock(page);
        const saved = await record(page);
        await page.locator('#password').fill('Keep this password fallback draft');
        await holdCeremony(page, 'get');
        await page.evaluate(() => {
            const original = File.prototype.arrayBuffer;
            File.prototype.arrayBuffer = function () {
                if (this.name !== 'incoming.kdbx') return original.call(this);
                File.prototype.arrayBuffer = original;
                const gate = new Promise<boolean>(resolve => { (window as any).__releaseFileRead = resolve; });
                const result = original.call(this).then(async bytes => {
                    if (await gate) throw new DOMException('Held file read failed', 'NotReadableError');
                    return bytes;
                });
                (window as any).__fileReadSettled = result.then(() => {}, () => {});
                return result;
            };
        });
        await page.locator('#open-file-input').setInputFiles(payload(source.bytes, 'incoming.kdbx'));
        await expect(page.locator('.start__side').getByRole('status')).toHaveText('Reading file…');
        await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
        await expect.poll(() => page.evaluate(() => !!(window as any).__passkeyHeld)).toBe(true);
        // Complete the file read while the genuine virtual-authenticator result is still held.
        await page.evaluate(async fail => {
            (window as any).__releaseFileRead(fail);
            await (window as any).__fileReadSettled;
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        }, failRead);
        await expect(page.getByRole('heading', { name: 'passkey-one.kdbx', exact: true })).toBeVisible();
        await expect(page.locator('#password')).toHaveValue('Keep this password fallback draft');
        await expect(page.getByRole('button', { name: 'Unlock with passkey', exact: true })).toBeDisabled();
        await expect(page.locator('#open-file-error')).toHaveCount(0);
        await expect(page.locator('.entry-row')).toHaveCount(0);
        expect(await record(page)).toEqual(saved);
        await releaseCeremony(page);
        await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout });
        expect(errors).toEqual([]);
        await screenshot(page, `held-file-${failRead ? 'failure' : 'success'}-passkey-unlocked`);
    });
}

test('lock during held enrollment rejects late descriptor publication', async ({ page, context }) => {
    await authenticator(context, page); const source = await fixture();
    await openFile(page, source); await openSettings(page); await holdCeremony(page, 'create');
    await section(page).getByLabel('Current master password', { exact: true }).fill(password);
    await section(page).getByRole('button', { name: 'Enable local passkey', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!(window as any).__passkeyHeld)).toBe(true);
    // Return to the vault while registered work is pending; unmount and lock both invalidate publication.
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Securing your vaults' })).toBeVisible();
    await screenshot(page, 'lock-awaits-held-enrollment');
    await releaseCeremony(page);
    await expect(page.locator('#password')).toBeVisible({ timeout });
    expect((await record(page)).passkeyCredentialId).toBeFalsy();
    await passwordOpen(page, source);
});

test('switching vault while virtual unlock result is held prevents stale admission', async ({ page, context }) => {
    await authenticator(context, page); const source = await fixture();
    await openFile(page, source); await openSettings(page); await enroll(page, source); await lock(page);
    await holdCeremony(page, 'get');
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!(window as any).__passkeyHeld)).toBe(true);
    await page.locator('#open-webdav').click();
    await releaseCeremony(page);
    await expect.poll(() => page.evaluate(() => !!(window as any).__passkeyUnwrapped)).toBe(true);
    await expect(page.getByRole('heading', { name: 'Connect to WebDAV' })).toBeVisible();
    await expect(page.locator('.entry-row')).toHaveCount(0);
    await page.locator('[data-vault="passkey-one"]').click();
    await passwordOpen(page, source); await screenshot(page, 'stale-unlock-rejected-password-fallback');
});

test('idle lock timeout and reauthentication reject late enrollment on the retained settings surface', async ({ page, context }) => {
    await page.clock.install(); await page.reload();
    await authenticator(context, page); const source = await fixture();
    await openFile(page, source); await openSettings(page);
    await page.getByRole('tab', { name: 'Security', exact: true }).click();
    await page.locator('#setting-auto-lock').selectOption('5');
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    await holdCeremony(page, 'create');
    await section(page).getByLabel('Current master password', { exact: true }).fill(password);
    await section(page).getByRole('button', { name: 'Enable local passkey', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!(window as any).__passkeyHeld)).toBe(true);
    await page.clock.fastForward(6 * 60_000);
    await expect(page.getByRole('heading', { name: 'Securing your vaults', exact: true })).toBeVisible();
    const retained = page.getByRole('region', { name: 'Local passkey unlock', exact: true, includeHidden: true });
    await expect(retained).toBeHidden();
    await expect(retained.locator('xpath=ancestor::*[@inert and @hidden]')).toHaveCount(1);
    await page.clock.fastForward(16_000);
    await expect(page.getByRole('heading', { name: 'Verify to recover editing', exact: true })).toBeVisible();
    await screenshot(page, 'held-enrollment-requires-reauthentication');
    const verification = page.getByRole('form', { name: 'Verify database: passkey-one', exact: true });
    await verification.getByLabel('Master password', { exact: true }).fill(password);
    await verification.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(verification.getByRole('status')).toHaveText('Verified');
    await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
    await expect(section(page)).toBeVisible();
    await releaseCeremony(page);
    await expect(section(page).getByRole('status')).toContainText('vault or session changed');
    expect((await record(page)).passkeyCredentialId).toBeFalsy();
    await expect(section(page).getByLabel('Current master password', { exact: true })).toHaveValue('');
    await provesExport(page, source);
});

test('switching selection during real KDBX decrypt rejects admission after successful virtual PRF unwrap', async ({ page, context }) => {
    await authenticator(context, page); const source = await fixture();
    await openFile(page, source); await openSettings(page); await enroll(page, source); await lock(page);
    await page.evaluate(() => {
        const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
        crypto.subtle.decrypt = async (...args) => {
            const result = await decrypt(...args);
            const algorithm = typeof args[0] === 'string' ? args[0] : args[0].name;
            if (algorithm !== 'AES-CBC') return result; // PRF unwrap uses AES-GCM
            crypto.subtle.decrypt = decrypt;
            (window as any).__kdbxHeld = true;
            return new Promise((resolve) => { (window as any).__releaseKdbx = () => resolve(result); });
        };
    });
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!(window as any).__kdbxHeld)).toBe(true);
    await page.locator('#open-webdav').click();
    // Observe completion of normal KDBX XML parsing, without changing its result.
    await page.evaluate(() => {
        const parse = DOMParser.prototype.parseFromString;
        DOMParser.prototype.parseFromString = function(...args) {
            const result = parse.apply(this, args);
            (window as any).__kdbxParsed = true;
            return result;
        };
        (window as any).__releaseKdbx();
    });
    await expect.poll(() => page.evaluate(() => !!(window as any).__kdbxParsed)).toBe(true);
    await expect(page.getByRole('heading', { name: 'Connect to WebDAV', exact: true })).toBeVisible();
    await expect(page.locator('.entry-row')).toHaveCount(0);
    await screenshot(page, 'stale-decrypted-vault-not-admitted');
    await page.locator('[data-vault="passkey-one"]').click();
    await passwordOpen(page, source);
});

for (const theme of ['light', 'dark']) {
    test(`320px ${theme}: passkey key-file input stays contained with a long filename`, async ({ page, context }) => {
        await page.setViewportSize({ width: 320, height: 350 });
        await authenticator(context, page);
        const source = await fixture('passkey-mobile', true);
        await openFile(page, source); await openSettings(page);
        await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
        await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
        await page.getByRole('tab', { name: 'Database', exact: true }).click();
        const input = section(page).getByLabel('Current key file (if required)', { exact: true });
        const longName = 'required-key-'.repeat(14) + '.keyx';
        await input.setInputFiles(payload(source.key!, longName));
        await expect(section(page).getByText(longName, { exact: true })).toBeVisible();
        const geometry = await section(page).evaluate((element) => {
            const input = element.querySelector<HTMLInputElement>('input[type=file]')!;
            const bounds = (node: Element) => {
                const { left, right, width } = node.getBoundingClientRect();
                return { left, right, width, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
            };
            return { section: bounds(element), input: bounds(input), form: bounds(element.closest('form')!),
                root: bounds(document.documentElement), viewport: window.innerWidth };
        });
        await test.info().attach('key-file-geometry.json', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
        await screenshot(page, `mobile-${theme}-long-key-file`);
        expect(geometry.input.left).toBeGreaterThanOrEqual(geometry.section.left - 1);
        expect(geometry.input.right).toBeLessThanOrEqual(geometry.section.right + 1);
        expect(geometry.section.scrollWidth).toBeLessThanOrEqual(geometry.section.clientWidth + 1);
        expect(geometry.form.scrollWidth).toBeLessThanOrEqual(geometry.form.clientWidth + 1);
        expect(geometry.root.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
        await section(page).getByLabel('Current master password', { exact: true }).fill(password);
        await holdCeremony(page, 'create');
        await section(page).getByRole('button', { name: 'Enable local passkey', exact: true }).click();
        await expect.poll(() => page.evaluate(() => !!(window as any).__passkeyHeld)).toBe(true);
        await expect(input).toBeDisabled();
        await releaseCeremony(page);
        await expect(section(page).getByRole('status')).toContainText('Passkey unlock saved in this browser');
        await expect(input).toBeEnabled();
        expect(await input.evaluate((element: HTMLInputElement) => element.files?.length)).toBe(0);
    });
}
