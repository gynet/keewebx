import { test, expect, chromium } from '@playwright/test';
import type { BrowserContext, Page, Worker as PlaywrightWorker } from '@playwright/test';
import * as kdbxweb from '../../packages/db/lib';
import { argon2 } from '../../packages/db/test/test-support/argon2';
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

// Set KW_E2E_ARTIFACTS=<dir> to keep screenshots and videos for review.
const ARTIFACTS = process.env.KW_E2E_ARTIFACTS;
const VIEWPORT = { width: 1280, height: 800 };

async function shot(page: Page, name: string): Promise<void> {
    if (ARTIFACTS) {
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
    }
}

let server: http.Server;
let serverUrl = '';
// A real server, because Playwright's route.fulfill adds CORS headers itself.
let davServer: https.Server;
let davUrl = '';
let davRequests: Array<{ method: string; path: string; auth?: string; destination?: string }> = [];
// Writable in-memory file store, keyed by URL path.
let davFiles = new Map<string, { data: Buffer; modified: number }>();
let davClock = 0;
// Delays each PUT, to edit while a save is in flight.
let davPutDelayMs = 0;

function davPut(pathname: string, data: Buffer): void {
    // Whole seconds, like a real server's Last-Modified; each write must differ.
    davClock += 1;
    davFiles.set(pathname, { data, modified: Date.UTC(2026, 10, 10, 10, 0, davClock) });
}
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
            const pathname = decodeURIComponent(new URL(req.url!, 'https://x').pathname);
            const destination = req.headers.destination as string | undefined;
            davRequests.push({
                method: req.method!,
                path: pathname,
                auth: req.headers.authorization,
                destination
            });
            const chunks: Buffer[] = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => {
                const file = davFiles.get(pathname);
                if (req.method === 'PUT') {
                    setTimeout(() => {
                        davPut(pathname, Buffer.concat(chunks));
                        res.writeHead(201).end();
                    }, davPutDelayMs);
                } else if (!file) {
                    res.writeHead(404).end();
                } else if (req.method === 'MOVE') {
                    davFiles.delete(pathname);
                    davPut(new URL(destination!).pathname, file.data);
                    res.writeHead(201).end();
                } else if (req.method === 'DELETE') {
                    davFiles.delete(pathname);
                    res.writeHead(204).end();
                } else {
                    // Deliberately no Access-Control-Allow-Origin.
                    res.writeHead(200, {
                        'content-type': 'application/octet-stream',
                        'last-modified': new Date(file.modified).toUTCString(),
                        etag: `"${file.modified}"`
                    });
                    res.end(req.method === 'HEAD' ? undefined : file.data);
                }
            });
        }
    );
    await new Promise<void>((resolve) => davServer.listen(0, '127.0.0.1', resolve));
    davUrl = `https://localhost:${(davServer.address() as AddressInfo).port}/vault.kdbx`;
});

test.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => davServer.close(resolve));
});

test.beforeEach(async ({}, testInfo) => {
    context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'kw-vault-')), {
        channel: 'chromium',
        headless: true,
        ignoreHTTPSErrors: true,
        viewport: VIEWPORT,
        ...(ARTIFACTS
            ? {
                  recordVideo: {
                      dir: path.join(ARTIFACTS, 'video', testInfo.title.replace(/\W+/g, '-')),
                      size: VIEWPORT
                  }
              }
            : {}),
        args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`]
    });
    davRequests = [];
    davPutDelayMs = 0;
    davFiles = new Map();
    davPut('/vault.kdbx', fs.readFileSync(FIXTURE));
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
    await shot(page, '01-full-mode-vault-in-extension');
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
    await shot(site, '02-full-mode-autofill');
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
    await shot(page, '03-full-mode-local-file');
});

async function openFromWebDav(): Promise<Page> {
    const page = await context.newPage();
    await page.goto(appUrl());
    await page.click('#open__icon-more');
    await page.click('#open__icon-storage--webdav');
    await page.fill('#open__config-field-path', davUrl);
    await page.fill('#open__config-field-user', 'alice');
    await page.fill('#open__config-field-password', 'secret');
    await shot(page, '04-webdav-connect-form');
    await page.click('.open__config-btn-ok');
    await unlockWithPassword(page);
    return page;
}

test('full mode opens a vault over WebDAV without CORS headers', async () => {
    await openFromWebDav();

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
    await shot(site, '07-connect-mode-autofill');
});

test('the options page switches between the two modes', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/pages/options.html`);
    const stored = () =>
        sw.evaluate(() => chrome.storage.local.get(['keeWebUrl']).then((r) => r.keeWebUrl));

    await expect(page.locator('#vault-mode-full')).toBeChecked({ timeout: 15000 });
    expect(await stored()).toBeUndefined();

    await shot(page, '08-options-full-mode');
    await page.check('#vault-mode-connect');
    await expect.poll(stored).toBe('https://keewebx.app/');
    await shot(page, '09-options-connect-mode');

    await page.check('#vault-mode-full');
    await expect.poll(stored).toBeUndefined();
});

