import { test, expect, chromium } from '@playwright/test';
import type { BrowserContext, Page, Worker as PlaywrightWorker } from '@playwright/test';
import * as kdbxweb from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';
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
 *   bun run build && (cd modules/extension && bun run build-chrome-vault)
 *   bunx playwright test -c e2e/extension/vault.playwright.config.ts
 */

const EXT_PATH = process.env.KW_E2E_EXTENSION_DIR || path.resolve(__dirname, '../../modules/extension/dist/chrome-vault');
const VECTORS = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../modules/db/test/crypto/argon2-vectors.json'), 'utf8')
) as Array<Record<string, any>>;

const LOGIN_HTML = `<!doctype html><title>Sign in</title><form action="/session" method="post">
<input id="login_field" name="login" autocomplete="username">
<input id="password" name="password" type="password" autocomplete="current-password">
<button type="submit">Sign in</button></form>`;

const CORE_DIST = path.resolve(__dirname, '../../dist');
const FIXTURE = path.resolve(
    __dirname,
    '../../modules/db/resources/external/test_db_kdbx4_with_password_argon2.kdbx'
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
        args: [
            `--disable-extensions-except=${EXT_PATH}`,
            `--load-extension=${EXT_PATH}`,
            // The offscreen vault is not a page Playwright controls, so the
            // test server's self-signed certificate needs this.
            '--ignore-certificate-errors'
        ]
    });
    davRequests = [];
    davPutDelayMs = 0;
    davFiles = new Map();
    davPut('/vault.kdbx', fs.readFileSync(FIXTURE));
    sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(sw.url()).host;
    // First install opens the start page in a tab.
    const isStart = (p: Page) => p.url().includes('pages/popup.html?view=tab');
    await expect.poll(() => context.pages().find(isStart), { timeout: 15000 }).toBeTruthy();
    await context.pages().find(isStart)!.close();
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

    // The shortcut path: one matching login is filled without asking.
    await clickToolbarButton('https://github.com/login');

    await expect(site.locator('#login_field')).toHaveValue('demouser', { timeout: 15000 });
    await expect(site.locator('#password')).not.toHaveValue('');
    expect(await vault.locator('.modal').count()).toBe(0);
    await shot(site, '02-full-mode-autofill');
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

test('the settings page switches between the two modes', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/pages/settings.html`);
    const stored = () =>
        sw.evaluate(() => chrome.storage.local.get(['keeWebUrl']).then((r) => r.keeWebUrl));

    await expect(page.locator('#vault-mode-full')).toBeChecked({ timeout: 15000 });
    expect(await stored()).toBeUndefined();

    await expect(page.locator('#databases')).toBeVisible();
    await shot(page, '08-options-full-mode');
    await page.check('#vault-mode-connect');
    await expect.poll(stored).toBe('https://keewebx.app/');
    await expect(page.locator('#server-default')).toBeChecked();
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

// ---- Popup, side panel and settings (full mode) ----

const POPUP = { width: 380, height: 560 };

async function openSite(): Promise<Page> {
    const site = await context.newPage();
    await site.goto('https://github.com/login');
    await site.evaluate(() => {
        (window as any).submitted = false;
        document.querySelector('form')!.addEventListener(
            'submit',
            (e) => {
                e.preventDefault();
                e.stopImmediatePropagation();
                (window as any).submitted = true;
            },
            { capture: true }
        );
    });
    return site;
}

async function tabIdOf(page: Page): Promise<number> {
    const id = await sw.evaluate(
        async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
        page.url()
    );
    expect(id).toBeDefined();
    return id!;
}

/** The popup page, opened in a tab that stands in for the toolbar popup. */
async function openPopup(site?: Page, file = 'popup.html', size = POPUP): Promise<Page> {
    const query = site ? `?tab=${await tabIdOf(site)}` : '';
    const page = await context.newPage();
    await page.setViewportSize(size);
    await page.goto(`chrome-extension://${extensionId}/pages/${file}${query}`);
    return page;
}

const offscreenOpen = () => sw.evaluate(() => chrome.offscreen.hasDocument());
const vaultTabOpen = () =>
    sw.evaluate(async (url) => (await chrome.tabs.query({})).some((t) => t.url?.startsWith(url)), appUrl());

