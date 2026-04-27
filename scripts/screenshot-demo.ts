/**
 * Screenshot script — opens the demo DB and captures the entry-detail
 * pane to show off colorful tag chips for the README / landing page.
 *
 * Usage:
 *   bun run scripts/screenshot-demo.ts
 *   open packages/core/screenshots/colorful-tags.png
 *
 * Requires the dev/dist server running at SCREENSHOT_URL (default
 * http://localhost:8086).
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'fs/promises';
import { resolve } from 'path';

const URL = process.env.SCREENSHOT_URL || 'http://localhost:8086/';
const OUT_DIR = resolve(__dirname, '../screenshots');

async function run() {
    await mkdir(OUT_DIR, { recursive: true });

    const browser = await chromium.launch();
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2 // retina
    });
    const page = await context.newPage();

    // Force cloud-mode tag sidebar (the more visually striking variant)
    // by pre-seeding the persisted setting before the SPA reads it on
    // first load. addInitScript runs before any page script.
    await context.addInitScript(() => {
        try {
            localStorage.setItem('appSettings', JSON.stringify({ tagStyle: 'cloud' }));
        } catch { /* storage may be blocked */ }
    });

    await page.goto(URL);
    await page.waitForLoadState('networkidle');

    // Click "Open Demo"
    const demoBtn = page.locator('#open__icon-demo');
    await demoBtn.waitFor({ timeout: 15_000 });
    await demoBtn.click();

    // Wait for entry list to populate
    await page.locator('.list__item').first().waitFor({ timeout: 15_000 });

    // Pick an entry with multiple tags to make tag chips obvious.
    // GitHub entry has 3 tags: work, dev, 2fa.
    const ghItem = page.locator('.list__item:has-text("GitHub")').first();
    await ghItem.click();

    // Wait for details pane + tag chips to render
    await page.locator('.details').waitFor();
    await page.waitForTimeout(500);

    await page.screenshot({
        path: resolve(OUT_DIR, 'colorful-tags.png'),
        fullPage: false
    });
    console.log('saved:', resolve(OUT_DIR, 'colorful-tags.png'));

    await browser.close();
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
