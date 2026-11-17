/**
 * Real-browser acceptance of the already built New UI. Never builds the app.
 * node modules/ui/tests/startup-update-browser.mjs [--baseline] [--browser=chromium,firefox,webkit] [--case=substring]
 * KW_E2E_APP_ORIGIN defaults to http://127.0.0.1:39232 (the existing dist server).
 * KW_STARTUP_UPDATE_OUTPUT selects evidence; KW_STARTUP_APP_PATH defaults to /next.html.
 * A disposable HTTPS localhost server forwards byte-identical built assets and
 * supplies native root workers. Certificate exceptions apply only to this fixture.
 * Each case uses a new browser context: no old App, user vault or existing profile.
 */
import { chromium, firefox, webkit, expect as baseExpect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const expect = baseExpect.configure({ timeout: 10_000 });
const baseline = process.argv.includes('--baseline');
const sourceOrigin = process.env.KW_E2E_APP_ORIGIN || 'http://127.0.0.1:39232';
const appPath = process.env.KW_STARTUP_APP_PATH || '/next.html';
if (new URL(appPath, 'https://localhost').pathname !== '/next.html') {
    throw new Error('This root-scope fixture requires /next.html');
}
const output = resolve(process.env.KW_STARTUP_UPDATE_OUTPUT || `.cache/startup-update/${baseline ? 'before' : 'after'}`);
const selected = (process.argv.find(value => value.startsWith('--browser='))?.slice(10) || 'chromium,firefox').split(',');
const caseFilter = process.argv.find(value => value.startsWith('--case='))?.slice(7);
const engines = { chromium, firefox, webkit };
for (const name of selected) if (!engines[name]) throw new Error(`Unknown browser: ${name}`);
const precache = ['/next.html', '/js/next.js', '/css/next.css', '/manifest-new.json', '/icons/favicon-32x32.png', '/icons/apple-touch-icon.png'];
const fingerprintPaths = [...precache, '/connect-port/worker.js', '/service-worker.js'];
const hash = body => createHash('sha256').update(body).digest('hex');
await mkdir(output, { recursive: true });

async function fingerprint() {
    const entries = await Promise.all(fingerprintPaths.map(async path => {
        const response = await fetch(new URL(path, sourceOrigin));
        if (!response.ok) throw new Error(`Built ${path} unavailable: HTTP ${response.status}`);
        return [path, hash(Buffer.from(await response.arrayBuffer()))];
    }));
    return Object.fromEntries(entries);
}

const report = {
    mode: baseline ? 'baseline' : 'acceptance', sourceOrigin, appPath,
    capturedAt: new Date().toISOString(), sha256: await fingerprint(),
    limitations: [
        'Root service workers are controlled fixtures; HTML, JavaScript, CSS and Connect worker are unmodified built assets.',
        'Model startup is observed through native runtimeData/fileInfo reads; DOM insertion is recorded even for hidden file inputs.',
        'Desktop WebKit coverage, when selected, does not establish native iOS behavior.',
        ...(selected.includes('webkit') ? ['WebKit cached-app coverage disconnects the fixture origin; Playwright offline emulation aborts service-worker navigations before app startup. navigator.onLine remains true in this case.'] : [])
    ], results: []
};
const saveReport = () => writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
await saveReport();

// No install-time skipWaiting: v2 must really wait while v1 controls the seed.
function workerSource(version, ignoreSkipWaiting) {
    return `
const version = ${version};
const ignored = ${ignoreSkipWaiting};
const assets = 'startup-update-fixture-assets';
async function audit(kind, detail = {}) {
    const cache = await caches.open('startup-update-fixture-audit');
    await cache.put('/__startup_fixture__/audit/' + crypto.randomUUID(),
        new Response(JSON.stringify({ version, kind, at: Date.now(), ...detail })));
}
self.addEventListener('install', event => event.waitUntil((async () => {
    await (await caches.open(assets)).addAll(${JSON.stringify(precache)});
    await audit('installed');
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
    await audit('activated');
    await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    event.respondWith((async () => {
        const cached = await (await caches.open(assets)).match(event.request);
        if (cached && new URL(event.request.url).pathname === '/next.html') {
            await audit('cached-app-response');
        }
        return cached || fetch(event.request);
    })());
});
self.addEventListener('message', event => {
    if (event.data?.fixture === 'version') {
        event.ports[0]?.postMessage({ version, scope: self.registration.scope });
    } else if (event.data?.fixture === 'activate') {
        event.waitUntil(self.skipWaiting());
    } else if (event.data?.type === 'skip-waiting') {
        event.waitUntil((async () => {
            await audit('skip-waiting', { ignored });
            if (!ignored) await self.skipWaiting();
        })());
    }
});
`;
}

const tlsDirectory = await mkdtemp(resolve(tmpdir(), 'keewebx-startup-tls-'));
let tls;
try {
    await promisify(execFile)('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout', resolve(tlsDirectory, 'key.pem'), '-out', resolve(tlsDirectory, 'cert.pem')
    ]);
    tls = { key: await readFile(resolve(tlsDirectory, 'key.pem')), cert: await readFile(resolve(tlsDirectory, 'cert.pem')) };
} finally {
    await rm(tlsDirectory, { recursive: true, force: true });
}