async function openDemoInPopup(site?: Page): Promise<Page> {
    const popup = await openPopup(site);
    await popup.click('#start-demo', { timeout: 20000 });
    await expect(popup.locator('#search')).toBeVisible({ timeout: 30000 });
    return popup;
}

test('popup: first run, then the demo vault runs hidden inside the extension', async () => {
    const site = await openSite();
    const popup = await openPopup(site);
    await expect(popup.locator('.start__title')).toHaveText('Open your vault', { timeout: 20000 });
    await shot(popup, '20-popup-start');

    await popup.click('#start-demo');
    await expect(popup.locator('.section').first()).toHaveText('Suggested for github.com', { timeout: 30000 });
    await expect(popup.locator('.row--selected .row__title')).toHaveText('GitHub');
    await expect(popup.locator('#sync-state')).toHaveText('Up to date');
    await shot(popup, '21-popup-list');

    // No app tab: the vault lives in an offscreen document.
    expect(await offscreenOpen()).toBe(true);
    expect(await vaultTabOpen()).toBe(false);
});

test('popup: fills the login picked for the site without submitting', async () => {
    const site = await openSite();
    const popup = await openDemoInPopup(site);
    await popup.locator('.row--selected .fill-btn').click();
    await expect(site.locator('#login_field')).toHaveValue('demouser', { timeout: 15000 });
    await expect(site.locator('#password')).not.toHaveValue('');
    expect(await site.evaluate(() => (window as any).submitted)).toBe(false);
    await shot(site, '22-popup-filled-site');
});

test('popup: fills the whole form even when the password field has focus', async () => {
    const site = await openSite();
    await site.focus('#password');
    const popup = await openDemoInPopup(site);
    await popup.locator('.row--selected .fill-btn').click();
    await expect(site.locator('#login_field')).toHaveValue('demouser', { timeout: 15000 });
    await expect(site.locator('#password')).not.toHaveValue('');
});

test('popup: search, details and copy', async () => {
    const site = await openSite();
    // Extension origins cannot be granted permissions; read it back on the site.
    await context.grantPermissions(['clipboard-read'], { origin: 'https://github.com' });
    const popup = await openDemoInPopup(site);

    await popup.fill('#search', 'gmail');
    await expect(popup.locator('.section')).toHaveText('Results');
    await expect(popup.locator('.row__title').first()).toContainText(/gmail/i);
    await popup.fill('#search', '');

    await popup.locator('.row--selected .row__main').click();
    await expect(popup.locator('.bar__title')).toHaveText('GitHub');
    await expect(popup.locator('[data-field="user"] .fields__value')).toHaveText('demouser');
    await shot(popup, '23-popup-detail');

    await popup.locator('[data-field="user"]').click();
    await expect(popup.locator('[data-field="user"] .fields__copy')).toHaveText('Copied');
    await site.bringToFront();
    expect(await site.evaluate(() => navigator.clipboard.readText())).toBe('demouser');
    await popup.bringToFront();

    await popup.click('#detail-back');
    await expect(popup.locator('#search')).toBeVisible();
});

test('popup: adds a WebDAV vault, rejects a wrong password, locks and unlocks', async () => {
    const popup = await openPopup();
    await popup.click('#start-webdav', { timeout: 20000 });
    await popup.fill('#webdav-url', davUrl);
    await popup.fill('#webdav-user', 'alice');
    await popup.fill('#webdav-pass', 'secret');
    await shot(popup, '24-popup-webdav');
    await popup.click('#webdav-connect');

    await expect(popup.locator('.unlock__name')).toHaveText('vault.kdbx');
    await popup.fill('#unlock-password', 'wrong');
    await popup.click('#unlock-submit');
    await expect(popup.locator('#unlock-error')).toHaveText('Wrong password', { timeout: 60000 });
    await shot(popup, '25-popup-wrong-password');

    await popup.fill('#unlock-password', FIXTURE_PASSWORD);
    await popup.click('#unlock-submit');
    await expect(popup.locator('#search')).toBeVisible({ timeout: 60000 });
    await expect(popup.locator('.foot__name')).toHaveText('vault.kdbx');
    expect(davRequests.find((r) => r.method === 'GET')?.auth).toBe(`Basic ${btoa('alice:secret')}`);

    await popup.click('#lock');
    await expect(popup.locator('.unlock__name')).toHaveText('vault.kdbx', { timeout: 15000 });
    await shot(popup, '26-popup-locked');

    // A fresh popup remembers the vault and only asks for the password.
    const again = await openPopup();
    await expect(again.locator('.unlock__name')).toHaveText('vault.kdbx', { timeout: 20000 });
    await again.fill('#unlock-password', FIXTURE_PASSWORD);
    await again.click('#unlock-submit');
    await expect(again.locator('#search')).toBeVisible({ timeout: 60000 });
});

