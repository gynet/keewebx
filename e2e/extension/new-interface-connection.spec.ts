import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';
import {
    test,
    expect,
    chromium,
    type BrowserContext,
    type Page,
    type Worker
} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
/**
 * Real packaged-client acceptance against an already compiled app with
 * KEEWEBX_NEW_EXTENSION=1. Only the disposable destination site's HTML is
 * substituted. App consent, encrypted transport, storage and fill code are real.
 * The popup runs as an extension page in a headless tab; no personal profile.
 */
const ROOT = path.resolve(__dirname, '../..');
const EXT =
    process.env.KW_E2E_EXTENSION_DIR || path.join(ROOT, 'modules/extension/dist/chrome-vault');
const LEGACY_EXT =
    process.env.KW_E2E_LEGACY_EXTENSION_DIR || path.join(ROOT, 'modules/extension/dist/chrome');
const ORIGIN = process.env.KW_E2E_APP_ORIGIN || 'http://localhost:8097';
let context: BrowserContext, sw: Worker, id: string;
let diagnostics: Array<{ url: string; kind: string; text: string }> = [];
// Optional immutable build manifest verifies exactly the artifacts under test.
// It is supplied by the release harness; ordinary local runs need no private file.
test.beforeAll(() => {
    expect(
        fs.existsSync(path.join(LEGACY_EXT, 'manifest.json')),
        'Build the standard Connect package first'
    ).toBe(true);
    expect(
        fs.existsSync(path.join(EXT, 'manifest.json')),
        'Build the actual chrome-vault package first'
    ).toBe(true);
    if (process.env.KW_E2E_FINGERPRINT) {
        const manifest = JSON.parse(fs.readFileSync(process.env.KW_E2E_FINGERPRINT, 'utf8'));
        for (const [file, hash] of Object.entries(manifest.sha256))
            expect(
                createHash('sha256')
                    .update(fs.readFileSync(path.join(ROOT, file)))
                    .digest('hex'),
                file
            ).toBe(hash);
    }
});
let extraWorker: Worker | undefined;
let profile: string;
let copiedExtension: string | undefined;
test.beforeEach(async ({}, info) => {
    const legacy = info.title.startsWith('Legacy');
    let packages = legacy ? LEGACY_EXT : EXT;
    extraWorker = undefined;
    copiedExtension = undefined;
    // A byte-identical package at another unpacked path has a separate Chrome
    // extension origin and generates its own real pairing identity. No keys,
    // app globals, or protocol packets are injected by this test.
    if (info.title.includes('second paired identity')) {
        copiedExtension = fs.mkdtempSync(path.join(os.tmpdir(), 'second-extension-'));
        fs.cpSync(EXT, copiedExtension, { recursive: true });
        packages += ',' + copiedExtension;
    }
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'new-extension-'));
    context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        headless: true,
        viewport: { width: 1280, height: 800 },
        args: [`--disable-extensions-except=${packages}`, `--load-extension=${packages}`]
    });
    await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true
    });
    diagnostics = [];
    context.on('page', (page) => {
        page.on('console', (m) => {
            diagnostics.push({ url: page.url(), kind: m.type(), text: m.text() });
        });
        page.on('pageerror', (e) =>
            diagnostics.push({ url: page.url(), kind: 'pageerror', text: e.message })
        );
    });
    sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    id = new URL(sw.url()).host;
    if (!legacy) {
        await expect
            .poll(() => context.pages().some((p) => p.url().includes('popup.html?view=tab')))
            .toBe(true);
    }
    if (copiedExtension) {
        await expect.poll(() => context.serviceWorkers().length).toBe(2);
        extraWorker = context.serviceWorkers().find((worker) => worker !== sw);
    }
    for (const p of context.pages()) if (p.url().startsWith('chrome-extension:')) await p.close();
    await context.route('https://github.com/login', (r) =>
        r.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><title>Sign in</title><form><input id="login_field" autocomplete="username"><input id="password" type="password" autocomplete="current-password"><button>Sign in</button></form><script>window.submitted=false;document.querySelector("form").onsubmit=e=>{e.preventDefault();window.submitted=true}</script>'
        })
    );
});
test.afterEach(async ({}, info) => {
    if (context) {
        fs.writeFileSync(info.outputPath('console.json'), JSON.stringify(diagnostics, null, 2));
        await context.tracing.stop({ path: info.outputPath('trace.zip') });
        if (info.status !== info.expectedStatus) {
            let pages = [];
            for (const [i, p] of context.pages().entries()) {
                pages.push({
                    url: p.url(),
                    text: await p
                        .locator('body')
                        .innerText()
                        .catch(() => ''),
                    ax: await p
                        .locator('body')
                        .ariaSnapshot()
                        .catch(() => '')
                });
                await p.screenshot({ path: info.outputPath(`failure-${i}.png`) }).catch(() => {});
            }
            fs.writeFileSync(info.outputPath('pages.json'), JSON.stringify(pages, null, 2));
            console.log(JSON.stringify(pages));
        }
        await context.close();
        fs.rmSync(profile, { recursive: true, force: true });
        if (copiedExtension) fs.rmSync(copiedExtension, { recursive: true, force: true });
    }
});
async function configure(url: string) {
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${id}/pages/settings.html`);
    await expect(settings.locator('#vault-mode-full')).toBeChecked();
    // The controlled radio changes after async storage commits. A single click
    // followed by state assertions permits intermediate renders of the old mode.
    const connectMode = settings.locator('#vault-mode-connect');
    await connectMode.click();
    await expect(connectMode).toBeChecked();
    await expect(settings.locator('#server-default')).toBeChecked();
    await expect
        .poll(() => sw.evaluate(async () => (await chrome.storage.local.get('keeWebUrl')).keeWebUrl))
        .toBe('https://keewebx.app/');
    await settings.locator('#server-url').fill(url);
    await settings.locator('#server-url').press('Enter');
    await expect
        .poll(() =>
            sw.evaluate(async () => (await chrome.storage.local.get('keeWebUrl')).keeWebUrl)
        )
        .toBe(url);
    await settings.reload();
    await expect(connectMode).toBeChecked();
    await expect(settings.locator('#server-custom')).toBeChecked();
    await expect(settings.locator('#server-url')).toHaveValue(url);
    await settings.close();
}
async function appDemo(url: string, classic = false) {
    const app = await context.newPage();
    await app.goto(url);
    if (classic) {
        if (!(await app.locator('#open__icon-demo').isVisible()))
            await app.locator('#open__icon-more').click();
        await app.locator('#open__icon-demo').click();
        await expect(app.locator('.list__item').first()).toBeVisible();
    } else {
        await app.locator('#open-demo').click();
        await expect(app.locator('.entry-row').first()).toBeVisible();
    }
    return app;
}
async function sitePage() {
    const site = await context.newPage();
    await site.goto('https://github.com/login');
    return site;
}
async function popup(site: Page) {
    const tab = await sw.evaluate(
        async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
        site.url()
    );
    expect(tab).toBeDefined();
    const p = await context.newPage();
    await p.setViewportSize({ width: 380, height: 560 });
    await p.goto(`chrome-extension://${id}/pages/popup.html?tab=${tab}`);
    return p;
}
async function approve(app: Page, classic = false) {
    if (classic) {
        await expect(app.locator('#extension-connect__can-list')).toBeChecked();
        await app.locator('button[data-result="yes"]').click();
    } else {
        const dialog = app.getByRole('dialog', {
            name: 'Allow browser extension access',
            exact: true
        });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        await expect(
            dialog.getByRole('checkbox', {
                name: 'Allow listing and searching entries',
                exact: true
            })
        ).toBeChecked();
        await dialog.getByRole('button', { name: 'Allow', exact: true }).click();
    }
}
async function connected(p: Page) {
    await expect(p.locator('.row--selected .row__title')).toHaveText('GitHub');
    await expect(p.locator('#web-state')).toHaveText('Connected');
}
for (const variant of [
    { name: 'New canonical', route: '/next.html', classic: false },
    {
        name: 'New explicit query',
        route: '/next.html?extensionGate=paired',
        classic: false
    },
    {
        name: 'Classic explicit query',
        route: '/index.html?ui=classic',
        classic: true
    }
])
    test(`${variant.name}: UI configuration, paired approval, list/search/details/copy/fill and reconnect`, async ({}, info) => {
        const url = ORIGIN + variant.route;
        await configure(url);
        const app = await appDemo(url, variant.classic);
        const other = await context.newPage();
        await other.goto(ORIGIN + (variant.classic ? '/next.html' : '/index.html?ui=classic'));
        const site = await sitePage();
        const p = await popup(site);
        await approve(app, variant.classic);
        await connected(p);
        expect(context.pages().filter((p) => p.url() === url)).toHaveLength(1);
        expect(await other.locator('dialog[open],.modal:visible').count()).toBe(0);
        await p.locator('#search').fill('gmail');
        await expect(p.locator('.row__title').first()).toContainText(/gmail/i);
        await p.locator('#search').fill('');
        await connected(p);
        await p.locator('.row--selected .row__main').click();
        await expect(p.locator('[data-field="user"] .fields__value')).toHaveText('demouser');
        await p.locator('[data-field="password"]').click();
        await expect(p.locator('[data-field="password"] .fields__copy')).toHaveText('Copied');
        await p.screenshot({ path: info.outputPath('paired-details.png') });
        await p.locator('#detail-fill').click();
        await expect(site.locator('#login_field')).toHaveValue('demouser');
        await expect(site.locator('#password')).not.toHaveValue('');
        expect(await site.evaluate(() => (window as any).submitted)).toBe(false);
        await app.close();
        const reopened = await appDemo(url, variant.classic);
        const again = await popup(site);
        await connected(again);
        await expect(reopened.locator('dialog[open],.modal:visible')).toHaveCount(0);
        expect(context.pages().filter((p) => p.url() === url)).toHaveLength(1);
    });
