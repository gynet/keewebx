import { test, expect, Page } from '@playwright/test';

/**
 * Database round-trip E2E.
 *
 * This is the only E2E test that exercises the full KDBX4 encrypt/decrypt
 * crypto stack in the browser:
 *
 *   XML serialize -> GZip -> HMAC block -> ChaCha20 -> KDF -> blob
 *     -> download -> reload page -> file chooser -> KDF -> ChaCha20
 *     -> HMAC verify -> GZip inflate -> XML parse -> entry read
 *
 * If any of these layers break, the unique marker written before save
 * will not be readable after reopen, and the test fails.
 *
 * Flow:
 *   1. Open the demo database (no password)
 *   2. Edit the first entry title to a unique marker
 *   3. Navigate to file settings via the footer DB item
 *   4. Set a master password (required for saveToFile)
 *   5. Click "Save to file" — triggers Blob download via <a download>
 *   6. Capture the downloaded KDBX bytes via Playwright download event
 *   7. page.reload() — this is ESSENTIAL; clears all in-memory state
 *   8. Open the downloaded KDBX via file chooser with the same password
 *   9. Assert the list contains an entry whose title matches the marker
 */

const SCREENSHOT_DIR = 'e2e/screenshots';

const MASTER_PASSWORD = 'e2e-roundtrip-pass';

async function openDemoDatabase(page: Page) {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const demoBtn = page.locator('#open__icon-demo');
    await expect(demoBtn).toBeVisible({ timeout: 15_000 });
    await demoBtn.click();
    const listItems = page.locator('.list__item');
    await expect(listItems.first()).toBeVisible({ timeout: 30_000 });
    return listItems;
}

async function editFirstEntryTitle(page: Page, newTitle: string) {
    const listItems = page.locator('.list__item');
    await listItems.first().click();

    const detailsView = page.locator('.details');
    await expect(detailsView).toBeVisible({ timeout: 10_000 });

    const headerTitle = page.locator('.details__header-title');
    await expect(headerTitle).toBeVisible();
    await headerTitle.click();

    const titleInput = page.locator('.details__header-title-input');
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await titleInput.fill(newTitle);
    await titleInput.press('Enter');

    // Verify the edit took effect in the list.
    const listItemTitle = listItems.first().locator('.list__item-title');
    await expect(listItemTitle).toContainText(newTitle);
}

async function openFileSettings(page: Page) {
    // The footer has one .footer__db-item per open file. Clicking it emits
    // 'show-file' which routes to AppView.showFileSettings -> renders the
    // Settings -> File panel.
    const dbItem = page.locator('.footer__db-item').first();
    await expect(dbItem).toBeVisible({ timeout: 5_000 });
    await dbItem.click();

    // Wait for the file settings panel to render. settings-file.hbs does not
    // have a top-level .settings__file class, but it is the only page that
    // contains #settings__file-master-pass, so use that as the panel anchor.
    const fileSettingsPanel = page.locator('#settings__file-master-pass');
    await expect(fileSettingsPanel).toBeVisible({ timeout: 10_000 });
}

async function setMasterPassword(page: Page, password: string) {
    // Focus the master password input — this clears the placeholder.
    const masterPassInput = page.locator('#settings__file-master-pass');
    await expect(masterPassInput).toBeVisible({ timeout: 5_000 });
    await masterPassInput.focus();

    // Type the new password (triggers input -> shows confirm field).
    await masterPassInput.fill(password);

    // Confirm password group becomes visible after first keystroke.
    const confirmGroup = page.locator('#settings__file-confirm-master-pass-group');
    await expect(confirmGroup).toBeVisible({ timeout: 5_000 });

    // Fill and blur the confirm field — this commits via setPassword().
    const confirmInput = page.locator('#settings__file-confirm-master-pass');
    await confirmInput.focus();
    await confirmInput.fill(password);
    // blur to commit
    await confirmInput.press('Tab');
}

