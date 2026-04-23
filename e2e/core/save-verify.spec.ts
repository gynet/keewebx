import { test, expect, Page } from '@playwright/test';
import path from 'path';

/**
 * Regression guard for the 2026-04-22 P0 bug: with
 * "Verify file integrity after save" enabled, saving an edited entry
 * showed the footer sync spinner forever and never cleared.
 *
 * Root cause was the combination of:
 *   - verifySavedData in app-model.ts re-runs Kdbx.load with the file's
 *     own credentials, which requires a second Argon2 pass in a fresh
 *     web worker (kdbxweb-init.ts terminates the worker after every
 *     hash, so every hash spins up a new worker)
 *   - no top-level timeout around the verify promise: if the Argon2
 *     worker dies silently, the promise never resolves, complete()
 *     never fires, setSyncComplete() never runs, and file.syncing stays
 *     `true` indefinitely — which is what drives the footer spinner.
 *
 * The fix wraps Kdbx.load in a 30s timeout + a Promise.resolve() shield
 * that converts any synchronous throw (e.g. bad credential shape) into
 * a clean async rejection. The sync state can no longer be stranded.
 *
 * This test drives the exact same UI path a real user hits:
 *   1. Upload a real KDBX4 fixture
 *   2. Unlock with the known password
 *   3. Open Settings → General, toggle "Verify file integrity after
 *      save" to the opposite of default, then back to ON (saveVerify
 *      default IS `true` per default-app-settings.ts:148, so we exercise
 *      the toggle and leave it ON).
 *   4. Edit an entry (creating a new entry is the simplest mutation)
 *   5. Trigger save via the File settings panel
 *   6. Assert the footer sync spinner clears within 10s.
 *
 * Note: for a locally-uploaded file, `file.storage` is null, which
 * routes syncFile through the "Local, save to cache" branch
 * (app-model.ts:1297-1314). That branch does NOT call verifySavedData.
 * So this test alone does NOT cover the verify-path bug. It does
 * regression-guard the broader "save completes cleanly regardless of
 * the saveVerify setting" invariant. A companion test covering the
 * WebDAV / remote-storage branch (where verifySavedData actually runs)
 * is tracked separately — it requires either a real WebDAV endpoint
 * or a storage-provider stub that we cannot inject from an E2E shell
 * today without appModel being exposed on window (it isn't).
 */

const KDBX4_FILE = path.resolve(
    __dirname,
    '../../packages/db/resources/KDBX4.1.kdbx'
);
const KDBX4_PASSWORD = 'test';

