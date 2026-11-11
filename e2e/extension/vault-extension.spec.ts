import { test, expect, chromium } from '@playwright/test';
import type { BrowserContext, Page, Worker as PlaywrightWorker } from '@playwright/test';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

/**
 * The prototype extension: full mode (vault inside the extension) and
 * connect mode (existing app in a browser tab). Fully headless. Run:
 *   bun run build && (cd packages/extension && bun run build-chrome-vault)
 *   bunx playwright test -c e2e/extension/vault.playwright.config.ts
 */

const EXT_PATH = path.resolve(__dirname, '../../packages/extension/dist/chrome-vault');
const VECTORS = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../packages/db/test/crypto/argon2-vectors.json'), 'utf8')
) as Array<Record<string, any>>;

const LOGIN_HTML = `<!doctype html><title>Sign in</title><form action="/session" method="post">
<input id="login_field" name="login" autocomplete="username">
<input id="password" name="password" type="password" autocomplete="current-password">
<button type="submit">Sign in</button></form>`;

const CORE_DIST = path.resolve(__dirname, '../../packages/core/dist');
const FIXTURE = path.resolve(
    __dirname,
    '../../packages/db/resources/external/test_db_kdbx4_with_password_argon2.kdbx'
);
const FIXTURE_PASSWORD = 'demopass';
const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png'
};

let server: http.Server;
let serverUrl = '';
// A real server, because Playwright's route.fulfill adds CORS headers itself.
let davServer: https.Server;
let davUrl = '';
let davRequests: Array<{ method: string; auth?: string }> = [];
let context: BrowserContext;
let sw: PlaywrightWorker;
let extensionId: string;
const appUrl = () => `chrome-extension://${extensionId}/app/index.html`;

test.skip(!fs.existsSync(path.join(EXT_PATH, 'manifest.json')), 'build the vault extension first');

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const pathname = new URL(req.url!, 'http://x').pathname;
        const file = path.join(CORE_DIST, pathname === '/' ? 'index.html' : pathname);
        if (!file.startsWith(CORE_DIST) || !fs.existsSync(file)) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, {
            'content-type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream'
        });
        res.end(fs.readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://localhost:${(server.address() as AddressInfo).port}/`;
});

test.beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-dav-'));
    const [key, cert] = [path.join(dir, 'key.pem'), path.join(dir, 'cert.pem')];
    execFileSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-days', '1'],
        { stdio: 'ignore' }
    );
    davServer = https.createServer(
        { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
        (req, res) => {
            davRequests.push({ method: req.method!, auth: req.headers.authorization });
            // Deliberately no Access-Control-Allow-Origin.
            res.writeHead(200, {
                'content-type': 'application/octet-stream',
                'last-modified': 'Tue, 10 Nov 2026 10:00:00 GMT',
                etag: '"v1"'
            });
            res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(FIXTURE));
        }
    );
    await new Promise<void>((resolve) => davServer.listen(0, '127.0.0.1', resolve));
    davUrl = `https://localhost:${(davServer.address() as AddressInfo).port}/vault.kdbx`;
});

test.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => davServer.close(resolve));
});

