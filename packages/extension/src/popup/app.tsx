import { useEffect, useRef, useState } from 'preact/hooks';
import {
    EntryList,
    EntrySummary,
    VaultFile,
    VaultStatus,
    fillEntry,
    getMode,
    getTargetTab,
    hostOf,
    onVaultChanged,
    openApp,
    syncLabel,
    vault
} from 'ui/vault-client';
import { Icon, Mark, Tile } from 'ui/mark';

export type Layout = 'popup' | 'side' | 'tab';

type Screen =
    | { name: 'loading' }
    | { name: 'start' }
    | { name: 'webdav' }
    | { name: 'unlock'; target: UnlockTarget }
    | { name: 'list' }
    | { name: 'detail'; entry: EntrySummary }
    | { name: 'web'; keeWebUrl: string };

/** What the unlock screen opens: a recent vault, or one being added. */
type UnlockTarget =
    | { kind: 'recent'; file: VaultFile }
    | { kind: 'webdav'; name: string; url: string; user: string; pass: string }
    | { kind: 'data'; name: string; data: string };

function fileName(name: string): string {
    return /\.kdbx$/i.test(name) ? name : `${name}.kdbx`;
}

function toBase64(buf: ArrayBuffer): string {
    let s = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

export function App({ layout }: { layout: Layout }) {
    const [screen, setScreen] = useState<Screen>({ name: 'loading' });
    const [status, setStatus] = useState<VaultStatus>();
    const [tab, setTab] = useState<chrome.tabs.Tab>();
    const [error, setError] = useState('');

    const refresh = async (keepScreen: boolean) => {
        const mode = await getMode();
        if (!mode.full) {
            setScreen({ name: 'web', keeWebUrl: mode.keeWebUrl! });
            return;
        }
        try {
            const st = await vault<VaultStatus>('status');
            setStatus(st);
            if (keepScreen) {
                setScreen((current) => {
                    if (st.open && (current.name === 'unlock' || current.name === 'start')) {
                        return { name: 'list' };
                    }
                    if (!st.open && (current.name === 'list' || current.name === 'detail')) {
                        return st.recent[0] ? { name: 'unlock', target: { kind: 'recent', file: st.recent[0] } } : { name: 'start' };
                    }
                    return current;
                });
                return;
            }
            if (st.open) {
                setScreen({ name: 'list' });
            } else if (st.recent[0] && new URLSearchParams(location.search).get('screen') !== 'start') {
                setScreen({ name: 'unlock', target: { kind: 'recent', file: st.recent[0] } });
            } else {
                setScreen({ name: 'start' });
            }
        } catch (e) {
            setError((e as Error).message);
            setScreen({ name: 'start' });
        }
    };

    useEffect(() => {
        void getTargetTab().then(setTab);
        void refresh(false);
        const off = onVaultChanged(() => void refresh(true));
        if (layout === 'side') {
            const update = () => void getTargetTab().then(setTab);
            chrome.tabs.onActivated.addListener(update);
            chrome.tabs.onUpdated.addListener(update);
            return () => {
                off();
                chrome.tabs.onActivated.removeListener(update);
                chrome.tabs.onUpdated.removeListener(update);
            };
        }
        return off;
    }, []);

    const close = () => {
        if (layout === 'popup') {
            window.close();
        }
    };

    let body;
    switch (screen.name) {
        case 'loading':
            body = <div class="center muted">Loading…</div>;
            break;
        case 'start':
            body = (
                <Start
                    layout={layout}
                    error={error}
                    onWebDav={() => setScreen({ name: 'webdav' })}
                    onFile={(name, data) => setScreen({ name: 'unlock', target: { kind: 'data', name, data } })}
                    onDemo={async () => {
                        await vault('openDemo');
                        await refresh(false);
                    }}
                    onRecent={status?.recent.length ? () => void refresh(false) : undefined}
                />
            );
            break;
        case 'webdav':
            body = (
                <WebDav
                    onBack={() => setScreen({ name: 'start' })}
                    onConnect={(url, user, pass) =>
                        setScreen({
                            name: 'unlock',
                            target: { kind: 'webdav', name: decodeURIComponent(url.split('/').pop() || 'vault'), url, user, pass }
                        })
                    }
                />
            );
            break;
        case 'unlock':
            body = (
                <Unlock
                    target={screen.target}
                    recent={status?.recent ?? []}
                    onPick={(file) => setScreen({ name: 'unlock', target: { kind: 'recent', file } })}
                    onOther={() => setScreen({ name: 'start' })}
                    onUnlocked={() => void refresh(false)}
                />
            );
            break;
        case 'list':
            body = (
                <List
                    layout={layout}
                    tab={tab}
                    status={status}
                    onOpen={(entry) => setScreen({ name: 'detail', entry })}
                    onFilled={close}
                    onLocked={() => void refresh(false)}
                />
            );
            break;
        case 'detail':
            body = (
                <Detail
                    entry={screen.entry}
                    tab={tab}
                    onBack={() => setScreen({ name: 'list' })}
                    onFilled={close}
                />
            );
            break;
        case 'web':
            body = <Web keeWebUrl={screen.keeWebUrl} tab={tab} onFilled={close} />;
            break;
    }
    return <div class={`app app--${layout}`}>{body}</div>;
}

function Start(props: {
    layout: Layout;
    error: string;
    onWebDav: () => void;
    onFile: (name: string, data: string) => void;
    onDemo: () => Promise<void>;
    onRecent?: () => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const chooseFile = () => {
        // A file dialog closes the popup, so files are chosen in a tab.
        if (props.layout === 'popup') {
            void chrome.tabs.create({ url: chrome.runtime.getURL('pages/popup.html?view=tab&screen=start') });
            window.close();
        } else {
            input.current?.click();
        }
    };
    const onChange = async () => {
        const file = input.current?.files?.[0];
        if (file) {
            props.onFile(file.name, toBase64(await file.arrayBuffer()));
        }
    };
    return (
        <div class="start">
            <h1 class="start__title">Open your vault</h1>
            {props.error && <p class="error">{props.error}</p>}
            <input ref={input} type="file" accept=".kdbx" hidden onChange={onChange} id="start-file-input" />
            <button class="start__item" id="start-file" onClick={chooseFile}>
                <span class="start__icon"><Icon name="file" /></span>Choose a file
            </button>
            <button class="start__item" id="start-webdav" onClick={props.onWebDav}>
                <span class="start__icon"><Icon name="cloud" /></span>WebDAV
            </button>
            <button class="start__item" id="start-new" onClick={() => void openApp().then(() => window.close())}>
                <span class="start__icon"><Icon name="plus" /></span>Create a new vault
            </button>
            <div class="start__footer">
                <button class="link" id="start-demo" onClick={() => void props.onDemo()}>
                    Try the demo
                </button>
                {props.onRecent && (
                    <button class="link" onClick={props.onRecent}>
                        Recent vaults
                    </button>
                )}
            </div>
        </div>
    );
}

function WebDav(props: { onBack: () => void; onConnect: (url: string, user: string, pass: string) => void }) {
    const [url, setUrl] = useState('');
    const [user, setUser] = useState('');
    const [pass, setPass] = useState('');
    const valid = /^https?:\/\/.+\/.+/.test(url.trim());
    return (
        <form
            class="form"
            onSubmit={(e) => {
                e.preventDefault();
                if (valid) {
                    props.onConnect(url.trim(), user, pass);
                }
            }}
        >
            <header class="bar">
                <button type="button" class="icon-btn" aria-label="Back" onClick={props.onBack}>
                    <Icon name="back" size={18} />
                </button>
                <h1 class="bar__title">WebDAV</h1>
            </header>
            <label class="field">
                <span>URL</span>
                <input id="webdav-url" value={url} onInput={(e) => setUrl(e.currentTarget.value)} placeholder="https://cloud.example.com/vault.kdbx" autoFocus />
            </label>
            <label class="field">
                <span>Username</span>
                <input id="webdav-user" value={user} onInput={(e) => setUser(e.currentTarget.value)} autoComplete="off" />
            </label>
            <label class="field">
                <span>Password</span>
                <input id="webdav-pass" type="password" value={pass} onInput={(e) => setPass(e.currentTarget.value)} />
            </label>
            <div class="form__end">
                <button class="primary" id="webdav-connect" disabled={!valid}>
                    Connect
                </button>
            </div>
        </form>
    );
}

function Unlock(props: {
    target: UnlockTarget;
    recent: VaultFile[];
    onPick: (file: VaultFile) => void;
    onOther: () => void;
    onUnlocked: () => void;
}) {
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const { target } = props;
    const name = target.kind === 'recent' ? target.file.name : target.name;

    const unlock = async (e: Event) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
            if (target.kind === 'recent') {
                await vault('unlock', { id: target.file.id, password });
            } else if (target.kind === 'webdav') {
                await vault('openWebDav', { url: target.url, user: target.user, pass: target.pass, password });
            } else {
                await vault('openData', { name: target.name, data: target.data, password });
            }
            props.onUnlocked();
        } catch (err) {
            const msg = (err as Error).message;
            setError(msg === 'invalid-password' ? 'Wrong password' : msg);
            setBusy(false);
        }
    };

    return (
        <form class="unlock" onSubmit={unlock}>
            <Mark size={64} />
            <h1 class="unlock__name">{fileName(name)}</h1>
            <input
                id="unlock-password"
                class={error ? 'input input--error' : 'input'}
                type="password"
                placeholder="Password"
                aria-label="Password"
                value={password}
                onInput={(e) => setPassword(e.currentTarget.value)}
                disabled={busy}
                autoFocus
            />
            {error && <p class="error" id="unlock-error">{error}</p>}
            <button class="primary" id="unlock-submit" disabled={busy}>
                {busy ? 'Unlocking…' : 'Unlock'}
            </button>
            <div class="unlock__more">
                {props.recent.length > 1 && target.kind === 'recent' && (
                    <select
                        class="select"
                        aria-label="Vault"
                        value={target.file.id}
                        onChange={(e) => props.onPick(props.recent.find((f) => f.id === e.currentTarget.value)!)}
                    >
                        {props.recent.map((f) => (
                            <option value={f.id}>{fileName(f.name)}</option>
                        ))}
                    </select>
                )}
                <button type="button" class="link" id="unlock-other" onClick={props.onOther}>
                    Open another vault
                </button>
            </div>
        </form>
    );
}

