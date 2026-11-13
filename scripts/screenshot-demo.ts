/** Capture the compiled New interface using only the bundled demo vault.
 * SCREENSHOT_URL defaults to http://localhost:8112/next.html.
 * SCREENSHOT_DIR selects the destination; screenshots are never generated from mocks.
 */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const appUrl = process.env.SCREENSHOT_URL || 'http://localhost:8112/next.html';
const output = resolve(process.env.SCREENSHOT_DIR || resolve(import.meta.dir, '../screenshots'));
const browser = await chromium.launch({ headless: true });
const captures: { file: string; width: number; height: number; theme: string; screen: string }[] = [];
await mkdir(output, { recursive: true });
try {
    for (const mode of ['light', 'dark'] as const) {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
            const phone = viewport.width < 600;
            const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: mode, locale: 'en-US' });
            await context.addInitScript(mode => {
                localStorage.setItem('uiTheme', mode);
                localStorage.setItem('appSettings', JSON.stringify({ locale: 'en-US', tagStyle: 'cloud', idleMinutes: 0 }));
            }, mode);
            const page = await context.newPage();
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(appUrl);
            await expect(page.locator('#open-demo')).toBeVisible();
            await page.evaluate(() => document.fonts.ready);
            const capture = async (file: string, screen: string) => {
                await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                await page.screenshot({ path: resolve(output, file), fullPage: false });
                captures.push({ file, ...viewport, theme: mode, screen });
            };
            await capture(`new-start-${phone ? 'phone' : 'desktop'}-${mode}.png`, 'start');
            await page.locator('#open-demo').click();
            const entry = page.locator('.entry-row').filter({ hasText: 'GitHub' }).first();
            await expect(entry).toBeVisible();
            await entry.click();
            await expect(page.locator('#entry-title')).toContainText('GitHub');
            await page.evaluate(() => document.fonts.ready);
            const file = mode === 'light' ? (phone ? 'phone-demo.png' : 'colorful-tags.png')
                : `new-${phone ? 'phone' : 'desktop'}-dark.png`;
            await capture(file, 'demo-entry');
            expect(errors).toEqual([]);
            await context.close();
        }
    }
    const response = await fetch(new URL('js/next.js', appUrl));
    if (!response.ok) throw new Error('Could not fingerprint the compiled New bundle');
    const sha256 = createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex');
    await writeFile(resolve(output, 'capture-manifest.json'), JSON.stringify({ bundleSha256: sha256, captures }, null, 2) + '\n');
    console.log(`Captured ${captures.length} screenshots from the compiled demo interface.`);
} finally { await browser.close(); }
