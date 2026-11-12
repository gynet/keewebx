import { matchesAppUrl } from 'common/app-url';
import { backend } from './backend';
import { createUIMenus, bindExtensionButtonClick } from './ui';
import { startInternalIpc } from './internal-ipc';
import { startCommandListener, runCommand } from './commands';
import { noop } from 'common/utils';
import { startSyncBadge } from './sync-badge';
import { hasEmbeddedVault, isFullMode, openFullApp, startVaultHost, vaultRequest } from './vault-host';

// Cross-context RPC: let any extension context (popup, options page,
// content script via runtime.sendMessage, or an automated E2E test)
// invoke `runCommand({command: 'submit-auto', tab})` for a specific tab
// id. This is the same code path the toolbar button click triggers via
// `bindExtensionButtonClick`. Production-grade — sender is checked
// against `chrome.runtime.id` so only our own extension's pages can
// invoke this; cross-extension or web-page senders are ignored.
//
// Why not just `chrome.action.onClicked.dispatch(tab)`?
//   - Chromium exposes `dispatch` on the chrome.events.Event prototype
//     and the dispatch fires the registered listener directly. Works.
//   - Firefox 149 does NOT expose `dispatch` (only addListener /
//     removeListener / hasListener). Verified empirically by E2E test
//     introspection on 2026-04-09. Firefox tests have no other way to
//     drive the runCommand chain end-to-end without this RPC.
//
// We use the same RPC from both Chromium and Firefox tests so the
// test code stays portable across browsers. The fact that this also
// enables E2E testing is a side benefit, not the primary purpose —
// the same handler is the right mechanism for any future popup-driven
// or context-menu-driven autofill flow that needs to invoke the same
// action as the toolbar button.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = msg as any;
    if (m?.action !== 'invoke-action-click') {
        return false;
    }
    // Only trust messages from our own extension contexts.
    if (sender.id !== chrome.runtime.id) {
        sendResponse({ error: 'sender id mismatch' });
        return false;
    }
    if (typeof m.tabId !== 'number') {
        sendResponse({ error: 'tabId required' });
        return false;
    }
    chrome.tabs.get(m.tabId, async (tab) => {
        if (chrome.runtime.lastError || !tab) {
            sendResponse({
                error: chrome.runtime.lastError?.message || 'tab not found'
            });
            return;
        }
        try {
            await runCommand({ command: 'submit-auto', tab });
            sendResponse({ ok: true });
        } catch (e) {
            sendResponse({ ok: false, error: (e as Error).message });
        }
    });
    return true; // async response
});

let startPromise: Promise<void>;

chrome.runtime.onStartup.addListener(startAndReportError);
chrome.runtime.onInstalled.addListener((e) => {
    startAndReportError()
        .then(() => {
            if (e.reason === ('install' as chrome.runtime.OnInstalledReason)) {
                if (hasEmbeddedVault) {
                    void chrome.tabs.create({ url: chrome.runtime.getURL('pages/popup.html?view=tab') });
                } else {
                    void chrome.runtime.openOptionsPage();
                }
            }
        })
        .catch(noop);
});

startAndReportError().catch(noop);

function startAndReportError(): Promise<void> {
    if (startPromise !== undefined) {
        return startPromise;
    }
    startPromise = start().catch((e) => {
        // eslint-disable-next-line no-console
        console.error('Startup error', e);
    });
    return startPromise;
}

async function start() {
    startCommandListener();
    createUIMenus();
    bindExtensionButtonClick();
    startInternalIpc();
    startSyncBadge();
    startVaultHost();

    await backend.init();
}

// Requests from the popup, side panel and settings page (full mode).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const m = msg as { action?: string; request?: Record<string, unknown>; tabId?: number; entryId?: string };
    if (sender.id !== chrome.runtime.id || sender.tab?.url?.startsWith('http')) {
        return false;
    }
    const reply = (p: Promise<unknown>) => {
        p.then(
            (result) => sendResponse({ ok: true, result }),
            (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
        );
        return true;
    };
    switch (m?.action) {
        case 'vault': {
            const { vault: command, ...args } = m.request ?? {};
            return reply(vaultRequest(String(command), args));
        }
        case 'fill-entry':
            return reply(
                chrome.tabs.get(m.tabId ?? -1).then((tab) =>
                    runCommand({ command: 'submit-auto', tab, entryId: m.entryId })
                )
            );
        case 'web':
            return reply(webRequest(m.request ?? {}));
        case 'open-app':
            return reply(
                isFullMode().then((full) =>
                    full ? openFullApp() : chrome.tabs.create({ url: backend.keeWebUrl }).then(() => {})
                )
            );
        default:
            return false;
    }
});

/** Web mode: the popup's requests to KeeWebX open in a browser tab. */
async function webRequest(request: Record<string, unknown>): Promise<unknown> {
    const isOpen = async () =>
        (await chrome.tabs.query({})).some((t) => matchesAppUrl(t.url, backend.keeWebUrl));
    switch (request.op) {
        case 'status': {
            // Never opens a tab just to show the popup.
            if (!(await isOpen())) {
                return { open: false };
            }
            await backend.connect();
            const features = await backend.features();
            return { open: true, paired: backend.paired, ...(features ?? {}), supportsList: !!features?.features.includes('entries-v1') };
        }
        case 'entries': {
            await backend.connect();
            const list = await backend.getEntries(
                request.url ? String(request.url) : undefined,
                request.query ? String(request.query) : undefined
            );
            const withId = (e: { handle: string }) => ({ ...e, id: e.handle });
            return { locked: list.locked, suggested: list.suggested.map(withId), items: list.items.map(withId) };
        }
        case 'field': {
            await backend.connect();
            const values = await backend.getEntryFields(String(request.id), [String(request.field)]);
            return { text: values[String(request.field)] ?? '' };
        }
        case 'focus':
            return backend.focusKeeWeb();
        case 'lock':
            await backend.connect();
            return backend.lock();
        default:
            throw new Error('Unknown request');
    }
}