function SyncFooter({ status }: { status?: VaultStatus }) {
    const state = status?.sync.state ?? 'saved';
    const names = status?.files.map((f) => fileName(f.name)).join(', ') ?? '';
    return (
        <footer class="foot">
            <span class={`sync sync--${state}`} id="sync-state">
                <span class="sync__dot" />
                {syncLabel(state)}
            </span>
            <span class="foot__name">{names}</span>
        </footer>
    );
}

function Row(props: { entry: EntrySummary; selected?: boolean; canFill: boolean; onOpen: () => void; onFill?: () => void }) {
    const { entry } = props;
    return (
        <div class={props.selected ? 'row row--selected' : 'row'} data-entry={entry.title}>
            <button class="row__main" onClick={props.onOpen}>
                <Tile title={entry.title} icon={entry.icon} customIcon={entry.customIcon} />
                <span class="row__text">
                    <span class="row__title">{entry.title || '(no title)'}</span>
                    <span class="row__sub">{entry.user || entry.url}</span>
                </span>
            </button>
            {props.onFill && props.canFill && (
                <button class="fill-btn" onClick={props.onFill}>
                    Fill
                </button>
            )}
        </div>
    );
}

function List(props: {
    layout: Layout;
    tab?: chrome.tabs.Tab;
    status?: VaultStatus;
    onOpen: (e: EntrySummary) => void;
    onFilled: () => void;
    onLocked: () => void;
}) {
    const [query, setQuery] = useState('');
    const [list, setList] = useState<EntryList>({ suggested: [], items: [] });
    const host = hostOf(props.tab?.url);
    const canFill = !!host && props.tab?.id !== undefined;

    useEffect(() => {
        let stale = false;
        const t = setTimeout(() => {
            void vault<EntryList>('list', { url: host ? props.tab?.url : undefined, query }).then((l) => {
                if (!stale) {
                    setList(l);
                }
            });
            void vault('activity');
        }, query ? 120 : 0);
        return () => {
            stale = true;
            clearTimeout(t);
        };
    }, [query, props.tab?.url, props.status]);

    const fill = async (entry: EntrySummary) => {
        await fillEntry(props.tab!.id!, entry.id);
        props.onFilled();
    };

    return (
        <div class="list">
            <header class="search-bar">
                <label class="search">
                    <Icon name="search" size={15} />
                    <input
                        id="search"
                        type="search"
                        placeholder="Search vault"
                        aria-label="Search vault"
                        value={query}
                        onInput={(e) => setQuery(e.currentTarget.value)}
                        autoFocus
                    />
                </label>
                {props.layout === 'popup' && (
                    <button
                        class="round-btn"
                        title="Open in side panel"
                        aria-label="Open in side panel"
                        onClick={() => {
                            const windowId = props.tab?.windowId;
                            if (windowId !== undefined) {
                                void chrome.sidePanel.open({ windowId }).then(() => window.close());
                            }
                        }}
                    >
                        <Icon name="panel" />
                    </button>
                )}
                <button class="round-btn" title="Open KeeWebX" aria-label="Open KeeWebX" id="open-app" onClick={() => void openApp().then(props.onFilled)}>
                    <Icon name="expand" />
                </button>
                <button
                    class="round-btn"
                    title="Lock"
                    aria-label="Lock"
                    id="lock"
                    onClick={async () => {
                        await vault('lock');
                        props.onLocked();
                    }}
                >
                    <Icon name="lock" />
                </button>
            </header>
            <div class="scroll">
                {!query && host && (
                    <>
                        <h2 class="section">Suggested for {host}</h2>
                        {list.suggested.length ? (
                            list.suggested.map((e, i) => (
                                <Row entry={e} selected={i === 0} canFill={canFill} onOpen={() => props.onOpen(e)} onFill={() => void fill(e)} />
                            ))
                        ) : (
                            <p class="empty">No logins for this site</p>
                        )}
                    </>
                )}
                <h2 class="section">{query ? 'Results' : 'Recent'}</h2>
                {list.items.map((e) => (
                    <Row entry={e} canFill={canFill} onOpen={() => props.onOpen(e)} onFill={query ? () => void fill(e) : undefined} />
                ))}
                {query && !list.items.length && <p class="empty">Nothing found</p>}
            </div>
            <SyncFooter status={props.status} />
        </div>
    );
}