test.beforeEach(async () => {
    context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'kw-vault-')), {
        channel: 'chromium',
        headless: true,
        ignoreHTTPSErrors: true,
        args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`]
    });
    sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(sw.url()).host;
    // First install opens the options page and settles the config; requests
    // made during that window are cancelled by design.
    await expect
        .poll(() => context.pages().find((p) => p.url().includes('pages/options.html')), { timeout: 15000 })
        .toBeTruthy();
    await context.pages().find((p) => p.url().includes('pages/options.html'))!.close();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // Stands in for a real site so the test needs no network.
    await context.route('https://github.com/login', (route) =>
        route.fulfill({ contentType: 'text/html', body: LOGIN_HTML })
    );
});

test.afterEach(async () => {
    await context.close();
});

async function openDemoVault(): Promise<{ page: Page; problems: string[] }> {
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => {
        if (/Content Security Policy|Refused to/.test(m.text())) {
            problems.push(m.text());
        }
    });
    await page.goto(appUrl());
    await page.click('#open__icon-demo');
    await expect(page.locator('.list__item').first()).toBeVisible({ timeout: 30000 });
    return { page, problems };
}

async function clickToolbarButton(urlPrefix: string): Promise<void> {
    // The background worker registers its listener asynchronously.
    await expect
        .poll(() => sw.evaluate(() => (chrome.action.onClicked as any).hasListeners()), { timeout: 15000 })
        .toBe(true);
    const result = await sw.evaluate(async (prefix) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url?.startsWith(prefix));
        if (!tab) {
            return 'no tab';
        }
        (chrome.action.onClicked as any).dispatch(tab);
        return 'ok';
    }, urlPrefix);
    expect(result).toBe('ok');
}

test('the app runs inside the extension and opens a vault', async () => {
    const { page, problems } = await openDemoVault();
    expect(await page.locator('.list__item').count()).toBeGreaterThan(5);
    expect(await page.textContent('.footer__db-item')).toContain('Demo');
    expect(problems).toEqual([]);
});

test('the packaged Argon2 worker matches the reference vectors', async () => {
    const { page } = await openDemoVault();
    const cases = VECTORS.filter((v) => v.version === 0x13 && v.password.length > 0);
    expect(new Set(cases.map((v) => v.type))).toEqual(new Set([0, 2]));
    const results = await page.evaluate(async (vectors) => {
        const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16)).buffer;
        const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
        const out: boolean[] = [];
        for (const v of vectors) {
            out.push(
                await new Promise<boolean>((resolve) => {
                    const w = new Worker('js/argon2-worker.js');
                    w.onmessage = (e) => {
                        w.terminate();
                        resolve(hex(e.data.hash) === v.hash);
                    };
                    w.postMessage({ ...v, password: bytes(v.password), salt: bytes(v.salt) });
                })
            );
        }
        return out;
    }, cases);
    expect(results.length).toBe(cases.length);
    expect(results.every(Boolean)).toBe(true);
});

test('fills a login form from the vault inside the extension', async () => {
    const { page: vault } = await openDemoVault();
    const site = await context.newPage();
    await site.goto('https://github.com/login');
    await site.evaluate(() => {
        document.querySelector('form')!.addEventListener(
            'submit',
            (e) => {
                e.preventDefault();
                e.stopImmediatePropagation();
            },
            { capture: true }
        );
    });
    await site.focus('#login_field');

    await clickToolbarButton('https://github.com/login');

    await vault.locator("button[data-result='yes']").click({ timeout: 15000 });
    await expect(site.locator('#login_field')).toHaveValue('demouser', { timeout: 15000 });
    await expect(site.locator('#password')).not.toHaveValue('');
});

test('the toolbar button opens the built-in vault when none is open', async () => {
    const site = await context.newPage();
    await site.goto('https://github.com/login');
    await site.focus('#login_field');
    await clickToolbarButton('https://github.com/login');
    await expect
        .poll(
            () =>
                sw.evaluate(async (url) => {
                    const tabs = await chrome.tabs.query({});
                    return tabs.some((t) => (t.url || t.pendingUrl || '').startsWith(url));
                }, appUrl()),
            { timeout: 15000 }
        )
        .toBe(true);
});

test('the web app service worker is not registered from the extension page', async () => {
    const { page } = await openDemoVault();
    await page.waitForTimeout(1000);
    const scripts = await page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).map((r) => r.active?.scriptURL ?? '')
    );
    // Only the extension's own background worker.
    expect(scripts.filter((s) => s.includes('service-worker.js'))).toEqual([]);
});

async function unlockWithPassword(page: Page): Promise<void> {
    const input = page.locator('.open__pass-input');
    await expect(input).not.toHaveAttribute('readonly', '', { timeout: 15000 });
    await input.fill(FIXTURE_PASSWORD);
    await input.press('Enter');
    await expect(page.locator('.list__item').first()).toBeVisible({ timeout: 60000 });
}

test('full mode opens a local file with default KeePass Argon2 settings', async () => {
    const page = await context.newPage();
    await page.goto(appUrl());
    const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.locator('#open__icon-open').click()
    ]);
    await chooser.setFiles(FIXTURE);
    const ok = page.locator('.modal__buttons button[data-result="ok"]');
    await ok.click({ timeout: 10000 });
    await unlockWithPassword(page);
});

test('full mode opens a vault over WebDAV without CORS headers', async () => {
    davRequests = [];
    const page = await context.newPage();
    await page.goto(appUrl());
    await page.click('#open__icon-more');
    await page.click('#open__icon-storage--webdav');
    await page.fill('#open__config-field-path', davUrl);
    await page.fill('#open__config-field-user', 'alice');
    await page.fill('#open__config-field-password', 'secret');
    await page.click('.open__config-btn-ok');
    await unlockWithPassword(page);

    expect(davRequests.find((r) => r.method === 'GET')?.auth).toBe(`Basic ${btoa('alice:secret')}`);

    // Control: an ordinary web page is blocked from the same server.
    const site = await context.newPage();
    await site.goto('https://github.com/login');
    const fromPage = await site.evaluate((url) =>
        fetch(url).then(
            () => 'allowed',
            () => 'blocked'
        ),
        davUrl
    );
    expect(fromPage).toBe('blocked');
});

test('connect mode fills from an app already open in a tab', async () => {
    await sw.evaluate((url) => chrome.storage.local.set({ keeWebUrl: url }), serverUrl);

    const app = await context.newPage();
    await app.goto(serverUrl);
    await app.click('#open__icon-demo');
    await expect(app.locator('.list__item').first()).toBeVisible({ timeout: 30000 });

    const site = await context.newPage();
    await site.goto('https://github.com/login');
    await site.evaluate(() => {
        document.querySelector('form')!.addEventListener(
            'submit',
            (e) => {
                e.preventDefault();
                e.stopImmediatePropagation();
            },
            { capture: true }
        );
    });
    await site.focus('#login_field');
    await clickToolbarButton('https://github.com/login');

    await app.locator("button[data-result='yes']").click({ timeout: 15000 });
    await expect(site.locator('#login_field')).toHaveValue('demouser', { timeout: 15000 });
    await expect(site.locator('#password')).not.toHaveValue('');
    expect(context.pages().some((p) => p.url().startsWith(appUrl()))).toBe(false);
});

test('the options page switches between the two modes', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/pages/options.html`);
    const stored = () =>
        sw.evaluate(() => chrome.storage.local.get(['keeWebUrl']).then((r) => r.keeWebUrl));

    await expect(page.locator('#vault-mode-full')).toBeChecked({ timeout: 15000 });
    expect(await stored()).toBeUndefined();

    await page.check('#vault-mode-connect');
    await expect.poll(stored).toBe('https://keewebx.app/');

    await page.check('#vault-mode-full');
    await expect.poll(stored).toBeUndefined();
});
