/**
 * Full mode: the vault is the KeeWebX app packaged inside the extension. It
 * runs hidden in an offscreen document, or in a tab once the user opens the
 * full app. Only one of the two runs at a time, so there is one copy of the
 * open vault.
 */

declare const __KW_EMBEDDED_VAULT__: boolean | undefined;

const APP_PATH = 'app/index.html';
const READY_TIMEOUT_MS = 20000;

export interface VaultResponse<T = unknown> {
    ok: boolean;
    result?: T;
    error?: string;
}

export const hasEmbeddedVault = typeof __KW_EMBEDDED_VAULT__ !== 'undefined' && !!__KW_EMBEDDED_VAULT__;

export function appUrl(): string {
    return chrome.runtime.getURL(APP_PATH);
}

/** Full mode unless the user picked a web app to connect to. */
export async function isFullMode(): Promise<boolean> {
    if (!hasEmbeddedVault) {
        return false;
    }
    const { keeWebUrl } = await chrome.storage.local.get('keeWebUrl');
    return !keeWebUrl;
}

async function findAppTab(): Promise<chrome.tabs.Tab | undefined> {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url?.startsWith(appUrl()));
}

async function hasOffscreen(): Promise<boolean> {
    return chrome.offscreen.hasDocument();
}

let creating: Promise<void> | undefined;

function send<T>(request: Record<string, unknown>): Promise<VaultResponse<T> | undefined> {
    return chrome.runtime.sendMessage(request).then(
        (r) => r as VaultResponse<T> | undefined,
        () => undefined
    );
}

async function waitUntilReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const resp = await send({ vault: 'ping' });
        if (resp?.ok) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('The vault did not start');
}

async function ensureVault(): Promise<void> {
    if (!(await findAppTab()) && !(await hasOffscreen())) {
        creating ??= chrome.offscreen
            .createDocument({
                url: `${APP_PATH}?embedded=offscreen`,
                reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.CLIPBOARD],
                justification: 'Keeps the password vault open and runs its key derivation worker.'
            })
            .finally(() => {
                creating = undefined;
            });
        await creating;
    }
    await waitUntilReady();
}

/** Sends a request to the vault, starting it first if needed. */
export async function vaultRequest<T = unknown>(
    command: string,
    args: Record<string, unknown> = {}
): Promise<T> {
    await ensureVault();
    const resp = await send<T>({ ...args, vault: command });
    if (!resp) {
        throw new Error('The vault did not answer');
    }
    if (!resp.ok) {
        throw new Error(resp.error || 'Vault error');
    }
    return resp.result as T;
}

/** Asks a running vault to lock; never starts one. */
export async function lockIfRunning(): Promise<void> {
    if ((await findAppTab()) || (await hasOffscreen())) {
        await send({ vault: 'lock' });
    }
}

async function closeOffscreen(): Promise<void> {
    if (await hasOffscreen()) {
        // Locking saves pending changes first.
        await Promise.race([send({ vault: 'lock' }), new Promise((r) => setTimeout(r, 3000))]);
        await chrome.offscreen.closeDocument().catch(() => {});
    }
}

/** Moves the vault into a visible tab with the whole app. */
export async function openFullApp(): Promise<void> {
    await closeOffscreen();
    const tab = await findAppTab();
    if (tab?.id) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, { focused: true });
        }
    } else {
        await chrome.tabs.create({ url: appUrl() });
    }
}

export function startVaultHost(): void {
    if (!hasEmbeddedVault) {
        return;
    }
    // A tab with the app replaces the hidden copy.
    chrome.tabs.onUpdated.addListener((_id, change, tab) => {
        if (change.status === 'loading' && tab.url?.startsWith(appUrl())) {
            void closeOffscreen();
        }
    });

    chrome.idle.onStateChanged.addListener((state) => {
        if (state !== 'locked') {
            return;
        }
        void (async () => {
            if (!(await isFullMode())) {
                return;
            }
            const running = (await findAppTab()) || (await hasOffscreen());
            if (!running) {
                return;
            }
            const status = await vaultRequest<{ settings: { lockOnOsLock?: boolean } }>('status');
            if (status.settings.lockOnOsLock) {
                await lockIfRunning();
            }
        })().catch(() => {});
    });
}
