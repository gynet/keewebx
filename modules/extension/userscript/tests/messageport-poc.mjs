// Synthetic-only acceptance in a real extension's isolated content world.
import { chromium, webkit, expect } from '@playwright/test';
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
const browserName = process.env.KWX_PORT_POC_BROWSER || 'chromium';
const storageDelay = Number(process.env.KWX_PORT_POC_GM_DELAY_MS || 0);
if (!['chromium', 'webkit'].includes(browserName)) throw new Error('Unsupported lab browser');
const installer = readFileSync(join(ROOT, 'modules/extension/userscript/keewebx-messageport-poc.user.js'), 'utf8');
const report = { browser: browserName, appStorageReadDelay: storageDelay, nativeIOSVerified: false, realUserscriptsManagerVerified: false, credentialsUsed: false,
    installerSha256: createHash('sha256').update(installer).digest('hex'), steps: [], errors: [] };
let browser, context, server, app, first, second, originalApp, appNavigations = 0, helperOpenings = 0;
const host = page => page.locator('#keewebx-port-poc');
const status = page => host(page).getByRole('status');
async function ready(page) {
    await expect(host(page)).toBeAttached();
    if (browserName === 'chromium') await page._connection.toImpl(page).delegate._mainFrameSession._client.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}
async function panel(page) { await page.bringToFront(); if (await host(page).locator('section').isHidden()) await host(page).getByRole('button', { name: 'Port Lab', exact: true }).click(); }
async function sameApp() { expect(await app.evaluate(() => performance.timeOrigin)).toBe(originalApp); expect(appNavigations).toBe(1); }
async function connect(page) {
    await panel(page);
    await expect(host(page).getByRole('button', { name: 'Connect existing App' })).toBeEnabled();
    await host(page).getByRole('button', { name: 'Connect existing App' }).click();
    await expect(status(page)).toContainText('Connected. The connection page is closed', { timeout: 28000 });
    expect(context.pages().filter(item => item.url().includes('/connect-port-poc/relay.html'))).toHaveLength(0);
    await sameApp();
}
async function pings(page) {
    await panel(page); await host(page).getByRole('button', { name: 'Repeat ×5' }).click();
    await expect(status(page)).toContainText('Success 5/5', { timeout: 10000 });
    const hidden = await app.evaluate(() => document.hidden);
    if (browserName === 'chromium') { expect(hidden).toBe(true); expect(await host(page).locator('[data-role="log"]').innerText()).toContain('App hidden'); }
    report.hiddenAppReplyObserved ||= hidden; await sameApp();
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
    const appPath = process.env.KWX_PORT_POC_APP_PATH || '/app';
    if (!['/app', '/app/', '/next.html', '/index.html'].includes(appPath)) throw new Error('Unsupported test App path');
    const appURL = appOrigin + appPath;
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
    writeFileSync(join(extension, 'content.js'), `(()=>{const prefix='port-lab.user.js---';const GM={async getValue(key){if(location.origin === '${appOrigin}' && ${storageDelay}) await new Promise(resolve=>setTimeout(resolve,${storageDelay})); const data=await chrome.storage.local.get(prefix+key);return data[prefix+key];},async setValue(key,value){await chrome.storage.local.set({[prefix+key]:value});}};${bundle}})();`);
    if (browserName === 'chromium') {
        context = await chromium.launchPersistentContext(join(OUT, 'profile'), { channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
            ...(process.env.KWX_BROWSER_PROXY ? { proxy: { server: process.env.KWX_BROWSER_PROXY } } : {}),
            args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-extensions-except=' + extension, '--load-extension=' + extension] });
    } else {
        browser = await webkit.launch({ headless: true,
            ...(process.env.KWX_BROWSER_PROXY ? { proxy: { server: process.env.KWX_BROWSER_PROXY } } : {}) });
        context = await browser.newContext({ ignoreHTTPSErrors: true });
        const values = new Map();
        await context.exposeBinding('labFixtureGM', async ({ page }, action, key, value) => {
            if (action === 'set') { values.set(key, value); return; }
            if (new URL(page.url()).origin === appOrigin && storageDelay) await new Promise(resolve => setTimeout(resolve, storageDelay));
            return values.get(key);
        });
        // WebKit does not load Chromium extensions. Adapt only GM storage through
        // a disposable main-world fixture; run the actual installer in a user world.
        await context.addInitScript(() => document.addEventListener('lab-fixture-gm-request', async event => {
            const { id, action, key, value } = JSON.parse(event.detail);
            try {
                const result = await labFixtureGM(action, key, value);
                document.dispatchEvent(new CustomEvent('lab-fixture-gm-' + id, { detail: JSON.stringify({ value: result }) }));
            } catch (error) {
                document.dispatchEvent(new CustomEvent('lab-fixture-gm-' + id, { detail: JSON.stringify({ error: String(error) }) }));
            }
        }));
        context.on('page', page => page.on('domcontentloaded', () => { void (async () => {
            if (!page.url().startsWith('https:') || page.url().includes('/connect-port-poc/')) return;
            const isolated = await page._connection.toImpl(page).mainFrame()._utilityContext();
            await isolated.evaluateExpression(`(()=>{
                const call=(action,key,value)=>new Promise((resolve,reject)=>{
                    const id=crypto.randomUUID();
                    document.addEventListener('lab-fixture-gm-'+id,event=>{const data=JSON.parse(event.detail);if(data.error)reject(new Error(data.error));else resolve(data.value);},{once:true});
                    document.dispatchEvent(new CustomEvent('lab-fixture-gm-request',{detail:JSON.stringify({id,action,key,value})}));
                });
                const GM={getValue:key=>call('get',key),setValue:(key,value)=>call('set',key,value)};
                ${bundle}
            })();`, { isFunction: false });
        })().catch(error => report.errors.push(error.stack || String(error))); }));
    }
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
    if (browserName === 'chromium') await step('direct ports keep replying after the handoff service worker stops', async () => {
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
    await step('a disabled receiver produces an actionable rejection', async () => {
        await panel(app); await host(app).getByRole('button', { name: 'Disable receiver' }).click();
        await panel(second); await host(second).getByRole('button', { name: 'Connect existing App' }).click();
        await expect(status(second)).toContainText('test receiver is disabled', { timeout: 28000 });
        expect(context.pages().filter(page => page.url() === appURL)).toHaveLength(1);
        for (const page of context.pages().filter(page => page.url().includes('/connect-port-poc/relay.html'))) await page.close();
    });
    await step('refreshing the App diagnoses a stale receiver instead of silently timing out', async () => {
        await app.reload(); await ready(app); await panel(second);
        await host(second).getByRole('button', { name: 'Connect existing App' }).click();
        await expect(status(second)).toContainText('App was refreshed or the selected receiver changed', { timeout: 28000 });
        for (const page of context.pages().filter(page => page.url().includes('/connect-port-poc/relay.html'))) await page.close();
    });
    await step('a closed App is distinguished from an unresponsive receiver', async () => {
        await app.close(); await panel(second); await host(second).getByRole('button', { name: 'Connect existing App' }).click();
        await expect(status(second)).toContainText('No KeeWebX App tab was visible', { timeout: 28000 });
        expect(context.pages().filter(page => page.url() === appURL)).toHaveLength(0);
        for (const page of context.pages().filter(page => page.url().includes('/connect-port-poc/relay.html'))) await page.close();
    });
    expect(report.errors).toEqual([]); report.passed = true; report.helperOpenings = helperOpenings; report.originalAppNavigations = appNavigations;
} catch (error) {
    report.passed = false; report.failure = error.stack || String(error); process.exitCode = 1;
    if (context) report.pages = await Promise.all(context.pages().map(async page => ({ url: page.url(), text: await page.locator('body').innerText().catch(() => ''),
        labStatus: await status(page).textContent({ timeout: 500 }).catch(() => null) })));
    console.error(report.failure);
} finally { writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ report: join(OUT, 'report.json'), passed: report.passed })); await context?.close(); await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); }
