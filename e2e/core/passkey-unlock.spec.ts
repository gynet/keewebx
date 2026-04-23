import { test, expect, Page, BrowserContext, CDPSession } from '@playwright/test';
import path from 'path';

/**
 * Passkey Quick Unlock regression guard — #9, Phase 2.
 *
 * End-to-end exercise of the full WebAuthn-PRF wrap-mode flow:
 *
 *   open file w/ master pw + "Remember with passkey" checkbox
 *      -> FileInfo persists passkeyCredentialId / prfSalt / wrappedKey
 *      -> reload
 *      -> reopen from recent files list
 *      -> .open__pass-enter-btn--passkey modifier renders
 *      -> click the key icon
 *      -> WebAuthn get() via the CDP virtual authenticator returns the
 *         same PRF output as at registration time (this is the whole
 *         point of PRF: deterministic salt -> deterministic bytes)
 *      -> AES-GCM unwrap of the master password
 *      -> normal password-based open flow runs
 *      -> app lands on the main entries view
 *
 * Uses Chrome DevTools Protocol (`WebAuthn.addVirtualAuthenticator`)
 * with `hasPrf: true` to script the credential ceremonies. This is the
 * only way to drive real navigator.credentials.{create,get} in a
 * headless test — Playwright's built-in WebAuthn helpers don't expose
 * the PRF flag, so we dispatch raw CDP calls.
 *
 * Chromium-only: Firefox + WebKit have no equivalent CDP surface, and
 * the feature itself is gated on `isPasskeyPrfSupported()` which fails
 * on those browsers today anyway. Test 3 (feature-gate) also runs on
 * chromium because we disable PublicKeyCredential via init script;
 * running it on firefox would race with its own PRF probe.
 *
 * See design: /tmp/keewebx-agents/tl.log (WRAP MODE, HKDF-v1)
 * See impl:   packages/core/app/scripts/comp/passkey/passkey-unlock.ts
 *             packages/core/app/scripts/views/open-view.ts
 */

const SCREENSHOT_DIR = 'e2e/screenshots';

const KDBX4_FILE = path.resolve(__dirname, '../../packages/db/resources/KDBX4.1.kdbx');
const KDBX4_PASSWORD = 'test';
const KDBX4_BASENAME = 'KDBX4.1';

// Gate the passkey specs to chromium — CDP WebAuthn domain is a
// Chromium devtools protocol, Firefox and WebKit do not implement it.
test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Passkey E2E uses CDP WebAuthn.addVirtualAuthenticator, Chromium-only'
);

interface VirtualAuthenticator {
    cdp: CDPSession;
    authenticatorId: string;
}

/**
 * Attach a Chromium virtual authenticator to the given page. Mirrors
 * the platform authenticator we target in production (Touch ID, Windows
 * Hello) — internal transport, resident keys, UV always satisfied, and
 * crucially the PRF extension enabled.
 *
 * `hasPrf: true` is the one setting that matters for this spec. If the
 * Chromium build this CDP session connects to does not recognize it,
 * the add call throws synchronously and the test fails fast with a
 * clear "unknown option" error instead of running against a pretend
 * authenticator that silently returns undefined PRF outputs.
 */
async function addVirtualAuthenticator(
    context: BrowserContext,
    page: Page,
    opts: { hasPrf: boolean }
): Promise<VirtualAuthenticator> {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const result = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            hasPrf: opts.hasPrf,
            isUserVerified: true,
            automaticPresenceSimulation: true
        }
        // The CDP typings from Playwright are loose on this domain;
        // cast to any just for the nested options bag.
    } as any)) as { authenticatorId: string };
    return { cdp, authenticatorId: result.authenticatorId };
}

async function removeVirtualAuthenticator(auth: VirtualAuthenticator): Promise<void> {
    try {
        await auth.cdp.send('WebAuthn.removeVirtualAuthenticator', {
            authenticatorId: auth.authenticatorId
        });
    } catch {
        /* best-effort cleanup */
    }
    try {
        await auth.cdp.send('WebAuthn.disable');
    } catch {
        /* best-effort cleanup */
    }
}

