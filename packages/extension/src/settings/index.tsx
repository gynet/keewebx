import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { VaultStatus, getMode, hostOf, onVaultChanged, vault } from 'ui/vault-client';

const DEFAULT_WEB_URL = 'https://keewebx.app/';
const STORAGE_LABELS: Record<string, string> = { webdav: 'WebDAV' };
const AUTO_LOCK = [
    [5, '5 minutes'],
    [15, '15 minutes'],
    [30, '30 minutes'],
    [60, '1 hour'],
    [0, 'Never']
] as const;
const CLEAR_CLIPBOARD = [
    [0, 'Never'],
    [10, '10 seconds'],
    [30, '30 seconds'],
    [60, '1 minute']
] as const;

function Settings() {
    const [mode, setMode] = useState<{ full: boolean; keeWebUrl?: string }>();
    const [status, setStatus] = useState<VaultStatus>();
    const [shortcut, setShortcut] = useState('');
    const [webOpen, setWebOpen] = useState<boolean>();

    const load = async () => {
        const m = await getMode();
        setMode(m);
        if (m.full) {
            setStatus(await vault<VaultStatus>('status'));
        } else {
            const tabs = await chrome.tabs.query({});
            setWebOpen(tabs.some((t) => t.url?.startsWith(m.keeWebUrl!)));
        }
    };

    useEffect(() => {
        void load();
        void chrome.commands.getAll().then((cmds) => {
            setShortcut(cmds.find((c) => c.name === 'submit-auto')?.shortcut || 'Not set');
        });
        return onVaultChanged(() => void load());
    }, []);

    const switchMode = async (full: boolean) => {
        if (full) {
            await chrome.storage.local.remove('keeWebUrl');
        } else {
            await chrome.storage.local.set({ keeWebUrl: DEFAULT_WEB_URL });
        }
        await load();
    };

    const setSetting = async (values: Record<string, unknown>) => {
        setStatus(await vault<VaultStatus>('settings', { values }));
    };

    if (!mode) {
        return null;
    }
    const openTabs = new Set(status?.files.map((f) => f.id));
    // Open vaults first, then the rest of the recent ones.
    const databases = [
        ...(status?.files ?? []),
        ...(status?.recent ?? []).filter((f) => !openTabs.has(f.id))
    ];

    return (
        <main class="settings">
            <h1 class="settings__title">Settings</h1>
            <div class="segmented" role="radiogroup" aria-label="Mode">
                <label class={mode.full ? 'segmented__item segmented__item--on' : 'segmented__item'}>
                    <input type="radio" name="vault-mode" id="vault-mode-full" checked={mode.full} onChange={() => void switchMode(true)} />
                    Full mode
                </label>
                <label class={!mode.full ? 'segmented__item segmented__item--on' : 'segmented__item'}>
                    <input type="radio" name="vault-mode" id="vault-mode-connect" checked={!mode.full} onChange={() => void switchMode(false)} />
                    Web mode
                </label>
            </div>

            {mode.full ? (
                <>
                    <h2 class="group-title">Databases</h2>
                    <section class="card" id="databases">
                        {databases.map((f) => (
                            <div class="card__row">
                                <span>{/\.kdbx$/i.test(f.name) ? f.name : `${f.name}.kdbx`}</span>
                                <span class="muted">
                                    {openTabs.has(f.id) ? 'Open · ' : ''}
                                    {STORAGE_LABELS[f.storage ?? ''] ?? 'Local'}
                                </span>
                            </div>
                        ))}
                        <div class="card__row">
                            <button
                                class="link"
                                id="add-database"
                                onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('pages/popup.html?view=tab&screen=start') })}
                            >
                                Add database
                            </button>
                        </div>
                    </section>

                    <h2 class="group-title">Security</h2>
                    <section class="card">
                        <label class="card__row">
                            <span title="Locks the vault after this long without use">Auto-lock</span>
                            <select
                                class="plain-select"
                                id="setting-auto-lock"
                                value={status?.settings.idleMinutes}
                                onChange={(e) => void setSetting({ idleMinutes: Number(e.currentTarget.value) })}
                            >
                                {AUTO_LOCK.map(([v, l]) => (
                                    <option value={v}>{l}</option>
                                ))}
                            </select>
                        </label>
                        <label class="card__row">
                            <span title="Empties the clipboard this long after you copy a field">Clear clipboard</span>
                            <select
                                class="plain-select"
                                id="setting-clipboard"
                                value={status?.settings.clipboardSeconds}
                                onChange={(e) => void setSetting({ clipboardSeconds: Number(e.currentTarget.value) })}
                            >
                                {CLEAR_CLIPBOARD.map(([v, l]) => (
                                    <option value={v}>{l}</option>
                                ))}
                            </select>
                        </label>
                        <label class="card__row">
                            <span title="Locks the vault when your computer locks">Lock with screen</span>
                            <input
                                type="checkbox"
                                class="switch"
                                id="setting-lock-screen"
                                checked={!!status?.settings.lockOnOsLock}
                                onChange={(e) => void setSetting({ lockOnOsLock: e.currentTarget.checked })}
                            />
                        </label>
                    </section>
                </>
            ) : (
                <WebServer keeWebUrl={mode.keeWebUrl!} open={webOpen} onChange={load} />
            )}

            <h2 class="group-title">Shortcut</h2>
            <section class="card">
                <button
                    class="card__row card__row--button"
                    title="Change it on the browser's extension shortcuts page"
                    onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
                >
                    <span>Fill login</span>
                    <kbd class="muted" id="shortcut">{shortcut}</kbd>
                </button>
            </section>
        </main>
    );
}

function WebServer(props: { keeWebUrl: string; open?: boolean; onChange: () => Promise<void> }) {
    const custom = props.keeWebUrl !== DEFAULT_WEB_URL;
    const [draft, setDraft] = useState(custom ? props.keeWebUrl : '');
    const [error, setError] = useState('');

    const save = async (url: string) => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            setError('Enter a full address, like https://vault.example.com');
            return;
        }
        if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
            setError('Use an https address');
            return;
        }
        setError('');
        await chrome.storage.local.set({ keeWebUrl: parsed.href });
        await props.onChange();
    };

    return (
        <>
            <h2 class="group-title">Server</h2>
            <section class="card">
                <label class="card__row">
                    <span>keewebx.app</span>
                    <input
                        type="radio"
                        name="server"
                        id="server-default"
                        checked={!custom}
                        onChange={() => void save(DEFAULT_WEB_URL)}
                    />
                </label>
                <label class="card__row">
                    <span>Custom URL</span>
                    <input type="radio" name="server" id="server-custom" checked={custom} onChange={() => draft && void save(draft)} />
                </label>
                <form
                    class="card__row card__row--input"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void save(draft);
                    }}
                >
                    <input
                        class="input"
                        id="server-url"
                        placeholder="https://vault.example.com"
                        value={draft}
                        onInput={(e) => setDraft(e.currentTarget.value)}
                        onBlur={() => draft && draft !== props.keeWebUrl && void save(draft)}
                    />
                </form>
                {error && <p class="error card__error">{error}</p>}
            </section>
            <h2 class="group-title">Connection</h2>
            <section class="card">
                <div class="card__row">
                    <span>Status</span>
                    <span class="muted" id="web-status">
                        {props.open === undefined ? '' : props.open ? `Open in a tab (${hostOf(props.keeWebUrl)})` : 'Ready'}
                    </span>
                </div>
            </section>
        </>
    );
}

render(<Settings />, document.getElementById('root')!);
