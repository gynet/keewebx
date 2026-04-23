import { test, expect, Page } from '@playwright/test';
import path from 'path';

/**
 * Persistence regression guard for the SettingsStore + FileInfoCollection
 * path (2026-04-09 warroom). The regression class this test catches:
 *
 *   - User uploads a .kdbx file.
 *   - The file BYTES are cached to IndexedDB `FilesCache`.
 *   - The file METADATA (`fileInfos`) should be saved via SettingsStore
 *     to `localStorage.fileInfo`, so the open screen can render the
 *     recent-files list on the next visit.
 *   - Bug: `SettingsStore.save` was stubbed to `Promise.resolve()`, so
 *     the metadata was dropped. Refresh -> orphaned IDB data, no
 *     recent-files entry, user perceives "data gone".
 *
 * This spec reproduces the full upload -> reload -> recent-file ->
 * reopen flow and asserts that the recent-files list survives the
 * reload. If SettingsStore regresses to a stub, `.open__last-item`
 * will be missing after the reload and this test will fail.
 *
 * Upload pattern is copied from `e2e/core/import.spec.ts` — the
 * `fileChooser` event must be registered BEFORE clicking the Open
 * button. See #4 reviewer guidance.
 */

const SCREENSHOT_DIR = 'e2e/screenshots';

const KDBX4_FILE = path.resolve(
    __dirname,
    '../../packages/db/resources/KDBX4.1.kdbx'
);
const KDBX4_PASSWORD = 'test';
const KDBX4_BASENAME = 'KDBX4.1';

/**
 * Open the local-file chooser and dismiss the "local file" warning
 * modal. Returns once the password input is editable. Mirrors the
 * helper in import.spec.ts so behavior stays consistent.
 */
async function uploadAndUnlock(page: Page): Promise<void> {
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('#open__icon-open').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(KDBX4_FILE);

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
    await passwordInput.fill(KDBX4_PASSWORD);
    await page.locator('.open__pass-enter-btn').click();

    // Wait for the file to be open — entries visible means decrypt +
    // parse + render all succeeded.
    await expect(page.locator('.list__item').first()).toBeVisible({ timeout: 30_000 });
}

test.describe('Persistence across reload (SettingsStore regression guard)', () => {
    test.beforeEach(async ({ page }) => {
        // Start each test from a clean slate so accumulated state
        // from prior runs doesn't mask a regression. `localStorage`
        // is where fileInfos lives now, and IndexedDB `FilesCache`
        // holds the bytes; both must be cleared.
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

    test('upload -> reload -> recent files list is populated', async ({ page }) => {
        test.setTimeout(60_000);

        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });
        await uploadAndUnlock(page);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/persistence-01-after-upload.png`,
            fullPage: true
        });

        // Sanity check: the entries loaded from the real database.
        const entries = page.locator('.list__item');
        const entriesBefore = await entries.count();
        expect(entriesBefore).toBeGreaterThan(0);

        // Verify the fileInfos metadata was written to localStorage.
        // This is the exact key the SettingsStore uses after
        // camelCase-ing 'file-info'. The regression being guarded
        // against is "this key is missing or empty after save()".
        const storedFileInfo = await page.evaluate(() => localStorage.getItem('fileInfo'));
        expect(
            storedFileInfo,
            'localStorage.fileInfo should be written by SettingsStore.save("file-info", ...)'
        ).toBeTruthy();
        // Should be parseable JSON, not the empty array, with the
        // uploaded file present.
        const parsed = JSON.parse(storedFileInfo!) as { name: string }[];
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBeGreaterThanOrEqual(1);
        expect(parsed.some((f) => f.name === KDBX4_BASENAME)).toBe(true);

        // Reload. The open screen should render with the recent
        // files list populated from localStorage + FilesCache.
        await page.reload();
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });

        const recentItems = page.locator('.open__last-item');
        await expect(
            recentItems.first(),
            'After reload, recent files list must be populated from SettingsStore + FilesCache'
        ).toBeVisible({ timeout: 10_000 });
        const recentText = await recentItems.first().locator('.open__last-item-text').innerText();
        expect(recentText).toBe(KDBX4_BASENAME);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/persistence-02-after-reload.png`,
            fullPage: true
        });
    });

    test('upload -> reload -> click recent file -> reopen from cache', async ({ page }) => {
        test.setTimeout(60_000);

        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });
        await uploadAndUnlock(page);

        // Confirm initial open worked.
        await expect(page.locator('.list__item').first()).toBeVisible();

        await page.reload();
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });

        // Click the recent file entry. OpenView.openLast -> showOpenFileInfo
        // prefills the form; the user then re-enters the password.
        const recentItem = page.locator('.open__last-item').first();
        await expect(recentItem).toBeVisible({ timeout: 10_000 });
        await recentItem.click();

        const passwordInput = page.locator('.open__pass-input');
        await expect(passwordInput).not.toHaveAttribute('readonly', '', { timeout: 10_000 });
        await passwordInput.fill(KDBX4_PASSWORD);
        await page.locator('.open__pass-enter-btn').click();

        // Entries visible means the cached bytes + metadata both
        // round-tripped successfully.
        const listItems = page.locator('.list__item');
        await expect(listItems.first()).toBeVisible({ timeout: 30_000 });
        const count = await listItems.count();
        expect(count).toBeGreaterThan(0);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/persistence-03-reopened-from-cache.png`,
            fullPage: true
        });
    });
});