/**
 * Pin the preemptive PRF capability probe to `supported` before the
 * open view constructs itself. The probe normally inspects the host
 * OS/browser to decide whether to render the enable-passkey checkbox
 * at all — on a macOS 14 Sonoma CI runner or dev machine that probe
 * would report `unsupported` (Apple added PRF in macOS 15 Sequoia)
 * and hide the checkbox, breaking this spec even though the CDP
 * virtual authenticator is perfectly capable of PRF.
 *
 * The override hook is read by `passkey-capability.ts` at probe time
 * and returned verbatim, short-circuiting the OS detection logic.
 */
async function overridePasskeyCapability(page: Page): Promise<void> {
    await page.addInitScript(() => {
        (window as unknown as Record<string, unknown>)[
            '__keewebx_passkey_capability_override'
        ] = {
            prf: 'supported',
            reason: 'E2E override',
            platform: { os: 'macos', browser: 'chrome', osVersion: '15.0.0' }
        };
    });
}

/**
 * Clear localStorage + FilesCache IndexedDB so each test starts from a
 * blank slate. Matches the clean-slate pattern from crud-persistence.spec.ts
 * — essential here because FileInfo rows from test 1 would otherwise
 * leak into test 2 and make the "no passkey yet" assertion meaningless.
 */
async function resetPersistence(page: Page): Promise<void> {
    await overridePasskeyCapability(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(async () => {
        try {
            localStorage.clear();
        } catch {
            /* ignore */
        }
        try {
            const req = indexedDB.deleteDatabase('FilesCache');
            await new Promise<void>((resolve) => {
                req.onsuccess = (): void => resolve();
                req.onerror = (): void => resolve();
                req.onblocked = (): void => resolve();
            });
        } catch {
            /* ignore */
        }
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
}

/**
 * Full upload-and-unlock sequence for a local KDBX4 file. Same pattern
 * as database-open.spec.ts / crud-persistence.spec.ts. Stops AFTER the
 * password field is editable but BEFORE submitting, so the caller can
 * optionally tick the "Remember with passkey" checkbox first.
 */
async function uploadFile(page: Page): Promise<void> {
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('#open__icon-open').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(KDBX4_FILE);

    // Local file warning modal — wait for the animation to settle
    // before clicking OK, else the click can hit a still-transforming
    // button and bounce off.
    const modal = page.locator('.modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    const okButton = page.locator('.modal__buttons button[data-result="ok"]');
    await expect(okButton).toBeVisible({ timeout: 5_000 });
    await modal.evaluate((el) => {
        return new Promise<void>((resolve) => {
            const animations = el.getAnimations({ subtree: true });
            if (animations.length === 0) return resolve();
            Promise.all(animations.map((a) => a.finished)).then(() => resolve());
        });
    });
    await okButton.click();

    const passwordInput = page.locator('.open__pass-input');
    await expect(passwordInput).not.toHaveAttribute('readonly', '', { timeout: 10_000 });
}

/**
 * Wait for the fileInfo localStorage row to carry the four passkey
 * fields. `registerPasskeyForFile` in open-view.ts is fire-and-forget
 * (on purpose — keeps the UI transition snappy), so we can't await it
 * directly from the test. Instead we poll the persisted shape.
 */
async function waitForPasskeyRegistered(page: Page): Promise<void> {
    await expect(async () => {
        const raw = await page.evaluate(() => localStorage.getItem('fileInfo'));
        expect(raw, 'fileInfo localStorage row should exist after open').toBeTruthy();
        const parsed = JSON.parse(raw!) as Array<{
            name: string;
            passkeyCredentialId?: string | null;
            passkeyPrfSalt?: string | null;
            passkeyWrappedKey?: string | null;
        }>;
        const row = parsed.find((f) => f.name === KDBX4_BASENAME);
        expect(row, 'KDBX4.1 row should be in fileInfo').toBeTruthy();
        expect(
            row?.passkeyCredentialId,
            'passkeyCredentialId must be persisted after registration'
        ).toBeTruthy();
        expect(
            row?.passkeyPrfSalt,
            'passkeyPrfSalt must be persisted after registration'
        ).toBeTruthy();
        expect(
            row?.passkeyWrappedKey,
            'passkeyWrappedKey must be persisted after registration'
        ).toBeTruthy();
    }).toPass({ timeout: 20_000 });
}

test.describe('Passkey Quick Unlock (#9)', () => {
    test.beforeEach(async ({ page }) => {
        await resetPersistence(page);
    });

    test('register on second open → reload → unlock with passkey', async ({
        context,
        page
    }) => {
        test.setTimeout(180_000);

        const auth = await addVirtualAuthenticator(context, page, { hasPrf: true });

        try {
            // 1. First open — upload fresh file and open with typed
            // password. At this point `showOpenLocalFile` sets
            // `this.params.id = null`, so `hasFile` in
            // `displayOpenPasskey` is false and the enable-passkey
            // checkbox is intentionally hidden. Registration is only
            // offered starting from the SECOND open, when the file
            // carries a persistent FileInfo id assigned at first open.
            //
            // This matches the intended UX: first-time unlock is
            // password-only ("open a strange file without committing
            // to device-local binding yet"), then subsequent opens
            // offer the passkey enable toggle.
            await uploadFile(page);
            await page.locator('.open__pass-input').fill(KDBX4_PASSWORD);
            await page.locator('.open__pass-enter-btn').click();
            await expect(
                page.locator('.list__item').first(),
                'First open should succeed with typed password'
            ).toBeVisible({ timeout: 30_000 });

            // Confirm a FileInfo row was persisted (the id assigned at
            // first open is what displayOpenPasskey will later gate on).
            await expect(async () => {
                const raw = await page.evaluate(() =>
                    localStorage.getItem('fileInfo')
                );
                expect(raw).toBeTruthy();
                const parsed = JSON.parse(raw!) as Array<{ name: string }>;
                expect(parsed.some((f) => f.name === KDBX4_BASENAME)).toBe(true);
            }).toPass({ timeout: 10_000 });

            // 2. Reload to the open screen. The recent file list will
            // surface the KDBX we just opened; clicking it calls
            // `showOpenFileInfo`, which sets `params.id`. From there
            // `displayOpenPasskey` sees `hasFile` true, PRF supported,
            // no credential yet -> enable-passkey row becomes visible.
            await page.reload();
            await page.waitForLoadState('networkidle');
            await expect(page.locator('#open__icon-open')).toBeVisible({
                timeout: 15_000
            });

            const recentAfterFirstOpen = page.locator('.open__last-item').first();
            await expect(recentAfterFirstOpen).toBeVisible({ timeout: 10_000 });
            await recentAfterFirstOpen.click();

            const passwordInputAgain = page.locator('.open__pass-input');
            await expect(passwordInputAgain).not.toHaveAttribute('readonly', '', {
                timeout: 10_000
            });

            // 3. Now the checkbox row should render — second open,
            // params.id set, file lacks a passkey yet, PRF probe true.
            const checkboxRow = page.locator('.open__passkey-enable');
            await expect(
                checkboxRow,
                'Enable-passkey row should appear on second open of a file with no credential'
            ).toBeVisible({ timeout: 5_000 });

            // Click the visible label to tick the checkbox. The native
            // <input> is hidden by the global input[type='checkbox']
            // rule in base/_forms.scss; the sibling <label for=...>
            // draws the fake box via :before and is the real click
            // target. This matches what an actual user does.
            const checkbox = page.locator('.open__passkey-enable-check');
            await page.locator('.open__passkey-enable-label').click();
            await expect(checkbox).toBeChecked();

            // 4. Submit. The existing open path runs; the
            // `enablePasskeyRequested` tail fires AFTER open completes
            // and triggers navigator.credentials.create() — which the
            // virtual authenticator satisfies with a PRF-capable
            // credential.
            await passwordInputAgain.fill(KDBX4_PASSWORD);
            await page.locator('.open__pass-enter-btn').click();

            await expect(
                page.locator('.list__item').first(),
                'Second open should succeed with typed password + passkey enable requested'
            ).toBeVisible({ timeout: 30_000 });

            // 5. Wait for fire-and-forget registration to persist the
            // four passkey fields to localStorage.
            await waitForPasskeyRegistered(page);

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/passkey-01-registered.png`,
                fullPage: true
            });

            // 4. Reload: drops all in-memory state. The only way the
            // passkey button can light up after this is if the four
            // fields survived in localStorage AND the open view
            // rehydrates them into showOpenFileInfo.
            await page.reload();
            await page.waitForLoadState('networkidle');
            await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });

            // 5. Click the recent file to populate the open view with
            // the persisted FileInfo.
            const recentItem = page.locator('.open__last-item').first();
            await expect(
                recentItem,
                'Recent files list should contain the mutated file after reload'
            ).toBeVisible({ timeout: 10_000 });
            await recentItem.click();

            const rehydratedPw = page.locator('.open__pass-input');
            await expect(rehydratedPw).not.toHaveAttribute('readonly', '', {
                timeout: 10_000
            });

            // 6. With a persisted credential AND an empty password
            // field, displayOpenPasskey() should flip the button into
            // the passkey modifier state.
            const enterBtn = page.locator('.open__pass-enter-btn');
            await expect(
                enterBtn,
                'Passkey BEM modifier should be present on the enter button'
            ).toHaveClass(/open__pass-enter-btn--passkey/, { timeout: 5_000 });

            // The key-icon glyph is one of three icons inside the
            // button. We can't easily assert "only the key one is
            // visible" (SCSS controls that via CSS on the modifier
            // class, and the child elements are always in the DOM)
            // but we CAN assert the element exists.
            await expect(
                page.locator('.open__pass-enter-btn-icon-passkey'),
                'Key icon glyph should be in the DOM'
            ).toHaveCount(1);

            // And the enable-passkey checkbox row should NOT be shown
            // on a file that already has a credential.
            await expect(
                page.locator('.open__passkey-enable'),
                'Enable-passkey row should be hidden when credential is registered'
            ).toBeHidden();

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/passkey-02-reload-button-visible.png`,
                fullPage: true
            });

            // 7. Click the passkey button. The view's openDbClick
            // dispatcher checks for the --passkey modifier and routes
            // to openDbWithPasskey, which runs a PRF get() ceremony
            // via navigator.credentials.get. The virtual authenticator
            // auto-satisfies UV and returns the same PRF output as at
            // registration time (deterministic on the salt), the app
            // HKDF-derives the AES key, unwraps the master password,
            // and follows the normal open path.
            await enterBtn.click();

            await expect(
                page.locator('.list__item').first(),
                'Database should open via passkey unlock — marker for full round-trip'
            ).toBeVisible({ timeout: 30_000 });

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/passkey-03-unlocked.png`,
                fullPage: true
            });
        } finally {
            await removeVirtualAuthenticator(auth);
        }
    });

    test('PRF-incapable authenticator → unlock fails cleanly, password still works', async ({
        context,
        page
    }) => {
        test.setTimeout(120_000);

        // Step 1: register a credential normally with a PRF-capable
        // authenticator. We need a file that already has passkey state
        // to be able to click the passkey button at all.
        //
        // Same two-open pattern as test 1 — first open is typed
        // password (no enable checkbox available until params.id is
        // set by a recent-file click), reload, second open ticks the
        // enable checkbox and triggers the create() ceremony.
        const registerAuth = await addVirtualAuthenticator(context, page, {
            hasPrf: true
        });
        try {
            await uploadFile(page);
            await page.locator('.open__pass-input').fill(KDBX4_PASSWORD);
            await page.locator('.open__pass-enter-btn').click();
            await expect(page.locator('.list__item').first()).toBeVisible({
                timeout: 30_000
            });

            await page.reload();
            await page.waitForLoadState('networkidle');
            const recentFirstOpen = page.locator('.open__last-item').first();
            await expect(recentFirstOpen).toBeVisible({ timeout: 10_000 });
            await recentFirstOpen.click();

            const pwInput = page.locator('.open__pass-input');
            await expect(pwInput).not.toHaveAttribute('readonly', '', {
                timeout: 10_000
            });
            await expect(page.locator('.open__passkey-enable')).toBeVisible({
                timeout: 5_000
            });
            await page.locator('.open__passkey-enable-label').click();
            await expect(page.locator('.open__passkey-enable-check')).toBeChecked();
            await pwInput.fill(KDBX4_PASSWORD);
            await page.locator('.open__pass-enter-btn').click();
            await expect(page.locator('.list__item').first()).toBeVisible({
                timeout: 30_000
            });
            await waitForPasskeyRegistered(page);
        } finally {
            // Detach the good authenticator so only the bad one is
            // live when we try to unlock.
            await removeVirtualAuthenticator(registerAuth);
        }

        // Snapshot FileInfo BEFORE the failing unlock so we can assert
        // the fields survive a PRF failure and the user can retry.
        const fileInfoBefore = await page.evaluate(() =>
            localStorage.getItem('fileInfo')
        );
        expect(fileInfoBefore).toBeTruthy();

        // Reload to drop in-memory state, same as test 1.
        await page.reload();
        await page.waitForLoadState('networkidle');

        // Step 2: attach a PRF-less authenticator. Same credential
        // storage semantics, but evaluatePrf throws because the
        // authenticator reports no PRF extension in the assertion.
        const badAuth = await addVirtualAuthenticator(context, page, { hasPrf: false });

        try {
            const recentItem = page.locator('.open__last-item').first();
            await expect(recentItem).toBeVisible({ timeout: 10_000 });
            await recentItem.click();

            const passwordInput = page.locator('.open__pass-input');
            await expect(passwordInput).not.toHaveAttribute('readonly', '', {
                timeout: 10_000
            });

            const enterBtn = page.locator('.open__pass-enter-btn');
            await expect(enterBtn).toHaveClass(/open__pass-enter-btn--passkey/, {
                timeout: 5_000
            });

            // Click the passkey button. The CDP bad authenticator has
            // no stored credential for this RP (addVirtualAuthenticator
            // creates an empty one), so navigator.credentials.get will
            // fail with NotAllowedError. Either way, the app should
            // fall back to the password path without corrupting state.
            await enterBtn.click();

            // After the failure, the app should:
            //   - release the `busy` state
            //   - re-enable the password input
            //   - leave the user on the open screen (no list items)
            // which is exactly the fallback behavior documented in
            // openDbWithPasskey (lines 865-876 of open-view.ts).
            //
            // We assert against the observable UI: password input
            // usable, no list items visible. Error toast is allowed
            // but not required (matches Touch ID fallback UX where
            // the user silently re-focuses the password field).
            await expect(async () => {
                const itemsCount = await page.locator('.list__item').count();
                expect(itemsCount, 'DB should NOT have opened via failed passkey').toBe(0);
                const hasReadonly = await passwordInput.getAttribute('readonly');
                // readonly attr may or may not be re-set during the
                // failure; what we care about is that the disabled
                // flag is cleared so the user can type.
                const isDisabled = await passwordInput.getAttribute('disabled');
                expect(isDisabled, 'Password input should not be disabled after failure').toBeNull();
                // Silence unused var warning when hasReadonly is non-null:
                void hasReadonly;
            }).toPass({ timeout: 15_000 });

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/passkey-04-prf-fallback.png`,
                fullPage: true
            });

            // Fall back to typing the password — the full flow should
            // still work, proving the failed passkey attempt didn't
            // corrupt the file or brick the open screen.
            await passwordInput.fill(KDBX4_PASSWORD);
            // NB: the button is now in --passkey modifier state AND
            // the password is non-empty. displayOpenPasskey toggles
            // the modifier off when passEmpty is false, but it only
            // runs on 'input' events. We click through the normal
            // path — openDbClick's dispatcher re-checks the class list
            // at click time, and typing fires 'input' so the modifier
            // should have been removed already.
            //
            // Fire an input event to force the check, then submit.
            await passwordInput.dispatchEvent('input');
            await page.locator('.open__pass-enter-btn').click();

            await expect(
                page.locator('.list__item').first(),
                'Password fallback must still open the database after a failed passkey attempt'
            ).toBeVisible({ timeout: 30_000 });

            // After a password-fallback re-open, assert that the
            // FileInfo row still exists AND that the four passkey
            // descriptor fields survived the reconstruction inside
            // `addToLastOpenFiles`. This is the Round-3 P1 regression
            // guard for #9: without the carry-forward block in
            // app-model.ts, every fallback open wiped the passkey
            // registration (the new FileInfoModel defaults all four
            // fields to null, and `this.fileInfos.remove(file.id)`
            // drops the old row), forcing users to re-enroll on any
            // password-typed open. The fix copies the fields from
            // the pre-existing fileInfo row before the remove/unshift.
            //
            // We compare "after" against "before" so the test catches
            // both a total wipe (nulls) and a partial corruption
            // (different bytes) — either is a regression.
            const fileInfoAfter = await page.evaluate(() =>
                localStorage.getItem('fileInfo')
            );
            expect(fileInfoAfter).toBeTruthy();
            const after = JSON.parse(fileInfoAfter!) as Array<{
                name: string;
                passkeyCredentialId?: string | null;
                passkeyPrfSalt?: string | null;
                passkeyWrappedKey?: string | null;
                passkeyCreatedDate?: string | null;
            }>;
            const afterRow = after.find((f) => f.name === KDBX4_BASENAME);
            expect(
                afterRow,
                'FileInfo row for the fallback-opened file must still exist'
            ).toBeTruthy();

            // Parse the pre-fallback snapshot so we can compare each
            // of the four passkey descriptor fields field-by-field.
            expect(fileInfoBefore).toBeTruthy();
            const before = JSON.parse(fileInfoBefore!) as Array<{
                name: string;
                passkeyCredentialId?: string | null;
                passkeyPrfSalt?: string | null;
                passkeyWrappedKey?: string | null;
                passkeyCreatedDate?: string | null;
            }>;
            const beforeRow = before.find((f) => f.name === KDBX4_BASENAME);
            expect(beforeRow, 'Pre-fallback FileInfo row must exist').toBeTruthy();

            expect(
                afterRow?.passkeyCredentialId,
                'passkeyCredentialId must survive password-fallback re-open (#9 carry-forward)'
            ).toBe(beforeRow?.passkeyCredentialId);
            expect(
                afterRow?.passkeyPrfSalt,
                'passkeyPrfSalt must survive password-fallback re-open (#9 carry-forward)'
            ).toBe(beforeRow?.passkeyPrfSalt);
            expect(
                afterRow?.passkeyWrappedKey,
                'passkeyWrappedKey must survive password-fallback re-open (#9 carry-forward)'
            ).toBe(beforeRow?.passkeyWrappedKey);
            expect(
                afterRow?.passkeyCreatedDate,
                'passkeyCreatedDate must survive password-fallback re-open (#9 carry-forward)'
            ).toBe(beforeRow?.passkeyCreatedDate);
            expect(
                afterRow?.passkeyCredentialId,
                'passkeyCredentialId must still be non-null after fallback'
            ).toBeTruthy();

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/passkey-05-password-fallback-ok.png`,
                fullPage: true
            });
        } finally {
            await removeVirtualAuthenticator(badAuth);
        }
    });

    test('PRF-incapable authenticator at register → toast + nothing persisted', async ({
        context,
        page
    }) => {
        // Round-5 regression guard for the strict `prf.enabled === true`
        // check in passkey-prf.ts. Reproduces the Chrome bug the user
        // hit in real testing: an authenticator (or a hooking
        // browser password-manager extension on Firefox) signs the
        // credential but does NOT enable PRF. Pre-fix behaviour was
        // to silently fall through and try to rescue with a get()
        // call, leaving a garbage credential persisted on FileInfo
        // and surfacing the cryptic "did not return a PRF result"
        // error. Post-fix: throw `PasskeyPrfNotSupportedError`
        // immediately, show the actionable toast, and do not write
        // any of the four passkey fields to FileInfoModel.
        test.setTimeout(120_000);

        const auth = await addVirtualAuthenticator(context, page, { hasPrf: false });

        try {
            // First open with typed password — same two-open pattern
            // as test 1, because the enable checkbox only appears on
            // the second open of a file with a persisted FileInfo id.
            await uploadFile(page);
            await page.locator('.open__pass-input').fill(KDBX4_PASSWORD);
            await page.locator('.open__pass-enter-btn').click();
            await expect(page.locator('.list__item').first()).toBeVisible({
                timeout: 30_000
            });

            // Reload to drop in-memory state and trigger the
            // recent-files path so the enable checkbox shows up.
            await page.reload();
            await page.waitForLoadState('networkidle');
            const recentItem = page.locator('.open__last-item').first();
            await expect(recentItem).toBeVisible({ timeout: 10_000 });
            await recentItem.click();

            const pwInput = page.locator('.open__pass-input');
            await expect(pwInput).not.toHaveAttribute('readonly', '', {
                timeout: 10_000
            });

            // Enable-passkey checkbox should be visible because the
            // file has no passkey yet AND `isPasskeyPrfSupported()`
            // returns true (PublicKeyCredential exists). The fact
            // that the underlying authenticator can't actually do
            // PRF is something we can only learn from the
            // `prf.enabled` field after `create()` runs — exactly
            // what the strict check is testing.
            await expect(page.locator('.open__passkey-enable')).toBeVisible({
                timeout: 5_000
            });
            await page.locator('.open__passkey-enable-label').click();
            await expect(page.locator('.open__passkey-enable-check')).toBeChecked();

            // Submit. Open succeeds (typed password is correct), the
            // fire-and-forget `registerPasskeyForFile` tail kicks
            // off, the `create()` call returns a credential with
            // `prf.enabled === undefined` (the bad authenticator
            // doesn't speak PRF), and the strict check throws
            // `PasskeyPrfNotSupportedError`. The view's catch block
            // surfaces the actionable toast.
            await pwInput.fill(KDBX4_PASSWORD);
            await page.locator('.open__pass-enter-btn').click();

            // Database opens — the failure is in the post-open
            // registration tail, NOT in the open itself.
            await expect(page.locator('.list__item').first()).toBeVisible({
                timeout: 30_000
            });

            // Wait for the alerts.error toast to appear. The header
            // is `loc.openError` and the body contains the actionable
            // string from `loc.openPasskeyPrfUnsupported` ("PRF
            // extension needed for passkey unlock").
            const modal = page.locator('.modal').filter({
                hasText: /PRF extension needed for passkey unlock/i
            });
            await expect(
                modal,
                'PRF-unsupported toast should explain the actionable fix to the user'
            ).toBeVisible({ timeout: 15_000 });

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/passkey-07-prf-register-toast.png`,
                fullPage: true
            });

            // Critical assertion: nothing was persisted to FileInfo.
            // The strict check throws BEFORE
            // `registerPasskeyForFile` reaches the `fileInfo.set(...)`
            // call, so all four passkey fields remain null on the
            // localStorage row. Without this guarantee the next open
            // would surface the broken passkey button instead of the
            // enable-checkbox row.
            const raw = await page.evaluate(() =>
                localStorage.getItem('fileInfo')
            );
            expect(raw).toBeTruthy();
            const parsed = JSON.parse(raw!) as Array<{
                name: string;
                passkeyCredentialId?: string | null;
                passkeyPrfSalt?: string | null;
                passkeyWrappedKey?: string | null;
                passkeyCreatedDate?: string | null;
            }>;
            const row = parsed.find((f) => f.name === KDBX4_BASENAME);
            expect(
                row,
                'FileInfo row must still exist after a failed passkey enable'
            ).toBeTruthy();
            expect(
                row?.passkeyCredentialId ?? null,
                'passkeyCredentialId must NOT be persisted when PRF is refused'
            ).toBeNull();
            expect(
                row?.passkeyPrfSalt ?? null,
                'passkeyPrfSalt must NOT be persisted when PRF is refused'
            ).toBeNull();
            expect(
                row?.passkeyWrappedKey ?? null,
                'passkeyWrappedKey must NOT be persisted when PRF is refused'
            ).toBeNull();
            expect(
                row?.passkeyCreatedDate ?? null,
                'passkeyCreatedDate must NOT be persisted when PRF is refused'
            ).toBeNull();
        } finally {
            await removeVirtualAuthenticator(auth);
        }
    });

    test('No WebAuthn support → enable-passkey checkbox never renders', async ({
        browser
    }) => {
        // Create a fresh context that pretends WebAuthn does not exist
        // at all. We do this via page.addInitScript BEFORE any page
        // script runs, so `isPasskeyPrfSupported()` (which runs at
        // OpenView construction) sees a world with no
        // PublicKeyCredential and returns false. Same outcome as
        // current Firefox stable without the PRF flag.
        const context = await browser.newContext();
        await context.addInitScript(() => {
            // `delete` would throw on a non-configurable accessor, so
            // we stub defineProperty-style to force undefined. The
            // open-view check is `typeof PublicKeyCredential === 'undefined'`
            // which evaluates against the global scope name, so
            // overriding the window property is sufficient.
            try {
                Object.defineProperty(window, 'PublicKeyCredential', {
                    configurable: true,
                    get() {
                        return undefined;
                    }
                });
            } catch {
                /* ignore */
            }
            // Also nuke navigator.credentials so the extra guards in
            // passkey-prf.ts evaluate to false too — belt-and-braces.
            try {
                Object.defineProperty(navigator, 'credentials', {
                    configurable: true,
                    get() {
                        return undefined;
                    }
                });
            } catch {
                /* ignore */
            }
        });

        const page = await context.newPage();
        try {
            await resetPersistence(page);
            await uploadFile(page);

            // The checkbox row should NOT be rendered — when
            // `passkeyAvailable` is false at construction time, the
            // Handlebars `{{#if passkeyAvailable}}` block omits the
            // element entirely, so the locator count is zero.
            //
            // We intentionally assert count=0 rather than toBeHidden,
            // because toBeHidden would also match a hidden-with-class
            // element, and the whole point of the feature gate is that
            // the DOM node is never emitted in the first place.
            await expect(
                page.locator('.open__passkey-enable'),
                'Enable-passkey row should NOT be in the DOM when PRF is unsupported'
            ).toHaveCount(0);

            // And the button modifier should never appear.
            const enterBtn = page.locator('.open__pass-enter-btn');
            await expect(enterBtn).not.toHaveClass(/open__pass-enter-btn--passkey/);

            await page.screenshot({
                path: `${SCREENSHOT_DIR}/passkey-06-feature-gate-hidden.png`,
                fullPage: true
            });
        } finally {
            await page.close();
            await context.close();
        }
    });
});