test.describe('Database round-trip (full KDBX4 crypto stack)', () => {
    test('edit entry -> save -> reload -> reopen -> marker persists', async ({ page }) => {
        // Save + reload + KDF (argon2 for demo db) can take a while in CI.
        test.setTimeout(120_000);

        const marker = `E2E-ROUNDTRIP-${Date.now()}`;

        // Step 1: open demo db
        await openDemoDatabase(page);

        // Step 2: edit first entry title
        await editFirstEntryTitle(page, marker);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/roundtrip-01-edited.png`,
            fullPage: true,
        });

        // Step 3: open file settings
        await openFileSettings(page);

        // Step 4: set master password
        await setMasterPassword(page, MASTER_PASSWORD);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/roundtrip-02-password-set.png`,
            fullPage: true,
        });

        // Step 5: click "Save to" chooser -> "Save to file" to trigger download.
        // The demo database has no storage, so saveDefault() would route via
        // syncFile which is not what we want. Instead we use the explicit
        // "Save to..." button which reveals the chooser, then pick "file".
        const saveChooseBtn = page.locator('.settings__file-button-save-choose');
        await expect(saveChooseBtn).toBeVisible({ timeout: 5_000 });
        await saveChooseBtn.click();

        const saveToFileBtn = page.locator('.settings__file-save-to-file').first();
        await expect(saveToFileBtn).toBeVisible({ timeout: 5_000 });

        // The save flow is: validatePassword -> getData (encrypt) ->
        // FileSaver.saveAs (creates <a download href=blob:...> and clicks).
        // Playwright catches that as a download event.
        const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 60_000 }),
            saveToFileBtn.click(),
        ]);

        // Capture the downloaded bytes into a Node Buffer.
        const downloadPath = await download.path();
        expect(downloadPath).toBeTruthy();

        const fs = await import('node:fs/promises');
        const kdbxBytes = await fs.readFile(downloadPath!);

        // Sanity-check: a real KDBX4 file starts with the KeePass magic bytes.
        // Signature1 = 0x9AA2D903, Signature2 = 0xB54BFB67 (little-endian).
        expect(kdbxBytes.length).toBeGreaterThan(100);
        expect(kdbxBytes[0]).toBe(0x03);
        expect(kdbxBytes[1]).toBe(0xd9);
        expect(kdbxBytes[2]).toBe(0xa2);
        expect(kdbxBytes[3]).toBe(0x9a);
        expect(kdbxBytes[4]).toBe(0x67);
        expect(kdbxBytes[5]).toBe(0xfb);
        expect(kdbxBytes[6]).toBe(0x4b);
        expect(kdbxBytes[7]).toBe(0xb5);

        // Step 6: page.reload() — ESSENTIAL. This clears every in-memory
        // KDBX state so the subsequent open has to exercise the full
        // decrypt path from raw bytes.
        await page.reload();
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#open__icon-open')).toBeVisible({ timeout: 15_000 });

        // Step 7: feed the downloaded bytes back via file chooser.
        const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.locator('#open__icon-open').click(),
        ]);
        await fileChooser.setFiles({
            name: 'roundtrip.kdbx',
            mimeType: 'application/octet-stream',
            buffer: kdbxBytes,
        });

        // Dismiss the "local file" warning modal.
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

        // Step 8: enter the password and open.
        const passwordInput = page.locator('.open__pass-input');
        await expect(passwordInput).not.toHaveAttribute('readonly', '', { timeout: 10_000 });
        await passwordInput.fill(MASTER_PASSWORD);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/roundtrip-03-reopen-password.png`,
            fullPage: true,
        });

        // The demo database uses Argon2id which is slow; give it plenty of
        // time to derive the key in the browser.
        await page.locator('.open__pass-enter-btn').click();

        // Step 9: wait for list to repopulate and find the marker entry.
        const reopenedList = page.locator('.list__item');
        await expect(reopenedList.first()).toBeVisible({ timeout: 60_000 });

        // The marker is unique; there must be at least one item whose title
        // matches. We locate it explicitly to prove the XML payload survived
        // the round-trip intact.
        const markerEntry = page
            .locator('.list__item')
            .filter({ hasText: marker })
            .first();
        await expect(markerEntry).toBeVisible({ timeout: 10_000 });

        // Also click it and check the details view shows the same title —
        // this proves the entry model deserialized correctly, not just a
        // list index happened to match.
        await markerEntry.click();
        const reopenedTitle = page.locator('.details__header-title');
        await expect(reopenedTitle).toContainText(marker, { timeout: 10_000 });

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/roundtrip-04-marker-verified.png`,
            fullPage: true,
        });
    });
});