async function fixture() {
    const state = { version: 1, ignoreSkipWaiting: false, hang: false, requests: [], held: [], assets: {} };
    const snapshot = new Map();
    async function built(path) {
        if (!snapshot.has(path)) snapshot.set(path, (async () => {
            const response = await fetch(new URL(path, sourceOrigin));
            const body = Buffer.from(await response.arrayBuffer());
            if (report.sha256[path]) expect(hash(body), `Unchanged built ${path}`).toBe(report.sha256[path]);
            state.assets[path] = hash(body);
            return { body, status: response.status, type: response.headers.get('content-type') || 'application/octet-stream' };
        })());
        return snapshot.get(path);
    }
    // Snapshot the core assets before navigation, including the production worker
    // fingerprint. Only /service-worker.js is served from our versioned fixture.
    await Promise.all(fingerprintPaths.map(built));
    function sendWorker(response, entry) {
        if (response.destroyed) return;
        entry.respondedAt = Date.now();
        entry.version = state.version;
        response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' });
        response.end(workerSource(state.version, state.ignoreSkipWaiting));
    }
    const server = createServer(tls, async (request, response) => {
        const path = new URL(request.url, 'https://localhost').pathname;
        const entry = { path, at: Date.now() };
        state.requests.push(entry);
        try {
            if (path === '/__startup_fixture__/seed.html') {
                response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
                response.end('<!doctype html><html lang="en"><title>Service worker seed only</title><body>Native service worker seed</body></html>');
            } else if (path === '/service-worker.js') {
                if (state.hang) state.held.push({ response, entry });
                else sendWorker(response, entry);
            } else {
                const asset = await built(path);
                entry.respondedAt = Date.now();
                response.writeHead(asset.status, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
                response.end(asset.body);
            }
        } catch (error) {
            entry.error = String(error);
            response.writeHead(500);
            response.end('Fixture asset unavailable');
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `https://localhost:${server.address().port}`;
    let closing;
    return {
        state, origin, appUrl: new URL(appPath, origin).href,
        release(version) {
            state.version = version;
            state.hang = false;
            for (const { response, entry } of state.held.splice(0)) sendWorker(response, entry);
        },
        async close() {
            if (!closing) {
                server.closeAllConnections();
                closing = new Promise(resolve => server.close(resolve));
            }
            await closing;
        }
    };
}

const evidenceKey = '__startupUpdateBrowserEvidence';
async function instrument(context) {
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(20_000);
    await context.addInitScript(({ evidenceKey }) => {
        if (window.top !== window || location.pathname !== '/next.html') return;
        const storage = window.sessionStorage;
        const get = Storage.prototype.getItem.bind(storage);
        const set = Storage.prototype.setItem.bind(storage);
        const documents = JSON.parse(get(evidenceKey) || '[]');
        const doc = {
            id: crypto.randomUUID(), timeOrigin: performance.timeOrigin,
            navigation: performance.getEntriesByType('navigation')[0]?.type,
            controllerAtStart: navigator.serviceWorker.controller?.scriptURL || null, events: []
        };
        documents.push(doc);
        const seen = new Set();
        const record = (kind, detail = {}) => {
            doc.events.push({ kind, at: Date.now(), elapsed: performance.now(), ...detail });
            set(evidenceKey, JSON.stringify(documents));
        };
        record('document-start');
        const once = (kind, detail) => {
            const key = kind + JSON.stringify(detail);
            if (!seen.has(key)) { seen.add(key); record(kind, detail); }
        };
        // Observe the real SettingsStore reads made by startVault. Forward every
        // operation to the native Storage object without replacing its data.
        const nativeLocalStorage = window.localStorage;
        const observedStorage = new Proxy(nativeLocalStorage, {
            get(target, key) {
                if (typeof key === 'string' && /(?:^|:)(runtimeData|fileInfo)$/.test(key)) {
                    once('model-storage-read', { key });
                }
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
            set(target, key, value) { return Reflect.set(target, key, value, target); }
        });
        Object.defineProperty(window, 'localStorage', { configurable: true, get: () => observedStorage });
        const nativeUpdate = ServiceWorkerRegistration.prototype.update;
        ServiceWorkerRegistration.prototype.update = function (...args) {
            record('native-update-call', { scope: this.scope });
            return Reflect.apply(nativeUpdate, this, args);
        };
        const selectors = '#open-demo, #open-file-input, #password, #unlock, input[type="password"], input[type="file"], .entry-row';
        function inspect(node) {
            if (!(node instanceof Element)) return;
            for (const element of [node, ...node.querySelectorAll(selectors)]) {
                if (element.matches(selectors)) once('app-element', {
                    selector: element.id ? '#' + element.id : element.matches('.entry-row') ? '.entry-row' : `input[type="${element.type}"]`
                });
            }
        }
        new MutationObserver(records => {
            for (const mutation of records) {
                for (const node of mutation.addedNodes) inspect(node);
                if (mutation.type === 'attributes') inspect(mutation.target);
            }
            const role = document.getElementById('root')?.dataset.appInstance;
            if (role) once('app-role', { role });
            const state = document.documentElement?.dataset.appStartup;
            if (state) once('startup-state', { state });
            if ([...document.querySelectorAll('[role="status"]')].some(element => element.textContent.includes('Checking for updates…'))) {
                once('checking-status', {});
            }
        }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-app-instance', 'data-app-startup', 'type', 'id'] });
        navigator.serviceWorker.addEventListener('controllerchange', () => record('controllerchange', {
            controller: navigator.serviceWorker.controller?.scriptURL || null
        }));
        window.addEventListener('message', event => {
            if (event.source === window && event.data?.kwConnect === 'state') record('connect-state', { action: event.data.action });
        });
        window.addEventListener('pagehide', () => record('pagehide'));
    }, { evidenceKey });
}

async function documents(page) {
    return page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || '[]'), evidenceKey);
}
async function workerAudit(page) {
    return page.evaluate(async () => {
        const cache = await caches.open('startup-update-fixture-audit');
        return (await Promise.all((await cache.keys()).map(async key => (await cache.match(key)).json())))
            .sort((a, b) => a.at - b.at);
    });
}
async function controllerVersion(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Root controller probe timed out')); }, 3000);
        channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
        navigator.serviceWorker.controller?.postMessage({ fixture: 'version' }, [channel.port2]);
    }));
}
async function seed(context, local, waiting = false, ignoreSkipWaiting = false) {
    const page = await context.newPage();
    await page.goto(`${local.origin}/__startup_fixture__/seed.html`);
    expect(await page.locator('#root, input[type="file"], input[type="password"]').count()).toBe(0);
    await page.evaluate(async () => {
        await navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' });
        await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    expect(await controllerVersion(page)).toEqual({ version: 1, scope: local.origin + '/' });
    if (waiting) {
        local.state.version = 2;
        local.state.ignoreSkipWaiting = ignoreSkipWaiting;
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/')).update());
        await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.waiting?.state)).toBe('installed');
        expect((await controllerVersion(page)).version).toBe(1);
    }
    return page;
}
async function normalUnlock(page) {
    await expect(page.locator('#root')).toHaveAttribute('data-app-instance', 'primary');
    await expect(page.locator('#open-demo')).toBeVisible();
    await expect(page.locator('#open-file-input')).toHaveCount(1);
    await expect(page.locator('input[type="file"]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /update.*lock|lock.*update/i })).toHaveCount(0);
}
async function usable(page) {
    await page.locator('#open-demo').click();
    await expect(page.locator('.entry-row').first()).toBeVisible();
}
async function stable(page, count, duration = 3100) {
    // Real elapsed time catches delayed controllerchange callbacks and loops.
    await page.waitForTimeout(duration);
    expect(await documents(page)).toHaveLength(count);
}
async function capture(page, result, dir, label) {
    result.documents = await documents(page);
    result.workerAudit = await workerAudit(page);
    result.controller = await controllerVersion(page);
    await writeFile(resolve(dir, 'timeline.json'), JSON.stringify(result.documents, null, 2) + '\n');
    await page.screenshot({ path: resolve(dir, label + '.png'), fullPage: true });
}
function bounded(doc) {
    const first = doc.events.find(event => event.kind === 'app-element' && event.selector === '#open-demo');
    expect(first, 'Normal unlock was observed').toBeTruthy();
    expect(first.elapsed, 'Unlock is usable within the 2.5s check plus 1s browser startup allowance').toBeLessThan(3500);
    return first.elapsed;
}
function documentReplacement(first, second) {
    expect(second.id, 'Reload creates a new document').not.toBe(first.id);
    expect(second.timeOrigin, 'Reload starts a new performance timeline').toBeGreaterThan(first.timeOrigin);
    const pagehide = first.events.find(event => event.kind === 'pagehide');
    const start = second.events.find(event => event.kind === 'document-start');
    expect(pagehide, 'Previous document records pagehide').toBeTruthy();
    expect(start, 'New document records its start').toBeTruthy();
    expect(pagehide.at).toBeLessThanOrEqual(start.at);
}

const cases = {
    async 'waiting-update-before-model'(context, local, result, dir) {
        const page = await seed(context, local, true);
        result.seed = { url: page.url(), controller: await controllerVersion(page), waitingVersion: 2 };
        await page.goto(local.appUrl);
        await normalUnlock(page);
        await stable(page, baseline ? 1 : 2);
        await capture(page, result, dir, baseline ? 'before-unlock-with-stale-worker' : 'after-update-normal-unlock');
        const [first, second] = result.documents;
        expect(first.controllerAtStart).toBe(local.origin + '/service-worker.js');
        const premature = first.events.filter(event => ['app-element', 'model-storage-read', 'connect-state'].includes(event.kind));
        if (baseline) {
            expect(premature.some(event => event.kind === 'model-storage-read')).toBe(true);
            expect(premature.some(event => event.selector === '#open-file-input')).toBe(true);
            expect(result.controller.version).toBe(1);
            expect(result.workerAudit.some(event => event.version === 2 && event.kind === 'skip-waiting')).toBe(false);
            expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting)).toBe(true);
            result.reproduced = 'Model and file input start under v1 while native root worker v2 remains waiting.';
        } else {
            expect(premature, 'First document must not start model, unlock or file inputs').toEqual([]);
            expect(first.events.some(event => event.kind === 'checking-status')).toBe(true);
            expect(first.events.filter(event => event.kind === 'startup-state').map(event => event.state)).toEqual(['checking']);
            const changeIndex = first.events.findIndex(event => event.kind === 'controllerchange');
            const hideIndex = first.events.findIndex(event => event.kind === 'pagehide');
            expect(changeIndex, 'Worker takes control before the old document exits').toBeGreaterThanOrEqual(0);
            expect(hideIndex).toBeGreaterThan(changeIndex);
            expect(first.events[changeIndex].at).toBeLessThanOrEqual(first.events[hideIndex].at);
            documentReplacement(first, second);
            // Some WebKit builds expose no PerformanceNavigationTiming entry.
            // Keep the reload type assertion wherever that entry is available.
            if (second.navigation !== undefined) expect(second.navigation).toBe('reload');
            expect(second.controllerAtStart).toBe(local.origin + '/service-worker.js');
            result.reloadEvidence = second.navigation === undefined
                ? 'controllerchange -> pagehide -> new document and timeOrigin (navigation timing unavailable)'
                : 'navigation timing: reload; controllerchange -> pagehide -> new document and timeOrigin';
            expect(result.controller).toEqual({ version: 2, scope: local.origin + '/' });
            expect(result.workerAudit.filter(event => event.version === 2 && event.kind === 'skip-waiting')).toHaveLength(1);
            expect(result.workerAudit.filter(event => event.version === 2 && event.kind === 'activated')).toHaveLength(1);
            expect(second.events.filter(event => event.kind === 'model-storage-read').map(event => event.key)).toEqual(expect.arrayContaining(['runtimeData', 'fileInfo']));
            expect(second.events.filter(event => event.kind === 'startup-state').map(event => event.state)).toEqual(['checking', 'ready']);
        }
        await usable(page);
        result.demo = 'Opened through the normal UI without manual locking.';
    },

    async 'no-update-no-reload-loop'(context, local, result, dir) {
        const page = await seed(context, local);
        await page.goto(local.appUrl);
        await normalUnlock(page);
        await stable(page, 1);
        for (let repeat = 0; repeat < 2; repeat++) {
            await page.reload();
            await normalUnlock(page);
            await stable(page, repeat + 2, 250);
        }
        await capture(page, result, dir, 'normal-unlock');
        expect(result.controller.version).toBe(1);
        result.intentionalReloads = 2;
        expect(result.documents).toHaveLength(1 + result.intentionalReloads);
        expect(new Set(result.documents.map(doc => doc.id)).size).toBe(3);
        for (const doc of result.documents) {
            const update = doc.events.find(event => event.kind === 'native-update-call' && event.scope === local.origin + '/');
            const model = doc.events.find(event => event.kind === 'model-storage-read');
            expect(update, 'Every fresh controlled document calls the real root registration.update').toBeTruthy();
            expect(update.at).toBeLessThanOrEqual(model.at);
        }
        expect(result.workerAudit.filter(event => event.kind === 'skip-waiting')).toEqual([]);
        result.unlockElapsedMs = result.documents.map(bounded);
        await usable(page);
    },

    async 'network-update-before-model'(context, local, result, dir) {
        const page = await seed(context, local);
        local.state.version = 2;
        await page.goto(local.appUrl);
        await normalUnlock(page);
        await stable(page, 2);
        await capture(page, result, dir, 'network-update-before-unlock');
        expect(result.documents[0].events.filter(event => ['app-element', 'model-storage-read', 'connect-state'].includes(event.kind))).toEqual([]);
        expect(result.controller.version).toBe(2);
        await usable(page);
    },

    async 'offline-cached-app-continues'(context, local, result, dir) {
        const page = await seed(context, local);
        await page.goto(local.appUrl);
        await normalUnlock(page);
        expect(await documents(page)).toHaveLength(1);
        const cachedPaths = await page.evaluate(async () => {
            const cache = await caches.open('startup-update-fixture-assets');
            return (await cache.keys()).map(request => new URL(request.url).pathname);
        });
        expect(cachedPaths).toEqual(expect.arrayContaining(precache));
        result.cachedPaths = cachedPaths;
        const cachedResponses = (await workerAudit(page)).filter(event => event.kind === 'cached-app-response').length;
        const offlineRequestStart = local.state.requests.length;
        // WebKit's native offline emulation fails before dispatching a cached
        // navigation, even in a minimal HTTP service-worker fixture. Disconnect
        // this real origin instead, and prove network access actually fails.
        await local.close();
        await expect(context.request.get(local.appUrl, { timeout: 3000, maxRetries: 0 })).rejects.toThrow(/ECONNREFUSED/);
        result.offlineMode = result.browser === 'webkit' ? 'disconnected-origin' : 'disconnected-origin-and-native-offline';
        if (result.browser !== 'webkit') await context.setOffline(true);
        await page.reload();
        await normalUnlock(page);
        result.navigatorOnline = await page.evaluate(() => navigator.onLine);
        expect(result.navigatorOnline).toBe(result.browser === 'webkit');
        await stable(page, 2);
        await capture(page, result, dir, 'offline-normal-unlock');
        documentReplacement(...result.documents);
        result.intentionalReloads = 1;
        result.unlockElapsedMs = bounded(result.documents[1]);
        expect(result.controller.version).toBe(1);
        expect(result.workerAudit.filter(event => event.kind === 'cached-app-response')).toHaveLength(cachedResponses + 1);
        expect(result.documents[1].events.some(event => event.kind === 'native-update-call' && event.scope === local.origin + '/')).toBe(true);
        await usable(page);
        result.offlineAssetRequests = local.state.requests.slice(offlineRequestStart).filter(request => precache.includes(request.path));
        expect(result.offlineAssetRequests, 'Offline reload serves app assets without the HTTPS server').toEqual([]);
        result.demo = 'Real App loaded online, then reloaded with its origin disconnected: cached exact app starts a new document and Demo opens.';
    },

    async 'hung-update-bounded-no-late-reload'(context, local, result, dir) {
        const page = await seed(context, local);
        local.state.hang = true;
        const requestStart = local.state.requests.length;
        await page.goto(local.appUrl);
        await normalUnlock(page);
        const docs = await documents(page);
        expect(docs).toHaveLength(1);
        result.unlockElapsedMs = bounded(docs[0]);
        // A response remains genuinely pending at the local HTTPS server.
        const model = docs[0].events.find(event => event.kind === 'model-storage-read');
        const pending = local.state.requests.slice(requestStart).filter(request => request.path === '/service-worker.js' && !request.respondedAt);
        expect(pending.length).toBeGreaterThan(0);
        expect(pending.some(request => request.at <= model.at), 'Native update fetch starts before model').toBe(true);
        expect(result.unlockElapsedMs).toBeGreaterThanOrEqual(2200);
        result.pendingAtUnlock = structuredClone(pending);
        await usable(page);
        await page.locator('.entry-row').first().click();
        await expect(page.locator('#entry-title')).toBeVisible();
        const title = await page.locator('#entry-title').innerText();
        local.release(2);
        await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.waiting?.state)).toBe('installed');
        const notice = page.getByRole('complementary', { name: 'App update', exact: true });
        await expect(notice).toHaveCount(0);
        await expect(page.locator('#apply-app-update')).toHaveCount(0);
        await stable(page, 1);
        await capture(page, result, dir, 'late-update-remains-waiting');
        expect(result.controller.version).toBe(1);
        expect(result.workerAudit.filter(event => event.version === 2 && event.kind === 'skip-waiting')).toEqual([]);
        await expect(page.locator('#entry-title')).toHaveText(title);
        result.noticeCountWhileOpen = await notice.count();
        result.updateActionCount = await page.locator('#apply-app-update').count();
        await page.getByRole('button', { name: 'Lock', exact: true }).click();
        await expect(notice).toBeVisible();
        await expect(notice.getByRole('status')).toHaveText('An update is ready.');
        await expect(page.locator('#apply-app-update')).toBeEnabled();
        await stable(page, 1, 250);
        result.demo = 'Demo entry opened before delayed v2 arrived; the same entry remains open without a reload.';
    },

    async 'waiting-activation-timeout-continues'(context, local, result, dir) {
        const page = await seed(context, local, true, true);
        await page.goto(local.appUrl);
        await normalUnlock(page);
        await stable(page, 1);
        await capture(page, result, dir, 'unresponsive-worker-normal-unlock');
        result.unlockElapsedMs = bounded(result.documents[0]);
        expect(result.unlockElapsedMs).toBeGreaterThanOrEqual(2200);
        expect(result.controller.version).toBe(1);
        expect(result.workerAudit.filter(event => event.version === 2 && event.kind === 'skip-waiting' && event.ignored)).toHaveLength(1);
        await usable(page);
    },

    async 'manual-activation-cancelled-by-unlock'(context, local, result, dir) {
        const page = await seed(context, local, true, true);
        await page.goto(local.appUrl);
        await normalUnlock(page);
        await expect(page.locator('#apply-app-update')).toBeEnabled();
        await page.locator('#apply-app-update').click();
        await expect.poll(async () => (await workerAudit(page)).filter(event => event.kind === 'skip-waiting')).toHaveLength(2);
        await usable(page);
        await expect(page.getByRole('complementary', { name: 'App update', exact: true })).toHaveCount(0);
        // Complete the earlier request after the user has opened a vault.
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/')).waiting.postMessage({ fixture: 'activate' }));
        await expect.poll(async () => (await controllerVersion(page)).version).toBe(2);
        await stable(page, 1);
        await expect(page.locator('.entry-row').first()).toBeVisible();
        await capture(page, result, dir, 'manual-activation-after-unlock');
    },

    async 'updated-root-app-single-instance'(context, local, result, dir) {
        const first = await seed(context, local, true);
        await first.goto(local.appUrl);
        await normalUnlock(first);
        expect(await documents(first)).toHaveLength(2);
        expect((await controllerVersion(first)).version).toBe(2);
        await usable(first);
        const second = await context.newPage();
        await second.goto(local.appUrl);
        await second.bringToFront();
        await expect(second.locator('#root')).toHaveAttribute('data-app-instance', 'secondary');
        await expect(second.getByRole('heading', { name: 'KeeWebX is already open', exact: true })).toBeVisible();
        await expect(second.locator('input[type="file"], input[type="password"], #open-demo, .entry-row')).toHaveCount(0);
        await expect(first.locator('.entry-row').first()).toBeVisible();
        const locks = await second.evaluate(async () => {
            const locks = await navigator.locks.query();
            return Object.fromEntries(['held', 'pending'].map(key => [key, locks[key].filter(lock => lock.name === 'keewebx-app-instance-v1:/:')]));
        });
        expect(locks.held).toHaveLength(1);
        expect(locks.pending).toHaveLength(1);
        result.locksWithTwoPages = locks;
        result.secondaryDocuments = await documents(second);
        expect(result.secondaryDocuments.flatMap(doc => doc.events.filter(event => event.kind === 'model-storage-read' || event.kind === 'app-element'))).toEqual([]);
        await second.screenshot({ path: resolve(dir, 'secondary-without-unlock.png'), fullPage: true });
        await capture(first, result, dir, 'one-primary-demo');
        await first.close();
        await normalUnlock(second);
        await usable(second);
        result.takeover = 'Secondary becomes usable after primary closes.';
    }
};

