import { test, expect } from '@playwright/test';

/**
 * Post-deploy live verification against https://keewebx.app (SHA a2efa14).
 * Uses soft assertions so we collect ALL failures in one pass.
 */

const LIVE_URL = 'https://keewebx.app/';

test.describe('live post-deploy verify', () => {
    test('full sweep on live', async ({ page }) => {
        test.setTimeout(240_000);

        const consoleMessages: string[] = [];
        page.on('console', (msg) => {
            consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
        });

        await page.goto(LIVE_URL, { waitUntil: 'networkidle' });

        // --- 1. Open demo DB, open settings ---
        const demoBtn = page.locator('#open__icon-demo');
        await expect(demoBtn).toBeVisible({ timeout: 20_000 });
        await demoBtn.click();

        await expect(page.locator('.list__item').first()).toBeVisible({
            timeout: 60_000
        });

        const cog = page.locator('#footer__btn-settings');
        await expect(cog).toBeVisible({ timeout: 10_000 });
        await cog.click();

        // Wait for the settings menu to render.
        await expect(page.locator('.menu__item-title:visible').first()).toBeVisible({
            timeout: 10_000
        });

        // Gather all visible sidebar titles & log them.
        const allVisibleTitles = await page
            .locator('.menu__item-title:visible')
            .allTextContents();
        console.log('SIDEBAR_TITLES=' + JSON.stringify(allVisibleTitles));
        await page.screenshot({
            path: 'test-results/live-01-sidebar-double-file.png',
            fullPage: false
        });

        const fileCount = allVisibleTitles.filter(
            (t) => t.trim() === 'File'
        ).length;
        const demoLike = allVisibleTitles.filter((t) =>
            /^Demo(\.kdbx)?$/i.test(t.trim())
        );

        // --- 1a. Exactly one "File" entry ---
        expect
            .soft(
                fileCount,
                `Expected exactly ONE visible sidebar entry "File". All visible titles: ${JSON.stringify(
                    allVisibleTitles
                )}`
            )
            .toBe(1);

        // --- 1b. No sidebar entry is the filename "Demo" ---
        expect
            .soft(
                demoLike,
                'No sidebar entry should be the filename "Demo"'
            )
            .toEqual([]);

        // --- 2. File settings page renders when "File" is clicked ---
        // Click the first visible "File" entry.
        const fileEntry = page
            .locator('.menu__item-title:visible')
            .filter({ hasText: /^File$/ })
            .first();
        await fileEntry.click();

        const masterPass = page.locator('#settings__file-master-pass');
        let masterPassVisible = false;
        try {
            await expect(masterPass).toBeVisible({ timeout: 10_000 });
            masterPassVisible = true;
        } catch {
            masterPassVisible = false;
        }
        expect
            .soft(
                masterPassVisible,
                '#settings__file-master-pass should be visible after clicking "File"'
            )
            .toBe(true);

        // --- 3. No KDBX3 / AES / Salsa20 / AES-KDF controls ---
        const selectOptionTexts = await page
            .locator('select option')
            .allTextContents();
        const labelTexts = await page.locator('label').allTextContents();

        console.log('SELECT_OPTIONS=' + JSON.stringify(selectOptionTexts));
        console.log('LABELS=' + JSON.stringify(labelTexts));
        await page.screenshot({
            path: 'test-results/live-02-file-settings-kdbx3-aes.png',
            fullPage: true
        });

        // Scroll the File Format dropdown into view and open it, then
        // capture the AES/KDBX3 options.
        const formatSelects = page.locator('select');
        const n = await formatSelects.count();
        for (let i = 0; i < n; i++) {
            const opts = await formatSelects
                .nth(i)
                .locator('option')
                .allTextContents();
            if (opts.some((o) => /KDBX\s*3/i.test(o))) {
                await formatSelects.nth(i).scrollIntoViewIfNeeded();
                await page.screenshot({
                    path: 'test-results/live-02b-kdbx-format-select.png',
                    fullPage: false
                });
                break;
            }
        }

        const forbidden = /AES-KDF|Salsa|KDBX.*3|AES(?!.*GCM)/i;
        const offendingOptions = selectOptionTexts.filter((t) =>
            forbidden.test(t)
        );
        const offendingLabels = labelTexts.filter((t) => forbidden.test(t));

        expect
            .soft(
                { offendingOptions, offendingLabels },
                'No KDBX3 / AES / Salsa20 / AES-KDF controls must appear'
            )
            .toEqual({ offendingOptions: [], offendingLabels: [] });

        // --- 4. Save via footer DB click → File settings save button ---
        // Cmd+S is swallowed by headless Chromium (native "Save Page As"
        // interception). Use the same save path as save-verify.spec.ts:
        // footer DB item → File settings → save button. save-verify
        // itself is tested by the dedicated e2e/core/save-verify.spec.ts
        // which uploads a real KDBX4 with password; the Demo DB has no
        // user-entered credentials so verify would be skipped anyway.

        // Navigate back to entries list.
        const backBtn = page.locator('.settings__back-button').first();
        if (await backBtn.isVisible().catch(() => false)) {
            await backBtn.click();
        } else {
            await page.locator('#footer__btn-settings').click();
        }
        await expect(page.locator('.list__item').first()).toBeVisible({
            timeout: 15_000
        });

        // Edit an entry to dirty the file.
        await page.locator('.list__item').first().click();
        const titleInput = page.locator('.details__header-title-input');
        const titleText = page.locator('.details__header-title').first();
        if ((await titleInput.count()) === 0 && (await titleText.count())) {
            await titleText.click();
        }
        let editableVisible = false;
        try {
            await expect(titleInput.first()).toBeVisible({ timeout: 5_000 });
            editableVisible = true;
        } catch {
            editableVisible = false;
        }
        if (editableVisible) {
            const stamp = `SDET-LIVE-${Date.now()}`;
            await titleInput.first().fill(stamp);
            await titleInput.first().press('Tab');
        }

        // Trigger save: click footer DB item → opens File settings.
        const dbItem = page.locator('.footer__db-item').first();
        await expect(dbItem).toBeVisible({ timeout: 5_000 });
        await dbItem.click();

        const saveBtn = page.locator('.settings__file-button-save-default');
        let saveBtnVisible = false;
        try {
            await expect(saveBtn).toBeVisible({ timeout: 10_000 });
            saveBtnVisible = true;
        } catch {
            saveBtnVisible = false;
        }

        if (saveBtnVisible) {
            await saveBtn.click();
            // Wait for sync to complete (footer dirty indicator clears).
            await expect(async () => {
                const dirtyCount = await page
                    .locator('.footer__db-sign')
                    .count();
                expect(dirtyCount).toBe(0);
            }).toPass({ timeout: 15_000 });
        }

        // Collect sync-related console messages for diagnostics.
        const filteredConsole = consoleMessages.filter((m) =>
            /Verif|Save|verification|saveVerify|Local|cache|dirty|sync/i.test(m)
        );
        console.log('TOTAL_CONSOLE_COUNT=' + consoleMessages.length);
        console.log('SAVE_CONSOLE_COUNT=' + filteredConsole.length);
        console.log(
            'SAVE_CONSOLE_TAIL=' + JSON.stringify(filteredConsole.slice(-30))
        );

        expect
            .soft(
                saveBtnVisible,
                'File settings save button should be visible after clicking footer DB item'
            )
            .toBe(true);
    });
});