const FIELDS: { key: string; label: string; secret?: boolean }[] = [
    { key: 'user', label: 'Username' },
    { key: 'password', label: 'Password', secret: true },
    { key: 'otp', label: 'One-time code' },
    { key: 'url', label: 'Website' }
];

function Detail(props: { entry: EntrySummary; tab?: chrome.tabs.Tab; onBack: () => void; onFilled: () => void }) {
    const [entry, setEntry] = useState(props.entry);
    const [otp, setOtp] = useState('');
    const [copied, setCopied] = useState('');
    const canFill = !!hostOf(props.tab?.url) && props.tab?.id !== undefined;

    useEffect(() => {
        void vault<EntrySummary>('entry', { id: props.entry.id }).then((e) => {
            setEntry(e);
            if (e.hasOtp) {
                void vault<{ text: string }>('field', { id: e.id, field: 'otp' }).then((r) => setOtp(r.text));
            }
        });
    }, [props.entry.id]);

    const copy = async (field: string) => {
        const { text } = await vault<{ text: string }>('field', { id: entry.id, field });
        await navigator.clipboard.writeText(text);
        void vault('copied');
        setCopied(field);
        setTimeout(() => setCopied(''), 1500);
    };

    const values: Record<string, string> = {
        user: entry.user,
        password: '••••••••••••',
        otp: otp ? `${otp.slice(0, 3)} ${otp.slice(3)}` : '',
        url: entry.url
    };
    const shown = FIELDS.filter((f) => values[f.key]);

    return (
        <div class="detail">
            <header class="bar">
                <button class="icon-btn" aria-label="Back" id="detail-back" onClick={props.onBack}>
                    <Icon name="back" size={18} />
                </button>
                <Tile title={entry.title} icon={entry.icon} customIcon={entry.customIcon} />
                <h1 class="bar__title">{entry.title || '(no title)'}</h1>
            </header>
            <div class="fields">
                {shown.map((f) => (
                    <button class="fields__row" data-field={f.key} onClick={() => void copy(f.key)}>
                        <span class="fields__text">
                            <span class="fields__label">{f.label}</span>
                            <span class={f.secret ? 'fields__value fields__value--secret' : 'fields__value'}>{values[f.key]}</span>
                        </span>
                        <span class="fields__copy">{copied === f.key ? 'Copied' : 'Copy'}</span>
                    </button>
                ))}
            </div>
            {canFill && (
                <div class="detail__end">
                    <button
                        class="primary"
                        id="detail-fill"
                        onClick={async () => {
                            await fillEntry(props.tab!.id!, entry.id);
                            props.onFilled();
                        }}
                    >
                        Fill
                    </button>
                </div>
            )}
        </div>
    );
}