async function addEntry(page: Page, title: string): Promise<void> {
    await page.locator('.list__search-btn-new').click();
    await page.locator('.dropdown__item[data-value="entry"]').click();
    const titleInput = page.locator('.details__header-title-input');
    await titleInput.fill(title);
    await titleInput.press('Enter');
}

/** Decrypts a stored file independently of the app. */
async function loadVault(data: Buffer): Promise<kdbxweb.Kdbx> {
    kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    return kdbxweb.Kdbx.load(
        new Uint8Array(data).buffer as ArrayBuffer,
        new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(FIXTURE_PASSWORD))
    );
}

async function storedTitles(): Promise<string[]> {
    const db = await loadVault(davFiles.get('/vault.kdbx')!.data);
    return db.groups.flatMap((g) => [...g.allEntries()].map((e) => String(e.fields.get('Title'))));
}

const moves = () => davRequests.filter((r) => r.method === 'MOVE').length;
const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
const unsavedSign = (page: Page) => page.locator('.footer__db-sign');

test('full mode saves each change to WebDAV on its own', async () => {
    const page = await openFromWebDav();
    const original = davFiles.get('/vault.kdbx')!.data;
    const title = `Saved over WebDAV ${Date.now()}`;

    await addEntry(page, title);
    await shot(page, '05-webdav-new-entry');

    // No save button: the change is saved shortly after it is made.
    await expect.poll(moves, { timeout: 30000 }).toBe(1);
    await expect(unsavedSign(page)).toHaveCount(0, { timeout: 30000 });
    await shot(page, '06-webdav-saved');

    // Written to a temporary file, then moved over the original.
    const put = davRequests.find((r) => r.method === 'PUT')!;
    const move = davRequests.find((r) => r.method === 'MOVE')!;
    expect(put.path).toMatch(/^\/\.vault\.kdbx\.\d+$/);
    expect(move.path).toBe(put.path);
    expect(new URL(move.destination!).pathname).toBe('/vault.kdbx');
    expect(put.auth).toBe(`Basic ${btoa('alice:secret')}`);
    expect(move.auth).toBe(put.auth);
    expect([...davFiles.keys()]).toEqual(['/vault.kdbx']);

    expect(davFiles.get('/vault.kdbx')!.data.equals(original)).toBe(false);
    expect(await storedTitles()).toContain(title);

    // Creating the entry and naming it was one burst of edits: one save.
    await page.waitForTimeout(3000);
    expect(moves()).toBe(1);
});

test('full mode keeps changes while offline and saves them when back online', async () => {
    const page = await openFromWebDav();
    const title = `Made offline ${Date.now()}`;

    await context.setOffline(true);
    await addEntry(page, title);
    await expect.poll(badge, { timeout: 30000 }).toBe('!');
    await expect(unsavedSign(page)).toHaveCount(1);
    expect(await sw.evaluate(() => chrome.action.getTitle({}))).toMatch(/Offline/);
    expect(
        await sw.evaluate(() => chrome.storage.session.get('syncState').then((r) => r.syncState.state))
    ).toBe('offline');
    expect(moves()).toBe(0);
    await shot(page, '10-offline-unsaved');

    await context.setOffline(false);
    await expect.poll(moves, { timeout: 30000 }).toBe(1);
    await expect.poll(badge, { timeout: 15000 }).toBe('');
    await expect(unsavedSign(page)).toHaveCount(0, { timeout: 15000 });
    expect(await storedTitles()).toContain(title);
    await shot(page, '11-back-online-saved');
});

test('full mode merges a change saved from another device', async () => {
    const page = await openFromWebDav();

    // Another device adds an entry to the same file on the server.
    const remote = await loadVault(davFiles.get('/vault.kdbx')!.data);
    const other = remote.createEntry(remote.getDefaultGroup());
    other.fields.set('Title', 'Added on another device');
    davPut('/vault.kdbx', Buffer.from(await remote.save()));

    const title = `Added here ${Date.now()}`;
    await addEntry(page, title);
    await expect.poll(moves, { timeout: 30000 }).toBe(1);
    await expect(unsavedSign(page)).toHaveCount(0, { timeout: 15000 });

    const titles = await storedTitles();
    expect(titles).toContain(title);
    expect(titles).toContain('Added on another device');
    // The merged entry shows up in the app too.
    await expect(page.locator('.list__item', { hasText: 'Added on another device' })).toBeVisible();
    await shot(page, '12-merged-remote-change');
});

test('full mode saves an edit made while a save is in flight', async () => {
    const page = await openFromWebDav();
    davPutDelayMs = 3000;

    await addEntry(page, 'First');
    await expect
        .poll(() => davRequests.some((r) => r.method === 'PUT'), { timeout: 30000 })
        .toBe(true);
    await addEntry(page, 'Second');

    await expect.poll(moves, { timeout: 60000 }).toBe(2);
    await expect(unsavedSign(page)).toHaveCount(0, { timeout: 15000 });
    const titles = await storedTitles();
    expect(titles).toContain('First');
    expect(titles).toContain('Second');
});
