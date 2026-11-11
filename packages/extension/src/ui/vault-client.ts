/** What the popup, side panel and settings page use to reach the vault. */

export type SyncState = 'saved' | 'pending' | 'syncing' | 'offline' | 'error';

export interface VaultFile {
    id: string;
    name: string;
    storage: string | null;
}

export interface VaultSettings {
    idleMinutes: number;
    clipboardSeconds: number;
    lockOnOsLock: boolean;
}

export interface VaultStatus {
    open: boolean;
    files: VaultFile[];
    recent: VaultFile[];
    sync: { state: SyncState; files: { name: string; state: SyncState; error: string | null }[] };
    settings: VaultSettings;
}

export interface EntrySummary {
    id: string;
    title: string;
    user: string;
    url: string;
    hasOtp: boolean;
    /** Icon font name, when the entry has an icon other than the default. */
    icon?: string | null;
    /** Image data URL of the entry's own icon. */
    customIcon?: string | null;
}

export interface EntryList {
    suggested: EntrySummary[];
    items: EntrySummary[];
}

async function background<T>(message: Record<string, unknown>): Promise<T> {
    const resp = (await chrome.runtime.sendMessage(message)) as
        | { ok: boolean; result?: T; error?: string }
        | undefined;
    if (!resp) {
        throw new Error('No answer from the extension');
    }
    if (!resp.ok) {
        throw new Error(resp.error || 'Error');
    }
    return resp.result as T;
}

export function vault<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return background<T>({ action: 'vault', request: { ...args, vault: command } });
}

export function fillEntry(tabId: number, entryId: string): Promise<void> {
    return background({ action: 'fill-entry', tabId, entryId });
}

export function openApp(): Promise<void> {
    return background({ action: 'open-app' });
}

export async function getMode(): Promise<{ full: boolean; keeWebUrl?: string }> {
    const { keeWebUrl } = await chrome.storage.local.get('keeWebUrl');
    return { full: !keeWebUrl, keeWebUrl: keeWebUrl as string | undefined };
}

/** The page the user is looking at. `?tab=` lets a tab stand in for the popup. */
export async function getTargetTab(): Promise<chrome.tabs.Tab | undefined> {
    const forced = new URLSearchParams(location.search).get('tab');
    if (forced) {
        return chrome.tabs.get(Number(forced)).catch(() => undefined);
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab;
}

export function hostOf(url: string | undefined): string {
    try {
        return url && /^https?:/.test(url) ? new URL(url).hostname.replace(/^www\./, '') : '';
    } catch {
        return '';
    }
}

export function onVaultChanged(cb: () => void): () => void {
    const listener = (msg: unknown) => {
        const m = msg as { vaultEvent?: string; action?: string } | null;
        if (m?.vaultEvent === 'changed' || m?.action === 'sync-state') {
            cb();
        }
        return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
}

const SYNC_LABELS: Record<SyncState, string> = {
    saved: 'Up to date',
    pending: 'Saving…',
    syncing: 'Saving…',
    offline: 'Offline, saved on this device',
    error: 'Sync failed'
};

export function syncLabel(state: SyncState): string {
    return SYNC_LABELS[state];
}