function Web(props: { keeWebUrl: string; tab?: chrome.tabs.Tab; onFilled: () => void }) {
    const [open, setOpen] = useState<boolean>();
    const host = hostOf(props.tab?.url);
    useEffect(() => {
        void chrome.tabs.query({}).then((tabs) => setOpen(tabs.some((t) => t.url?.startsWith(props.keeWebUrl))));
    }, []);
    const fill = async () => {
        await chrome.runtime.sendMessage({ action: 'invoke-action-click', tabId: props.tab!.id });
        props.onFilled();
    };
    return (
        <div class="list">
            <header class="web-head">
                <h1 class="web-head__host">{hostOf(props.keeWebUrl) || props.keeWebUrl}</h1>
                <span class={open ? 'sync sync--saved' : 'sync sync--pending'} id="web-state">
                    <span class="sync__dot" />
                    {open ? 'Open in a tab' : 'Not open'}
                </span>
            </header>
            <div class="scroll web-body">
                <p class="muted">Logins come from KeeWebX open in a browser tab. You pick the login there.</p>
                {host && (
                    <button class="primary" id="web-fill" onClick={() => void fill()}>
                        Fill login on {host}
                    </button>
                )}
            </div>
            <footer class="foot">
                <button class="link" id="web-open" onClick={() => void openApp().then(props.onFilled)}>
                    Open KeeWebX
                </button>
                <span />
            </footer>
        </div>
    );
}