test('side panel follows the active tab', async () => {
    const site = await openSite();
    await openDemoInPopup(site);
    const panel = await openPopup(site, 'sidepanel.html', { width: 400, height: 760 });
    await expect(panel.locator('.section').first()).toHaveText('Suggested for github.com', { timeout: 20000 });
    await shot(panel, '27-side-panel');
});

test('popup in dark mode', async () => {
    const site = await openSite();
    const popup = await openDemoInPopup(site);
    await popup.emulateMedia({ colorScheme: 'dark' });
    await expect(popup.locator('body')).toHaveCSS('background-color', 'rgb(23, 25, 31)');
    await shot(popup, '28-popup-dark');
});

test('popup theme switches in one click, persists and follows the system when selected', async () => {
    const popup = await openPopup();
    await popup.emulateMedia({ colorScheme: 'light' });
    await popup.getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect(popup.locator('body')).toHaveCSS('background-color', 'rgb(23, 25, 31)');
    await popup.reload();
    await expect(popup.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();
    const settings = await openPopup(undefined, 'settings.html', { width: 720, height: 820 });
    await expect(settings.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark');
    await settings.getByRole('combobox', { name: 'Theme' }).selectOption('light');
    await expect(popup.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await settings.getByRole('combobox', { name: 'Theme' }).selectOption('system');
    await popup.emulateMedia({ colorScheme: 'dark' });
    await expect(popup.locator('body')).toHaveCSS('background-color', 'rgb(23, 25, 31)');
});

test('settings change the vault security options', async () => {
    const site = await openSite();
    await openDemoInPopup(site);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/pages/settings.html`);
    await expect(page.locator('#databases')).toBeVisible({ timeout: 20000 });
    await page.selectOption('#setting-auto-lock', '5');
    await page.selectOption('#setting-clipboard', '30');
    await page.check('#setting-lock-screen');
    await expect(page.locator('#databases')).toContainText('Demo');

    const settings = await page.evaluate(async () => {
        const r = await chrome.runtime.sendMessage({ action: 'vault', request: { vault: 'status' } });
        return r.result.settings;
    });
    expect(settings).toEqual({ idleMinutes: 5, clipboardSeconds: 30, lockOnOsLock: true });
    await shot(page, '29-settings-full');
});

test('opening the full app moves the vault into a tab', async () => {
    const site = await openSite();
    const popup = await openDemoInPopup(site);
    expect(await offscreenOpen()).toBe(true);
    await popup.click('#open-app');
    await expect.poll(vaultTabOpen, { timeout: 15000 }).toBe(true);
    await expect.poll(offscreenOpen, { timeout: 15000 }).toBe(false);
});

// ---- Web mode: KeeWebX open in a tab, listed through the paired protocol ----

async function openWebApp(): Promise<Page> {
    const app = await context.newPage();
    await app.goto(serverUrl);
    // After the first time, the app moves the demo into the More menu.
    if (!(await app.locator('#open__icon-demo').isVisible())) {
        await app.click('#open__icon-more');
    }
    await app.click('#open__icon-demo');
    await expect(app.locator('.list__item').first()).toBeVisible({ timeout: 30000 });
    return app;
}

async function useWebMode(): Promise<void> {
    await sw.evaluate((url) => chrome.storage.local.set({ keeWebUrl: url }), serverUrl);
}

test('web mode popup: asks to open KeeWebX when no tab has it', async () => {
    await useWebMode();
    const site = await openSite();
    const popup = await openPopup(site);
    await expect(popup.locator('#web-title')).toHaveText('KeeWebX is not open', { timeout: 15000 });
    await shot(popup, '40-web-not-open');
});

test('web mode popup: one approval, then list, details, copy and fill', async () => {
    await useWebMode();
    const app = await openWebApp();
    const site = await openSite();

    // First list request: the app asks once, with listing offered.
    const popup = await openPopup(site);
    const canList = app.locator('#extension-connect__can-list');
    await expect(canList).toBeChecked({ timeout: 20000 });
    await app.bringToFront();
    await shot(app, '41-web-app-approval');
    await app.locator("button[data-result='yes']").click();

    await popup.bringToFront();
    await expect(popup.locator('.section').first()).toHaveText('Suggested for github.com', { timeout: 20000 });
    await expect(popup.locator('.row--selected .row__title')).toHaveText('GitHub');
    await expect(popup.locator('.row--selected .tile svg')).toHaveCount(1);
    await expect(popup.locator('#web-state')).toHaveText('Connected');
    await shot(popup, '42-web-list');

    await popup.fill('#search', 'gmail');
    await expect(popup.locator('.row__title').first()).toContainText(/gmail/i, { timeout: 15000 });
    await popup.fill('#search', '');

    await popup.locator('.row--selected .row__main').click();
    await expect(popup.locator('[data-field="user"] .fields__value')).toHaveText('demouser');
    await popup.locator('[data-field="password"]').click();
    await expect(popup.locator('[data-field="password"] .fields__copy')).toHaveText('Copied', { timeout: 15000 });
    await shot(popup, '43-web-detail');
    await popup.click('#detail-fill');

    await expect(site.locator('#login_field')).toHaveValue('demouser', { timeout: 15000 });
    await expect(site.locator('#password')).not.toHaveValue('');
    expect(await site.evaluate(() => (window as any).submitted)).toBe(false);
});

test('web mode popup: the approval is kept for this extension in a new app session', async () => {
    await useWebMode();
    const app = await openWebApp();
    const site = await openSite();
    const first = await openPopup(site);
    await app.locator("button[data-result='yes']").click({ timeout: 20000 });
    await expect(first.locator('.row--selected')).toBeVisible({ timeout: 20000 });

    // A new app session and a new connection: no second question.
    await app.close();
    const reopened = await openWebApp();
    const again = await openPopup(site);
    await expect(again.locator('.row--selected .row__title')).toHaveText('GitHub', { timeout: 20000 });
    await expect(reopened.locator('.modal')).toHaveCount(0);
});

test('web mode popup: locking shows how to unlock in the tab', async () => {
    await useWebMode();
    const app = await openWebApp();
    const site = await openSite();
    const popup = await openPopup(site);
    await app.locator("button[data-result='yes']").click({ timeout: 20000 });
    await expect(popup.locator('.row--selected')).toBeVisible({ timeout: 20000 });

    await popup.click('#lock');
    await expect(popup.locator('#web-title')).toHaveText('KeeWebX is locked', { timeout: 15000 });
    await expect(popup.locator('#web-unlock')).toHaveText('Unlock in KeeWebX');
    await expect(app.locator('#open__icon-open')).toBeVisible({ timeout: 15000 });
    await shot(popup, '44-web-locked');
});

// ---- Acceptance video (opt-in) ----
// KW_E2E_DEMO=<dir> records frames of a guided run into <dir>/frames, with the
// popup drawn over the page the way Chrome shows it. Encode them with any
// tool that reads numbered PNGs and times.txt (milliseconds per frame).

const DEMO_DIR = process.env.KW_E2E_DEMO;
const DEMO_FILE = path.resolve(__dirname, '../../modules/vault/resources/Demo.kdbx');

interface Scene {
    main: Page;
    address: string;
    overlay?: Page;
    overlayKind?: 'popup' | 'side';
    caption: string;
}

const DEMO_LOGIN_HTML = `<!doctype html><title>Sign in</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f8fa;font:15px -apple-system,"Helvetica Neue",sans-serif;color:#1f2328}
form{width:320px;background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:28px}
h1{margin:0 0 20px;font-size:22px;font-weight:600;text-align:center}
label{display:block;margin:14px 0 6px;font-size:14px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d0d7de;border-radius:7px;font:inherit}
input:focus{outline:2px solid #0a6fe8;border-color:transparent}
button{width:100%;margin-top:22px;padding:10px;border:0;border-radius:7px;background:#1f2328;color:#fff;font:inherit;font-weight:600}
</style><form action="/session" method="post"><h1>Sign in</h1>
<label for="login_field">Username or email</label><input id="login_field" name="login" autocomplete="username">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
<button type="submit">Sign in</button></form>`;

function compositeHtml(): string {
    return `<!doctype html><meta charset=utf-8><style>
body{margin:0;width:1280px;height:940px;overflow:hidden;background:#dee1e6;font:13px -apple-system,"PingFang SC","Helvetica Neue",sans-serif}
.top{height:76px;position:relative}
.tab{position:absolute;left:12px;top:8px;width:230px;height:30px;background:#fff;border-radius:9px 9px 0 0;display:flex;align-items:center;padding:0 12px;color:#333}
.addr{position:absolute;left:12px;right:12px;top:38px;height:34px;background:#fff;display:flex;align-items:center;gap:10px;padding:0 10px}
.url{flex:1;background:#f1f3f4;border-radius:16px;height:26px;display:flex;align-items:center;padding:0 14px;color:#202124}
.ext{width:26px;height:26px;border-radius:6px;display:flex;align-items:center;justify-content:center}
.ext.on{background:#e8eaed}
.ext img{width:18px;height:18px}
.stage{position:relative;width:1280px;height:800px;background:#fff;overflow:hidden}
#main{position:absolute;left:0;top:0;width:1280px;height:800px}
#pop{position:absolute;right:14px;top:4px;width:380px;height:560px;border-radius:10px;box-shadow:0 10px 36px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.08)}
#side{position:absolute;right:0;top:0;width:400px;height:800px;border-left:1px solid #dadce0}
.cap{height:64px;background:#111a2b;color:#fff;display:flex;align-items:center;padding:0 28px;font-size:21px;font-weight:600;letter-spacing:.01em}
</style>
<div class=top><div class=tab id=title>Sign in</div><div class=addr><div class=url id=address></div><div class=ext id=extbtn><img id=icon></div></div></div>
<div class=stage><img id=main><img id=pop hidden><img id=side hidden></div>
<div class=cap id=cap></div>`;
}

test('acceptance video', async () => {
    test.skip(!DEMO_DIR, 'set KW_E2E_DEMO to record');
    test.setTimeout(300000);
    const framesDir = path.join(DEMO_DIR!, 'frames');
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir, { recursive: true });
    davPut('/vault.kdbx', fs.readFileSync(DEMO_FILE));
    // A plain, neutral sign-in page with the same fields as the test page.
    await context.unroute('https://github.com/login');
    await context.route('https://github.com/login', (route) =>
        route.fulfill({ contentType: 'text/html', body: DEMO_LOGIN_HTML })
    );

    const site = await openSite();
    const popupFor = async () => openPopup(site);
    const scene: Scene = { main: site, address: 'github.com/login', caption: '' };
    const raw: Array<{ t: number; main: Buffer; overlay?: Buffer; kind?: string; address: string; caption: string }> = [];
    const start = Date.now();
    let recording = true;
    const recorder = (async () => {
        while (recording) {
            try {
                const [main, overlay] = await Promise.all([
                    scene.main.screenshot(),
                    scene.overlay && !scene.overlay.isClosed() ? scene.overlay.screenshot() : Promise.resolve(undefined)
                ]);
                raw.push({ t: Date.now() - start, main, overlay, kind: scene.overlayKind, address: scene.address, caption: scene.caption });
            } catch {
                await new Promise((r) => setTimeout(r, 30));
            }
        }
    })();
    const hold = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const say = async (caption: string, ms = 1600) => {
        scene.caption = caption;
        await hold(ms);
    };

    // 1. First run
    let popup = await popupFor();
    scene.overlay = popup;
    scene.overlayKind = 'popup';
    await expect(popup.locator('.start__title')).toBeVisible({ timeout: 20000 });
    await say('1  点工具栏图标，先打开一个 KeePass 数据库', 2600);

    // 2. WebDAV
    await say('2  连接 WebDAV 上的数据库', 300);
    await popup.click('#start-webdav');
    await popup.locator('#webdav-url').pressSequentially(davUrl, { delay: 25 });
    await popup.locator('#webdav-user').pressSequentially('alice', { delay: 60 });
    await popup.locator('#webdav-pass').pressSequentially('secret', { delay: 60 });
    await hold(700);
    await popup.click('#webdav-connect');

    // 3. Unlock
    await say('3  输入主密码解锁。数据库在扩展里后台运行，不用开标签页', 900);
    await popup.locator('#unlock-password').pressSequentially('demo', { delay: 110 });
    await hold(500);
    await popup.click('#unlock-submit');
    await expect(popup.locator('.row--selected')).toBeVisible({ timeout: 60000 });
    await say('4  自动推荐当前网站的登录项', 2600);

    // 5. Search
    await say('5  搜索整个数据库', 300);
    await popup.locator('#search').pressSequentially('mail', { delay: 150 });
    await hold(1800);
    await popup.fill('#search', '');
    await hold(600);

    // 6. Details and copy
    await say('6  查看详情，点一下就复制', 400);
    await popup.locator('.row--selected .row__main').click();
    await hold(1400);
    await popup.locator('[data-field="password"]').click();
    await hold(1700);
    await popup.click('#detail-back');
    await hold(700);

    // 7. Fill
    await say('7  点 Fill 填入网页，不会自动提交', 900);
    await popup.locator('.row--selected .fill-btn').click();
    scene.overlay = undefined;
    await expect(site.locator('#login_field')).toHaveValue('demouser', { timeout: 15000 });
    await hold(2600);

    // 8. Side panel
    const panel = await openPopup(site, 'sidepanel.html', { width: 400, height: 800 });
    await expect(panel.locator('.row--selected')).toBeVisible({ timeout: 20000 });
    scene.overlay = panel;
    scene.overlayKind = 'side';
    await say('8  也可以放在侧边栏，跟着当前标签页走', 3000);

    // 9. Lock and unlock
    popup = await popupFor();
    await expect(popup.locator('#lock')).toBeVisible({ timeout: 20000 });
    scene.overlay = popup;
    scene.overlayKind = 'popup';
    await say('9  一键锁定', 1000);
    await popup.click('#lock');
    await expect(popup.locator('.unlock__name')).toBeVisible({ timeout: 15000 });
    await hold(1300);
    await say('   再打开只需输入主密码', 300);
    await popup.locator('#unlock-password').pressSequentially('demo', { delay: 110 });
    await popup.click('#unlock-submit');
    await expect(popup.locator('.row--selected')).toBeVisible({ timeout: 60000 });
    await hold(1500);

    // 10. Dark mode
    await popup.emulateMedia({ colorScheme: 'dark' });
    await say('10  深色模式跟随系统', 2600);
    await popup.emulateMedia({ colorScheme: 'light' });

    // 11. Settings
    const settings = await context.newPage();
    await settings.setViewportSize(VIEWPORT);
    await settings.goto(`chrome-extension://${extensionId}/pages/settings.html`);
    await expect(settings.locator('#databases')).toContainText('vault.kdbx', { timeout: 20000 });
    scene.main = settings;
    scene.address = 'KeeWebX 设置';
    scene.overlay = undefined;
    await say('11  设置：完整模式（数据库在扩展里）', 1800);
    await settings.selectOption('#setting-auto-lock', '5');
    await hold(1000);
    await settings.check('#vault-mode-connect');
    await say('     Web 模式：连接 keewebx.app 或自建地址', 2400);
    await settings.locator('#server-url').pressSequentially(serverUrl, { delay: 30 });
    await settings.locator('#server-url').press('Enter');
    await hold(900);

    // 12. Web mode: KeeWebX open in a tab
    const app = await openWebApp();
    scene.main = app;
    scene.address = new URL(serverUrl).host;
    await say('12  Web 模式：数据库在 KeeWebX 标签页里打开', 1800);
    popup = await popupFor();
    await expect(app.locator('#extension-connect__can-list')).toBeChecked({ timeout: 20000 });
    await say('13  第一次列出登录项时，KeeWebX 只问这一次', 2600);
    await app.locator("button[data-result='yes']").click();
    scene.main = site;
    scene.address = 'github.com/login';
    scene.overlay = popup;
    scene.overlayKind = 'popup';
    await expect(popup.locator('.row--selected')).toBeVisible({ timeout: 20000 });
    await say('14  之后和完整模式一样：推荐、搜索、填入', 2200);
    await site.fill('#login_field', '');
    await site.fill('#password', '');
    await popup.locator('.row--selected .fill-btn').click();
    scene.overlay = undefined;
    await expect(site.locator('#login_field')).toHaveValue('demouser', { timeout: 15000 });
    await hold(2000);

    recording = false;
    await recorder;

    // Compose frames.
    const composer = await context.newPage();
    await composer.setViewportSize({ width: 1280, height: 940 });
    await composer.setContent(compositeHtml());
    const icon = fs.readFileSync(path.join(EXT_PATH, 'icons/toolbar32.png')).toString('base64');
    await composer.evaluate((src) => ((document.getElementById('icon') as HTMLImageElement).src = src), `data:image/png;base64,${icon}`);
    const times: number[] = [];
    for (const [i, f] of raw.entries()) {
        await composer.evaluate(
            ({ main, overlay, kind, address, caption }) => {
                const $ = (id: string) => document.getElementById(id) as HTMLImageElement;
                $('main').src = main;
                $('pop').hidden = !(overlay && kind === 'popup');
                $('side').hidden = !(overlay && kind === 'side');
                if (overlay) {
                    $(kind === 'side' ? 'side' : 'pop').src = overlay;
                }
                $('extbtn').className = overlay && kind === 'popup' ? 'ext on' : 'ext';
                $('address').textContent = address;
                $('title').textContent = address.startsWith('github') ? 'Sign in' : address.startsWith('localhost') ? 'KeeWebX' : 'KeeWebX';
                $('cap').textContent = caption;
                return Promise.all([...document.images].map((im) => im.decode().catch(() => {})));
            },
            {
                main: `data:image/png;base64,${f.main.toString('base64')}`,
                overlay: f.overlay ? `data:image/png;base64,${f.overlay.toString('base64')}` : '',
                kind: f.kind,
                address: f.address,
                caption: f.caption
            }
        );
        await composer.screenshot({ path: path.join(framesDir, `${String(i).padStart(5, '0')}.png`) });
        times.push(f.t);
    }
    fs.writeFileSync(path.join(framesDir, 'times.txt'), times.join('\n') + '\n');
    expect(raw.length).toBeGreaterThan(50);
});

test('popup preserves custom and built-in entry icons with a key fallback, never letters', async () => {
    const db = await loadVault(davFiles.get('/vault.kdbx')!.data);
    const iconId = kdbxweb.KdbxUuid.random();
    db.meta.customIcons.set(iconId.id, {
        data: new Uint8Array(fs.readFileSync(path.join(EXT_PATH, 'icons/icon48.png'))).buffer as ArrayBuffer
    });
    const pictured = db.createEntry(db.getDefaultGroup());
    pictured.fields.set('Title', 'With picture');
    pictured.customIcon = iconId;
    const builtIn = db.createEntry(db.getDefaultGroup());
    builtIn.fields.set('Title', 'With icon');
    builtIn.icon = 1;
    davPut('/vault.kdbx', Buffer.from(await db.save()));

    const popup = await openPopup();
    await popup.click('#start-webdav', { timeout: 20000 });
    await popup.fill('#webdav-url', davUrl);
    await popup.fill('#webdav-user', 'alice');
    await popup.fill('#webdav-pass', 'secret');
    await popup.click('#webdav-connect');
    await popup.fill('#unlock-password', FIXTURE_PASSWORD);
    await popup.click('#unlock-submit');
    await expect(popup.locator('#search')).toBeVisible({ timeout: 60000 });

    const tile = (title: string) => popup.locator(`.row[data-entry="${title}"] .tile`);
    await expect(tile('With picture').locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(tile('With picture').locator('svg')).toHaveCount(0);
    await expect(tile('With icon').locator('svg')).toHaveCount(1);
    await expect(tile('With icon').locator('svg path').first()).toHaveAttribute('d', /.+/);
    await expect(tile('With icon')).toHaveText('');
    await expect(tile('Test').locator('svg')).toHaveCount(1);
    await expect(tile('Test')).toHaveText('');
    // The standard icon and key fallback must remain visually distinct.
    expect(await tile('With icon').locator('svg').innerHTML()).not.toBe(
        await tile('Test').locator('svg').innerHTML()
    );
    await shot(popup, '31-popup-entry-icons');

    // The demo vault: every entry there has its own icon.
    const site = await openSite();
    const demo = await openPopup(site);
    await demo.click('#lock');
    await demo.click('#unlock-other');
    await demo.click('#start-demo');
    await expect(demo.locator('.row--selected .tile svg')).toHaveCount(1, { timeout: 30000 });
    await shot(demo, '32-popup-demo-icons');
});

