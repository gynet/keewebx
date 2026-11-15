// Browser logic checks with a simulated GM store. These are not iOS/Userscripts tests.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../diagnostics/background-probe.user.js', import.meta.url), 'utf8');
const engine = process.argv[2] || 'chromium';
assert(['chromium', 'webkit'].includes(engine));
const browser = await ({ chromium, webkit }[engine]).launch({
    headless: true,
    ...(engine === 'webkit' && process.env.PROBE_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.PROBE_WEBKIT_EXECUTABLE } : {})
});
const prefix = 'keewebx-background-probe-v1:';
const host = '#keewebx-background-probe';
const status = page => page.locator(host).getByRole('status');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(run) {
    const context = await browser.newContext();
    const values = new Map();
    const writes = [];
    const blocked = [];
    let pauseApp = false;
    const clone = value => value === undefined ? undefined : structuredClone(value);
    await context.exposeBinding('__probeTestGM', async ({ page }, method, key, value) => {
        if (pauseApp && page.url().startsWith('https://keewebx.app/')) {
            await new Promise(resolve => blocked.push(resolve));
        }
        if (method === 'getValue') return clone(values.get(key));
        if (method === 'listValues') return [...values.keys()];
        if (method === 'deleteValue') { values.delete(key); return; }
        assert.equal(method, 'setValue');
        values.set(key, clone(value));
        writes.push({ key, value: clone(value) });
    });
    await context.addInitScript({ content: `
        window.GM = Object.fromEntries(['getValue','setValue','deleteValue','listValues'].map(method=>[method,(...args)=>window.__probeTestGM(method,...args)]));
        addEventListener('DOMContentLoaded',()=>{${script}\n});
    ` });
    await context.route('**/*', route => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>Probe fixture</title><form><input autocomplete="username"><input type="password"></form>'
    }));
    const app = await context.newPage();
    await app.goto('https://keewebx.app/app');
    const site = await context.newPage();
    await site.goto('https://login.example.org/');
    await app.locator(host).getByRole('button', { name: 'KeeWebX probe', exact: true }).click();
    await site.locator(host).getByRole('button', { name: 'KeeWebX probe', exact: true }).click();
    const controls = {
        context, app, site, values, writes,
        start: page => page.locator(host).getByRole('button', { name: 'Start on this tab', exact: true }).click(),
        test: () => site.locator(host).getByRole('button', { name: 'Test connection', exact: true }).click(),
        pause: () => { pauseApp = true; },
        resume: () => { pauseApp = false; blocked.splice(0).forEach(resolve => resolve()); }
    };
    try { await run(controls); }
    finally { controls.resume(); await context.close(); }
}

try {
    await fixture(async f => {
        await f.test();
        await expect(status(f.site)).toContainText('start the probe there first');
        await f.start(f.app);
        await f.test();
        await expect(status(f.site)).toContainText('Reply received', { timeout: 5000 });
        await expect(status(f.site)).toContainText('not password autofill');
        await expect.poll(() => [...f.values.keys()].filter(key => !key.endsWith('active')).length).toBe(0);
        // Only random challenges and lifecycle metadata may leave a document.
        const allowed = new Set(['kind', 'id', 'nonce', 'broker', 'startedAt', 'createdAt', 'expiresAt', 'repliedAt', 'visibility']);
        for (const { key, value } of f.writes) {
            assert(key.startsWith(prefix));
            assert(Object.keys(value).every(field => allowed.has(field)));
        }
        assert.equal(await f.site.locator('input[type=password]').inputValue(), '');
        console.log(`${engine}: cross-origin reply and cleanup PASS; no form access or credential transport`);
    });

    await fixture(async f => {
        await f.start(f.app);
        const previous = f.values.get(`${prefix}active`).broker;
        const other = await f.context.newPage();
        await other.goto('https://keewebx.app/app');
        await other.locator(host).getByRole('button', { name: 'KeeWebX probe', exact: true }).click();
        await f.start(other);
        await expect.poll(() => f.values.get(`${prefix}active`)?.broker).not.toBe(previous);
        const chosen = f.values.get(`${prefix}active`).broker;
        await f.test();
        await expect(status(f.site)).toContainText('Reply received', { timeout: 5000 });
        const replies = f.writes.filter(item => item.key.startsWith(`${prefix}response:`));
        assert(replies.length > 0 && replies.every(item => item.value.broker === chosen));
        await expect(status(f.app)).toContainText('Another KeeWebX tab');
        console.log(`${engine}: explicit app-tab ownership PASS`);
    });

    await fixture(async f => {
        await f.start(f.app);
        f.pause();
        await f.test();
        await expect(status(f.site)).toContainText('No reply yet', { timeout: 12000 });
        await f.app.bringToFront();
        f.resume();
        await expect(status(f.site)).toContainText('Reply received', { timeout: 5000 });
        const reply = f.writes.find(item => item.key.startsWith(`${prefix}response:`)).value;
        assert(reply.repliedAt - reply.createdAt >= 8000);
        console.log(`${engine}: queued request resumes after simulated app interruption PASS (not OS suspension)`);
    });

    await fixture(async f => {
        await f.start(f.app);
        f.pause();
        await f.test();
        await expect.poll(() => [...f.values.keys()].filter(key => key.startsWith(`${prefix}request:`)).length).toBe(1);
        const request = [...f.values.entries()].find(([key]) => key.startsWith(`${prefix}request:`))[1];
        const responseKey = `${prefix}response:${request.id}`;
        f.values.set(responseKey, { ...request, kind: 'probe-response', broker: '00000000-0000-0000-0000-000000000000', repliedAt: Date.now(), visibility: 'hidden' });
        await expect.poll(() => f.values.has(responseKey)).toBe(false);
        await expect(status(f.site)).not.toContainText('Reply received');
        f.values.set(responseKey, { ...request, kind: 'probe-response', expiresAt: Date.now() - 1, repliedAt: Date.now(), visibility: 'hidden' });
        await expect.poll(() => f.values.has(responseKey)).toBe(false);
        await expect(status(f.site)).not.toContainText('Reply received');
        f.resume();
        await expect(status(f.site)).toContainText('Reply received', { timeout: 5000 });
        console.log(`${engine}: wrong-owner and expired replies rejected PASS`);
    });
} finally { await browser.close(); }