async function sessions(app: Page) {
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    await app.getByRole('button', { name: 'Session permissions', exact: true }).click();
    await expect(
        app.getByRole('region', {
            name: 'Browser extension sessions',
            exact: true
        })
    ).toBeVisible();
}
test('New session Disconnect preserves approval and permits real client reconnect', async ({}, info) => {
    const url = ORIGIN + '/next.html';
    await configure(url);
    const app = await appDemo(url);
    const site = await sitePage();
    const first = await popup(site);
    await approve(app);
    await connected(first);
    await first.close();
    await sessions(app);
    await expect(app.getByRole('button', { name: 'Forget approval', exact: true })).toHaveCount(1);
    await app.getByRole('button', { name: 'Disconnect session', exact: true }).click();
    const disconnect = app.getByRole('dialog', {
        name: 'Disconnect extension session',
        exact: true
    });
    await expect(disconnect.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await disconnect.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(app.getByText('No browser extension sessions', { exact: true })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Forget approval', exact: true })).toBeVisible();
    const afterDisconnect = await popup(site);
    await connected(afterDisconnect);
    await expect(
        app.getByRole('dialog', {
            name: 'Allow browser extension access',
            exact: true
        })
    ).toHaveCount(0);
    await afterDisconnect.close();
});

async function encryptedFixture() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(
        new kdbx.Credentials(kdbx.ProtectedValue.fromString('Disposable extension password')),
        'ExtensionGate'
    );
    const entry = db.createEntry(db.groups[0]);
    entry.fields.set('Title', 'GitHub');
    entry.fields.set('UserName', 'fixture-user');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('fixture-secret'));
    entry.fields.set('URL', 'https://github.com');
    return Buffer.from(await db.save());
}
async function unlockFixture(app: Page) {
    await app.locator('#password').fill('Disposable extension password');
    await app.locator('#unlock').click();
    await expect(app.locator('.entry-row').first()).toBeVisible();
}
async function openFixture(url: string) {
    const app = await context.newPage();
    await app.goto(url);
    await app.locator('#open-file-input').setInputFiles({
        name: 'extension-gate.kdbx',
        mimeType: 'application/octet-stream',
        buffer: await encryptedFixture()
    });
    await unlockFixture(app);
    return app;
}
test('New normal lock denies paired list and fill until actual database unlock', async ({}, info) => {
    const url = ORIGIN + '/next.html';
    await configure(url);
    const app = await openFixture(url);
    const site = await sitePage();
    const p = await popup(site);
    await approve(app);
    await connected(p);
    await p.locator('#lock').click();
    await expect(p.locator('#web-title')).toHaveText('KeeWebX is locked');
    await expect(p.locator('.row__title')).toHaveCount(0);
    await expect(app.locator('#password')).toBeVisible();
    await expect(site.locator('#password')).toHaveValue('');
    await app.locator('#password').fill('wrong');
    await app.locator('#unlock').click();
    await expect(app.locator('#unlock-error')).toHaveText('Wrong password');
    const denied = await popup(site);
    await expect(denied.locator('#web-title')).toHaveText('KeeWebX is locked');
    await expect(denied.locator('.row__title')).toHaveCount(0);
    await unlockFixture(app);
    const again = await popup(site);
    await connected(again);
    await again.locator('.row--selected .fill-btn').click();
    await expect(site.locator('#login_field')).toHaveValue('fixture-user');
    await expect(site.locator('#password')).toHaveValue('fixture-secret');
    expect(await site.evaluate(() => (window as any).submitted)).toBe(false);
});
test('New retained-model recovery denies real paired access until verified return and retains invalid raw draft', async ({}, info) => {
    const url = ORIGIN + '/next.html';
    await configure(url);
    const app = await openFixture(url);
    const site = await sitePage();
    const first = await popup(site);
    await approve(app);
    await connected(first);
    await first.close();
    await app.locator('.entry-row').first().click();
    await app.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = app.locator('.entry-editor');
    await editor.getByLabel('Title', { exact: true }).fill('Retained extension draft');
    await editor.getByRole('button', { name: 'Add field', exact: true }).click();
    await editor.getByLabel('Field name', { exact: true }).fill('Title');
    await editor.getByLabel('Field value', { exact: true }).fill('Invalid but must survive');
    await app.locator('#lock').click();
    await expect(
        app.getByRole('heading', {
            name: 'Verify to recover editing',
            exact: true
        })
    ).toBeVisible();
    await expect(editor).toBeHidden();
    await expect(editor.locator('xpath=ancestor::*[@inert and @hidden]')).toHaveCount(1);
    const denied = await popup(site);
    await expect(denied.locator('#web-title')).toHaveText('KeeWebX is locked');
    await expect(denied.locator('.row__title')).toHaveCount(0);
    await expect(site.locator('#password')).toHaveValue('');
    await denied.close();
    const form = app.getByRole('form', {
        name: 'Verify database: extension-gate',
        exact: true
    });
    await form.getByLabel('Master password', { exact: true }).fill('wrong');
    await form.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(form.getByLabel('Master password', { exact: true })).toBeFocused();
    await expect(
        app.getByRole('button', { name: 'Return to unsaved changes', exact: true })
    ).toBeDisabled();
    await form.getByLabel('Master password', { exact: true }).fill('Disposable extension password');
    await form.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(form.getByRole('status')).toHaveText('Verified');
    const stillDenied = await popup(site);
    await expect(stillDenied.locator('#web-title')).toHaveText('KeeWebX is locked');
    await expect(stillDenied.locator('.row__title')).toHaveCount(0);
    await stillDenied.close();
    await app.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(
        'Retained extension draft'
    );
    await expect(editor.getByLabel('Field name', { exact: true })).toHaveValue('Title');
    await expect(editor.getByLabel('Field value', { exact: true })).toHaveValue(
        'Invalid but must survive'
    );
    const recovered = await popup(site);
    await connected(recovered);
    await recovered.screenshot({
        path: info.outputPath('paired-after-verified-return.png')
    });
});