try {
    for (const name of selected) {
        let browser;
        try {
            // Chromium's native worker loader needs the same exception as the
            // page for this self-signed localhost certificate. No app TLS policy
            // or production URL is altered, and no existing profile is reused.
            browser = await engines[name].launch({ headless: true, timeout: 30_000,
                ...(name === 'chromium' ? { channel: 'chromium', args: ['--ignore-certificate-errors'] } : {}) });
            for (const [title, run] of Object.entries(cases)) {
                if (baseline && title !== 'waiting-update-before-model' || caseFilter && !title.includes(caseFilter)) continue;
                const dir = resolve(output, name, title);
                await mkdir(dir, { recursive: true });
                const result = { browser: name, version: browser.version(), case: title, status: 'running', runId: randomUUID() };
                report.results.push(result);
                console.log(`${name}: ${title}`);
                let local;
                let context;
                const pageErrors = [];
                try {
                    local = await fixture();
                    result.fixtureOrigin = local.origin;
                    context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'allow', viewport: { width: 1280, height: 800 } });
                    context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
                    await instrument(context);
                    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
                    await run(context, local, result, dir);
                    expect(pageErrors, 'No unhandled app errors').toEqual([]);
                    result.status = 'passed';
                } catch (error) {
                    result.status = 'failed';
                    result.error = String(error.stack || error);
                    result.pages = [];
                    for (const [index, page] of (context?.pages() || []).entries()) {
                        result.pages.push({ url: page.url(), documents: await documents(page).catch(() => null),
                            workerAudit: await workerAudit(page).catch(() => null), body: await page.locator('body').innerText().catch(() => null) });
                        await page.screenshot({ path: resolve(dir, `failure-${index}.png`), fullPage: true }).catch(() => {});
                    }
                    console.error(`${name}: ${title}: ${error.message}`);
                } finally {
                    result.pageErrors = pageErrors;
                    if (local) {
                        result.requests = local.state.requests;
                        result.servedAssetSha256 = local.state.assets;
                        await writeFile(resolve(dir, 'requests.json'), JSON.stringify(result.requests, null, 2) + '\n');
                    }
                    if (context) {
                        await context.tracing.stop({ path: resolve(dir, 'trace.zip') });
                        await context.close();
                    }
                    await local?.close();
                    await saveReport();
                }
            }
        } catch (error) {
            report.results.push({ browser: name, case: 'browser-launch-or-fixture', status: 'failed', error: String(error.stack || error) });
        } finally {
            await browser?.close();
        }
    }
} finally {
    report.finalSha256 = await fingerprint();
    if (JSON.stringify(report.sha256) !== JSON.stringify(report.finalSha256)) {
        report.results.push({ case: 'immutable-build', status: 'failed', error: 'Served build changed during acceptance. Rerun after the parent finishes building.' });
    }
    await saveReport();
}
if (!report.results.length) throw new Error('No cases selected');
console.log(`${report.results.filter(result => result.status === 'passed').length}/${report.results.length} passed; evidence: ${output}`);
if (report.results.some(result => result.status !== 'passed')) process.exitCode = 1;
