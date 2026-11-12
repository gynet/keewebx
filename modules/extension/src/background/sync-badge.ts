/**
 * Shows the vault's sync state on the toolbar button. The app posts it
 * through content-keeweb; the last state is kept in session storage so the
 * popup can read it.
 */

type SyncState = 'saved' | 'pending' | 'syncing' | 'offline' | 'error';

interface StoredSyncState {
    state: SyncState;
    files: { name: string; state: SyncState; error: string | null }[];
    tabId?: number;
}

const BADGES: Partial<Record<SyncState, { color: string; message: string }>> = {
    offline: { color: '#e8a10a', message: 'syncStateOffline' },
    error: { color: '#d93025', message: 'syncStateError' }
};

function show(state: SyncState | undefined): void {
    const badge = state ? BADGES[state] : undefined;
    void chrome.action.setBadgeText({ text: badge ? '!' : '' });
    if (badge) {
        void chrome.action.setBadgeBackgroundColor({ color: badge.color });
    }
    // An empty title restores the one from the manifest.
    void chrome.action.setTitle({ title: badge ? chrome.i18n.getMessage(badge.message) : '' });
}

export function startSyncBadge(): void {
    chrome.runtime.onMessage.addListener((msg, sender) => {
        const m = msg as { action?: string; state?: StoredSyncState } | undefined;
        if (m?.action !== 'sync-state' || sender.id !== chrome.runtime.id || !m.state) {
            return false;
        }
        const stored: StoredSyncState = { ...m.state, tabId: sender.tab?.id };
        show(stored.state);
        void chrome.storage.session.set({ syncState: stored });
        return false;
    });

    chrome.tabs.onRemoved.addListener(async (tabId) => {
        const { syncState } = (await chrome.storage.session.get('syncState')) as {
            syncState?: StoredSyncState;
        };
        if (syncState?.tabId === tabId) {
            show(undefined);
            await chrome.storage.session.remove('syncState');
        }
    });
}