test('New identity Forget is durable and denies list until explicit reapproval', async () => {
    const url = ORIGIN + '/next.html';
    await configure(url);
    const app = await appDemo(url);
    const site = await sitePage();
    const first = await popup(site);
    await approve(app);
    await connected(first);
    await first.close();
    await sessions(app);
    await app.getByRole('button', { name: 'Forget approval', exact: true }).click();
    const forget = app.getByRole('dialog', {
        name: 'Forget extension approval',
        exact: true
    });
    await expect(forget.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await forget.getByRole('button', { name: 'Forget approval', exact: true }).click();
    await expect(app.getByText('No remembered approvals', { exact: true })).toBeVisible();
    await expect(app.getByText('No browser extension sessions', { exact: true })).toBeVisible();
    const reconnect = await popup(site);
    await expect(
        app.getByRole('dialog', {
            name: 'Allow browser extension access',
            exact: true
        })
    ).toBeVisible();
    await expect(reconnect.locator('.row__title')).toHaveCount(0);
    await approve(app);
    await connected(reconnect);
    await reconnect.close();
    await app.getByRole('button', { name: 'Forget approval', exact: true }).click();
    await app
        .getByRole('dialog', { name: 'Forget extension approval', exact: true })
        .getByRole('button', { name: 'Forget approval', exact: true })
        .click();
    await expect(app.getByText('No remembered approvals', { exact: true })).toBeVisible();
    await app.close();
    const reopened = await appDemo(url);
    const denied = await popup(site);
    const consent = reopened.getByRole('dialog', {
        name: 'Allow browser extension access',
        exact: true
    });
    await expect(consent).toBeVisible();
    await expect(denied.locator('.row__title')).toHaveCount(0);
    await consent.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(denied.locator('.row__title')).toHaveCount(0);
    await denied.close();
    await reopened.close();
    const lastApp = await appDemo(url);
    const approved = await popup(site);
    await approve(lastApp);
    await connected(approved);
});

test('New second paired identity cannot inherit the first identity approval', async () => {
    const url = ORIGIN + '/next.html';
    await configure(url);
    const app = await appDemo(url);
    const site = await sitePage();
    const first = await popup(site);
    await approve(app);
    await connected(first);
    await first.close();
    await sessions(app);
    const firstIdentity = await app.getByText(/^Extension identity: /).innerText();
    expect(extraWorker).toBeDefined();
    sw = extraWorker!;
    id = new URL(sw.url()).host;
    await configure(url);
    const second = await popup(site);
    await expect(
        app.getByRole('dialog', {
            name: 'Allow browser extension access',
            exact: true
        })
    ).toBeVisible();
    await expect(second.locator('.row__title')).toHaveCount(0);
    await expect(site.locator('#password')).toHaveValue('');
    await approve(app);
    await connected(second);
    const identities = await app.getByText(/^Extension identity: /).allTextContents();
    expect(identities).toHaveLength(2);
    expect(new Set(identities).size).toBe(2);
    expect(identities).toContain(firstIdentity);
});
for (const classic of [false, true])
    test(`Legacy ${classic ? 'Classic' : 'New'} full encrypted protocol toolbar fill`, async () => {
        const url = ORIGIN + (classic ? '/index.html?ui=classic' : '/next.html');
        // Legacy package uses its existing configured-target setting. The paired tests
        // above exercise default/custom configuration through the actual settings UI.
        await sw.evaluate((url) => chrome.storage.local.set({ keeWebUrl: url }), url);
        const app = await appDemo(url, classic);
        const site = await sitePage();
        await site.locator('#login_field').focus();
        await expect
            .poll(() => sw.evaluate(() => (chrome.action.onClicked as any).hasListeners()))
            .toBe(true);
        await sw.evaluate(async (url) => {
            const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
            if (!tab) throw new Error('Missing disposable site tab');
            (chrome.action.onClicked as any).dispatch(tab);
        }, site.url());
        if (classic) await app.locator('button[data-result="yes"]').click();
        else {
            const dialog = app.getByRole('dialog', {
                name: 'Allow browser extension access',
                exact: true
            });
            await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
            await expect(
                dialog.getByRole('checkbox', {
                    name: 'Allow listing and searching entries',
                    exact: true
                })
            ).not.toBeChecked();
            await dialog.getByRole('button', { name: 'Allow', exact: true }).click();
        }
        await expect(site.locator('#login_field')).toHaveValue('demouser');
        await expect(site.locator('#password')).not.toHaveValue('');
    });
