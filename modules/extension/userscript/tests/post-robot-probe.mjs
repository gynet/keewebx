// Actual bundled post-robot transport; no GM store or fake message delivery.
// Desktop checks only. chromium-extension additionally uses a real isolated
// content-script world, approximating Userscripts' injection environment.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2] || 'chromium';
assert(['chromium', 'webkit', 'chromium-extension'].includes(mode));
const extension = mode === 'chromium-extension';
const script = await readFile(new URL('../diagnostics/post-robot-probe.user.js', import.meta.url), 'utf8');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'kwx-postrobot-test-'));
const browser = extension ? undefined : await ({ chromium, webkit }[mode]).launch({
    headless: true,
    ...(mode === 'webkit' && process.env.PROBE_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PROBE_WEBKIT_EXECUTABLE } : {})
});
if (extension) {
    await writeFile(path.join(scratch, 'manifest.json'), JSON.stringify({
        name: 'Post-robot probe content-world fixture', version: '0.0.1', manifest_version: 3,
        content_scripts: [{ matches: ['https://*/*'], js: ['content.js'], run_at: 'document_idle' }]
    }));
    await writeFile(path.join(scratch, 'content.js'), script);
}
const host = '#keewebx-postrobot-probe';
const control = (page, name) => page.locator(host).getByRole('button', { name, exact: true });
const status = page => page.locator(host).getByRole('status');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let fixtureNumber = 0;

async function fixture(test) {
    const context = extension
        ? await chromium.launchPersistentContext(path.join(scratch, `profile-${++fixtureNumber}`), {
            channel: 'chromium', headless: true,
            args: [`--disable-extensions-except=${scratch}`, `--load-extension=${scratch}`]
        })
        : await browser.newContext();
    if (!extension) {
        await context.addInitScript({ content: `addEventListener('DOMContentLoaded',()=>{${script}\n},{once:true});` });
    }
    await context.route(/^https:\/\//, route => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>Post-robot fixture</title>
            <script>
              window.__delayProbeMessages=false; window.__delayedProbeMessages=[];
              addEventListener('message',e=>{
                if(window.__delayProbeMessages){
                  window.__delayedProbeMessages.push({data:e.data,source:e.source,origin:e.origin});
                  e.stopImmediatePropagation();
                }
              },true);
            </script>
            <form><input autocomplete="username"><input type="password"></form>
            <a id="next" href="https://second.example.net/">Next website</a>`
    }));
    const app = context.pages()[0] || await context.newPage();
    await app.goto('https://keewebx.app/app');
    await control(app, 'Post-robot 测试').click();
    const createClient = async () => {
        const popup = context.waitForEvent('page');
        await control(app, '关联并打开网站').click();
        const site = await popup;
        await site.waitForLoadState('domcontentloaded');
        await control(site, 'Post-robot 测试').click();
        return site;
    };
    try { await test({ context, app, createClient }); }
    finally { await context.close(); }
}

try {
    await fixture(async ({ context, app, createClient }) => {
        const site = await createClient();
        assert(await site.evaluate(() => !!window.opener));
        await control(site, '测试后台回包').click();
        await expect(status(site)).toContainText('成功：', { timeout: 12000 });
        const first = await status(site).textContent();
        const marker = first.match(/页面标记 ([a-f0-9]+)/)[1];
        // Headless windows remain visible in this environment. Do not turn
        // a desktop content-world check into a claim about iOS backgrounding.
        const appVisibility = await app.evaluate(() => document.visibilityState);
        assert(first.includes(appVisibility), first);
        await control(site, '测试后台回包').click();
        await expect(status(site)).toContainText(`页面标记 ${marker}`, { timeout: 12000 });
        assert.equal(context.pages().length, 2);
        assert.equal(await site.locator('input[type=password]').inputValue(), '');
        console.log(`${mode}: real cross-origin post-robot reply, retained page marker and two-tab reuse PASS; app=${await app.evaluate(() => document.visibilityState)}`);

        await site.locator('#next').click();
        await control(site, 'Post-robot 测试').click();
        await control(site, '测试后台回包').click();
        await expect(status(site)).toContainText('成功：', { timeout: 12000 });
        await expect(status(site)).toContainText(`页面标记 ${marker}`);
        console.log(`${mode}: link navigation to another origin retains associated parent PASS`);
    });

    await fixture(async ({ context }) => {
        const site = await context.newPage();
        await site.goto('https://independent.example.org/');
        await control(site, 'Post-robot 测试').click();
        await control(site, '测试后台回包').click();
        await expect(status(site)).toContainText('没有可用的来源窗口');
        assert.equal(context.pages().length, 2);
        console.log(`${mode}: independent tab reports missing association without opening or switching tabs PASS`);
    });

    await fixture(async ({ app, createClient }) => {
        const site = await createClient();
        await control(site, '测试后台回包').click();
        await expect(status(site)).toContainText('成功：', { timeout: 12000 });
        await control(app, '撤销关联').click();
        await control(site, '测试后台回包').click();
        await expect(status(site)).toContainText('来源窗口未关联', { timeout: 12000 });
        console.log(`${mode}: revoked app-side window association fails closed PASS`);
    });

    await fixture(async ({ app, createClient }) => {
        const site = await createClient();
        await control(site, '测试后台回包').click();
        await expect(status(site)).toContainText('成功：', { timeout: 12000 });
        await app.reload();
        await control(app, 'Post-robot 测试').click();
        await control(site, '测试后台回包').click();
        await expect(status(site)).toContainText('来源窗口未关联', { timeout: 12000 });
        console.log(`${mode}: app reload loses association and cannot report old page state PASS`);
    });

        await fixture(async ({ app, createClient }) => {
            const site = await createClient();
            await control(site, '测试后台回包').click();
            await expect(status(site)).toContainText('成功：', { timeout: 12000 });
            const before = await status(app).textContent();
            // Delay real incoming MessageEvents before the library receives
            // them. This verifies expiry, not OS process suspension.
            await app.evaluate(() => { window.__delayProbeMessages = true; });
            const started = Date.now();
            await control(site, '测试后台回包').click();
            await expect(status(site)).toContainText('超时', { timeout: 12000 });
            await pause(Math.max(0, 5500 - (Date.now() - started)));
            await app.evaluate(() => {
                window.__delayProbeMessages = false;
                for (const event of window.__delayedProbeMessages.splice(0)) {
                    dispatchEvent(new MessageEvent('message', event));
                }
            });
            await pause(400);
            await expect(status(site)).toContainText('超时');
            assert.equal(await status(app).textContent(), before);
            await control(site, '测试后台回包').click();
            await expect(status(site)).toContainText('成功：', { timeout: 12000 });
            console.log(`${mode}: delayed native messages time out, expired requests rejected, fresh request recovers PASS (not OS suspension)`);
        });
} finally {
    await browser?.close();
    await rm(scratch, { recursive: true, force: true });
}
