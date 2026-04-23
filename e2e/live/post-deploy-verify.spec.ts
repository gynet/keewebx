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

        // --- 4. Save-verify console output ---
        // Back to the entries list. `.settings__back-button` may or may
        // not be present depending on layout. Fallback: click the footer
        // settings cog to toggle settings off.
        const backBtn = page.locator('.settings__back-button').first();
        if (await backBtn.isVisible().catch(() => false)) {
            await backBtn.click();
        } else {
            await page.locator('#footer__btn-settings').click();
        }
        await expect(page.locator('.list__item').first()).toBeVisible({
            timeout: 15_000
        });
        await page.locator('.list__item').first().click();

        // Edit the entry title as the dirty-making mutation (simplest).
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

        // Trigger save with Cmd/Ctrl+S.
        const isMac = process.platform === 'darwin';
        await page.keyboard.press(isMac ? 'Meta+S' : 'Control+S');

        // Give verify path up to 15s.
        await page.waitForTimeout(15_000);

        const verifyStart = consoleMessages.find((m) =>
            /Verifying saved data/i.test(m)
        );
        const verifyDone = consoleMessages.find((m) =>
            /Save verification (passed|FAILED)/i.test(m)
        );

        const filteredConsole = consoleMessages.filter((m) =>
            /Verif|Save|verification|saveVerify|Local|cache|dirty|sync/i.test(m)
        );
        console.log('TOTAL_CONSOLE_COUNT=' + consoleMessages.length);
        console.log('SAVE_CONSOLE_COUNT=' + filteredConsole.length);
        console.log(
            'SAVE_CONSOLE_TAIL=' + JSON.stringify(filteredConsole.slice(-30))
        );
        console.log(
            'ALL_CONSOLE_TAIL=' + JSON.stringify(consoleMessages.slice(-40))
        );

        expect
            .soft(
                !!verifyStart,
                'expected a console log containing "Verifying saved data"'
            )
            .toBe(true);
        expect
            .soft(
                !!verifyDone,
                'expected a console log containing "Save verification passed" or "FAILED"'
            )
            .toBe(true);
    });
});
