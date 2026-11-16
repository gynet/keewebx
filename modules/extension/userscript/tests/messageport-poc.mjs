// Synthetic-only acceptance in a real extension's isolated content world.
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const OUT = process.env.KWX_PORT_POC_OUTPUT || mkdtempSync(join(tmpdir(), 'keewebx-port-poc-'));
mkdirSync(OUT, { recursive: true });
const installer = readFileSync(join(ROOT, 'modules/extension/userscript/keewebx-messageport-poc.user.js'), 'utf8');
const report = { nativeIOSVerified: false, realUserscriptsManagerVerified: false, credentialsUsed: false,
    installerSha256: createHash('sha256').update(installer).digest('hex'), steps: [], errors: [] };
let context, server, app, first, second, originalApp, appNavigations = 0, helperOpenings = 0;
const host = page => page.locator('#keewebx-port-poc');
const status = page => host(page).getByRole('status');
async function ready(page) {
    await expect(host(page)).toBeAttached();
    await page._connection.toImpl(page).delegate._mainFrameSession._client.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}
async function panel(page) { await page.bringToFront(); if (await host(page).locator('section').isHidden()) await host(page).getByRole('button', { name: 'Port Lab', exact: true }).click(); }
async function sameApp() { expect(await app.evaluate(() => performance.timeOrigin)).toBe(originalApp); expect(appNavigations).toBe(1); }
async function connect(page) {
    await panel(page);
    await expect(host(page).getByRole('button', { name: 'Connect existing App' })).toBeEnabled();
    await host(page).getByRole('button', { name: 'Connect existing App' }).click();
    await expect(status(page)).toContainText('Connected. The connection page is closed', { timeout: 18000 });
    expect(context.pages().filter(item => item.url().includes('/connect-port-poc/relay.html'))).toHaveLength(0);
    await sameApp();
}
async function pings(page) {
    await panel(page); await host(page).getByRole('button', { name: 'Repeat ×5' }).click();
    await expect(status(page)).toContainText('Success 5/5', { timeout: 10000 });
    expect(await app.evaluate(() => document.hidden)).toBe(true);
    expect(await host(page).locator('[data-role="log"]').innerText()).toContain('App hidden'); await sameApp();
}
async function step(name, action) {
    console.log(JSON.stringify({ step: name, state: 'started' })); const start = Date.now();
    await action(); report.steps.push({ name, milliseconds: Date.now() - start });
    console.log(JSON.stringify({ step: name, state: 'passed' }));
}
try {
    let appOrigin = process.env.KWX_PORT_POC_APP_ORIGIN;
    if (!appOrigin) {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(OUT, 'key.pem'),
            '-out', join(OUT, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
        server = createServer({ key: readFileSync(join(OUT, 'key.pem')), cert: readFileSync(join(OUT, 'cert.pem')) }, (request, response) => {
            const path = new URL(request.url, 'https://localhost').pathname;
            if (path.startsWith('/connect-port-poc/') && /\/(relay\.html|relay\.js|worker\.js)$/.test(path)) {
                response.setHeader('content-type', path.endsWith('.js') ? 'application/javascript' : 'text/html');
                response.setHeader('cache-control', 'no-store'); response.end(readFileSync(join(ROOT, 'dist', path))); return;
            }
            if (path === '/main-worker.js') { response.setHeader('content-type', 'application/javascript'); response.end("self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));"); return; }
            response.setHeader('content-type', 'text/html'); response.end('<!doctype html><h1>Disposable original App</h1><script>navigator.serviceWorker.register("/main-worker.js",{scope:"/"});</script>');
        });
        await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
        appOrigin = 'https://localhost:' + server.address().port;
    }
    const appURL = appOrigin + '/app';
    const bundle = installer.replace("const APP_URL = 'https://keewebx.app/app';", `const APP_URL = '${appURL}';`);
    if (!process.env.KWX_PORT_POC_APP_ORIGIN) {
        const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
        expect(html).not.toContain('connect-port-poc/relay.js');
        expect(html).not.toContain('connect-port-poc/worker.js');
        expect(readFileSync(join(ROOT, 'dist/connect-port-poc/keewebx-messageport-poc.user.js'), 'utf8')).toBe(installer);
    }
    report.appOrigin = appOrigin; report.endpointSubstituted = appOrigin !== 'https://keewebx.app';
    const extension = join(OUT, 'extension'); mkdirSync(extension, { recursive: true });
    writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Disposable Port Lab adapter', version: '1.0', permissions: ['storage'],
        background: { service_worker: 'background.js' }, content_scripts: [{ matches: ['https://*/*'], js: ['content.js'], run_at: 'document_idle' }] }));
    writeFileSync(join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(()=>{});');
    writeFileSync(join(extension, 'content.js'), `(()=>{const prefix='port-lab.user.js---';const GM={async getValue(key){const data=await chrome.storage.local.get(prefix+key);return data[prefix+key];},async setValue(key,value){await chrome.storage.local.set({[prefix+key]:value});}};${bundle}})();`);
    context = await chromium.launchPersistentContext(join(OUT, 'profile'), { channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
        ...(process.env.KWX_BROWSER_PROXY ? { proxy: { server: process.env.KWX_BROWSER_PROXY } } : {}),
        args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-extensions-except=' + extension, '--load-extension=' + extension] });
    context.on('page', page => { page.on('pageerror', error => report.errors.push(error.message));
        page.on('framenavigated', frame => { if (frame === page.mainFrame() && frame.url() === appURL) appNavigations++; });
        page.on('domcontentloaded', () => { if (page.url().includes('/connect-port-poc/relay.html')) helperOpenings++; }); });
    for (const page of context.pages()) await page.close();
    for (const origin of ['https://port-a.example.org', 'https://port-b.example.net']) await context.route(origin + '/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Disposable website</h1>' }));
    await step('enable one receiver without opening a database', async () => {
        app = await context.newPage(); await app.goto(appURL); await ready(app); originalApp = await app.evaluate(() => performance.timeOrigin);
        await panel(app); await host(app).getByRole('button', { name: 'Enable test receiver' }).click(); await expect(status(app)).toContainText('Ready.');
    });
    await step('first website keeps its direct port after automatic relay closure', async () => {
        first = await context.newPage(); await first.goto('https://port-a.example.org/login'); await ready(first); await connect(first); await pings(first);
    });
    await step('two websites use independent ports to the same surviving App', async () => {
        second = await context.newPage(); await second.goto('https://port-b.example.net/login'); await ready(second); await connect(second);
        for (let i = 0; i < 2; i++) { await pings(first); await pings(second); }
        await expect(host(app).locator('[data-role="details"]')).toContainText('2 attached port(s)');
    });
    await step('direct ports keep replying after the handoff service worker stops', async () => {
        const cdp = await context.newCDPSession(app), versions = new Map();
        cdp.on('ServiceWorker.workerVersionUpdated', event => { for (const version of event.versions) versions.set(version.versionId, version); });
        await cdp.send('ServiceWorker.enable');
        await expect.poll(() => [...versions.values()].find(version => version.scriptURL.endsWith('/connect-port-poc/worker.js'))).toBeTruthy();
        const worker = [...versions.values()].find(version => version.scriptURL.endsWith('/connect-port-poc/worker.js'));
        await cdp.send('ServiceWorker.stopWorker', { versionId: worker.versionId });
        await expect.poll(() => versions.get(worker.versionId)?.runningStatus).toBe('stopped');
        await pings(first); await pings(second);
        expect(versions.get(worker.versionId)?.runningStatus).toBe('stopped');
        report.handoffWorkerStopped = true;
    });
    await step('disconnecting and closing one website does not break the other port', async () => {
        await panel(first); await host(first).getByRole('button', { name: 'Disconnect', exact: true }).click(); await first.close(); await pings(second);
    });
    await step('website reload rebuilds its port to the same App and closes the new relay', async () => {
        await second.reload(); await ready(second); await connect(second); await pings(second);
    });
    await step('the existing App service worker remains in control outside the lab scope', async () => {
        const script = await app.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
        if (!process.env.KWX_PORT_POC_APP_ORIGIN) expect(script).toContain('/main-worker.js');
        expect(script || '').not.toContain('/connect-port-poc/worker.js'); report.appController = script;
    });
    await step('the test panel fits mobile viewports and keeps its direct connection', async () => {
        for (const width of [390, 320]) {
            await second.setViewportSize({ width, height: 844 }); await pings(second);
            expect(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            const box = await host(second).locator('section').boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
            await second.screenshot({ path: join(OUT, 'port-lab-' + width + '.png') });
        }
    });
    expect(report.errors).toEqual([]); report.passed = true; report.helperOpenings = helperOpenings; report.originalAppNavigations = appNavigations;
} catch (error) {
    report.passed = false; report.failure = error.stack || String(error); process.exitCode = 1;
    if (context) report.pages = await Promise.all(context.pages().map(async page => ({ url: page.url(), text: await page.locator('body').innerText().catch(() => ''),
        labStatus: await status(page).textContent({ timeout: 500 }).catch(() => null) })));
    console.error(report.failure);
} finally { writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ report: join(OUT, 'report.json'), passed: report.passed })); await context?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); }