async function uploadAndUnlock(page: Page): Promise<void> {
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('#open__icon-open').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(KDBX4_FILE);

    const modal = page.locator('.modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    const okButton = page.locator('.modal__buttons button[data-result="ok"]');
    await expect(okButton).toBeVisible({ timeout: 5_000 });
    await modal.evaluate((el: Element) => {
        return new Promise<void>((resolve) => {
            const animations = (el as HTMLElement).getAnimations({ subtree: true });
            if (animations.length === 0) return resolve();
            Promise.all(animations.map((a) => a.finished)).then(() => resolve());
        });
    });
    await okButton.click();

    const passwordInput = page.locator('.open__pass-input');
    await expect(passwordInput).not.toHaveAttribute('readonly', '', {
        timeout: 10_000
    });
    await passwordInput.fill(KDBX4_PASSWORD);
    await page.locator('.open__pass-enter-btn').click();

    await expect(page.locator('.list__item').first()).toBeVisible({
        timeout: 30_000
    });
}

test.describe('save-verify regression guard', () => {
    test.beforeEach(async ({ page }) => {
        // Clean slate: drop any residual fileInfos / FilesCache so the
        // recent-files list can't feed a stale state into the unlock path.
        // Same pattern as crud-persistence.spec.ts.
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
    });

    test('edit entry → save with saveVerify toggled ON → spinner clears within 10s', async ({
        page
    }) => {
        test.setTimeout(90_000);

        await expect(page.locator('#open__icon-open')).toBeVisible({
            timeout: 15_000
        });
        await uploadAndUnlock(page);

        // Navigate to Settings → General and exercise the saveVerify
        // checkbox. We flip it OFF then back ON so the test would catch
        // a regression in the change-handler wiring too (not just the
        // backend save pipeline). Default value is TRUE per
        // const/default-app-settings.ts:148, so after the flip we are
        // back at the default state but have demonstrated the toggle
        // actually binds to the underlying setting.
        //
        // Footer selectors: see footer-view.ts:18-23. `.footer__btn-
        // settings` is the gear icon that routes to General settings.
        // General is the default-active tab (menu-model.ts:105-112).
        await page.locator('.footer__btn-settings').click();
        // The input itself is styled `visibility: hidden` via the
        // .settings__input class (see base/_inputs.scss) — the visible
        // toggle UI is the paired <label>. Playwright's `.check()` /
        // `.uncheck()` can still drive a hidden input when invoked on
        // the label with `{ force: true }`. Simpler pattern: click the
        // label which dispatches the change event (same path as a user
        // clicking the visual toggle).
        const saveVerifyCheckbox = page.locator(
            '#settings__general-save-verify'
        );
        const saveVerifyLabel = page.locator(
            'label[for="settings__general-save-verify"]'
        );
        await expect(saveVerifyLabel).toBeVisible({ timeout: 10_000 });
        // Default value is TRUE (const/default-app-settings.ts:148).
        await expect(saveVerifyCheckbox).toBeChecked();
        // Flip off, then on — exercises the change-handler wiring.
        await saveVerifyLabel.click();
        await expect(saveVerifyCheckbox).not.toBeChecked();
        await saveVerifyLabel.click();
        await expect(saveVerifyCheckbox).toBeChecked();

        // Return to the DB entries view. Clicking the settings gear
        // again toggles settings OFF (see app-view.ts toggle-settings
        // event handler).
        await page.locator('.footer__btn-settings').click();

        // CREATE a new entry as the mutation that dirties the file.
        await expect(page.locator('.list__search-btn-new')).toBeVisible({
            timeout: 10_000
        });
        await page.locator('.list__search-btn-new').click();
        await expect(page.locator('.dropdown')).toBeVisible({ timeout: 5_000 });
        await page.locator('.dropdown__item[data-value="entry"]').click();

        const titleInput = page.locator('.details__header-title-input');
        await expect(titleInput).toBeVisible({ timeout: 5_000 });
        const marker = `SAVE-VERIFY-${Date.now()}`;
        await titleInput.fill(marker);
        await titleInput.press('Enter');

        await expect(
            page.locator('.list__item').filter({ hasText: marker })
        ).toBeVisible({ timeout: 5_000 });

        // Trigger save via the footer DB item → Settings/File panel →
        // default save button. Same UI path crud-persistence.spec.ts
        // uses — ends in appModel.syncFile → Storage.cache.save.
        const dbItem = page.locator('.footer__db-item').first();
        await expect(dbItem).toBeVisible({ timeout: 5_000 });
        await dbItem.click();

        const saveBtn = page.locator('.settings__file-button-save-default');
        await expect(saveBtn).toBeVisible({ timeout: 10_000 });

        const tStart = Date.now();
        await saveBtn.click();

        // Core assertion: the footer dirty dot (.footer__db-sign) must
        // disappear within 10s. If the save-verify regression returns,
        // this element will remain visible forever because
        // file.syncing never flips back to false.
        await expect(async () => {
            const dirtyCount = await page.locator('.footer__db-sign').count();
            expect(
                dirtyCount,
                'footer sync dirty indicator should clear within 10s after save with saveVerify ON'
            ).toBe(0);
        }).toPass({ timeout: 10_000 });

        const elapsed = Date.now() - tStart;
        // Sanity check: save completed in a reasonable window. Argon2
        // can legitimately take a couple of seconds on slow hardware,
        // but "forever" was the original bug so the 10s cap above is
        // the real guard. This informational log surfaces regressions
        // that add latency without fully stranding the spinner.
        // eslint-disable-next-line no-console
        console.log(`save-verify spinner cleared in ${elapsed}ms`);
    });
});
