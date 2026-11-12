import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
    EntryList,
    EntrySummary,
    VaultFile,
    VaultStatus,
    WebStatus,
    fillEntry,
    getMode,
    getTargetTab,
    hostOf,
    onVaultChanged,
    openApp,
    syncLabel,
    vault,
    web
} from 'ui/vault-client';
import { Icon, Mark, Tile } from 'ui-kit/mark';
import { t } from 'ui/i18n';

export type Layout = 'popup' | 'side' | 'tab';

type Screen =
    | { name: 'loading' }
    | { name: 'start' }
    | { name: 'webdav' }
    | { name: 'unlock'; target: UnlockTarget }
    | { name: 'list' }
    | { name: 'detail'; entry: EntrySummary }
    | { name: 'web-closed' }
    | { name: 'web-locked' }
    | { name: 'web-basic' };

/** What the unlock screen opens: a recent vault, or one being added. */
type UnlockTarget =
    | { kind: 'recent'; file: VaultFile }
    | { kind: 'webdav'; name: string; url: string; user: string; pass: string }
    | { kind: 'data'; name: string; data: string };

/**
 * Where entries come from: the vault inside the extension (full mode), or
 * KeeWebX open in a tab (web mode). The list and detail screens use either.
 */
interface Source {
    full: boolean;
    list(url: string | undefined, query: string): Promise<EntryList & { locked?: boolean }>;
    field(id: string, field: string): Promise<string>;
    entry(summary: EntrySummary): Promise<EntrySummary>;
    lock(): Promise<void>;
    copied(): void;
    activity(): void;
}

const fullSource: Source = {
    full: true,
    list: (url, query) => vault<EntryList>('list', { url, query }),
    field: async (id, field) => (await vault<{ text: string }>('field', { id, field })).text,
    entry: (summary) => vault<EntrySummary>('entry', { id: summary.id }),
    lock: () => vault('lock'),
    copied: () => void vault('copied'),
    activity: () => void vault('activity')
};

const webSource: Source = {
    full: false,
    list: (url, query) => web<EntryList & { locked: boolean }>('entries', { url, query }),
    field: async (id, field) => (await web<{ text: string }>('field', { id, field })).text,
    entry: (summary) => Promise.resolve(summary),
    lock: () => web('lock'),
    copied: () => {},
    activity: () => {}
};

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
    const [webStatus, setWebStatus] = useState<WebStatus>();
    const [keeWebUrl, setKeeWebUrl] = useState('');
    const [tab, setTab] = useState<chrome.tabs.Tab>();
    const [error, setError] = useState('');
    const [refreshKey, setRefreshKey] = useState(0);

    const refreshWeb = async () => {
        const st = await web<WebStatus>('status').catch(() => ({ open: false } as WebStatus));
        setWebStatus(st);
        if (!st.open) {
            setScreen({ name: 'web-closed' });
        } else if (!st.supportsList) {
            setScreen({ name: 'web-basic' });
        } else if (st.locked) {
            setScreen({ name: 'web-locked' });
        } else {
            setScreen((current) => (current.name === 'detail' ? current : { name: 'list' }));
        }
        setRefreshKey((k) => k + 1);
    };

    const refresh = async (keepScreen: boolean) => {
        const mode = await getMode();
        if (!mode.full) {
            setKeeWebUrl(mode.keeWebUrl!);
            await refreshWeb();
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
                        return st.recent[0]
                            ? { name: 'unlock', target: { kind: 'recent', file: st.recent[0] } }
                            : { name: 'start' };
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
    const source = keeWebUrl ? webSource : fullSource;

    let body;
    switch (screen.name) {
        case 'loading':
            body = <div class="center muted">{t('uiLoading')}</div>;
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
                            target: {
                                kind: 'webdav',
                                name: decodeURIComponent(url.split('/').pop() || 'vault'),
                                url,
                                user,
                                pass
                            }
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
                    source={source}
                    tab={tab}
                    refreshKey={refreshKey}
                    footer={
                        source.full ? (
                            <SyncFooter status={status} />
                        ) : (
                            <WebFooter keeWebUrl={keeWebUrl} />
                        )
                    }
                    deps={source.full ? status : webStatus}
                    onOpen={(entry) => setScreen({ name: 'detail', entry })}
                    onFilled={close}
                    onLocked={() => void refresh(false)}
                />
            );
            break;
        case 'detail':
            body = (
                <Detail
                    source={source}
                    entry={screen.entry}
                    tab={tab}
                    onBack={() => setScreen({ name: 'list' })}
                    onFilled={close}
                />
            );
            break;
        case 'web-closed':
            body = (
                <WebMessage
                    keeWebUrl={keeWebUrl}
                    title={t('uiWebNotOpen')}
                    hint={t('uiWebNotOpenHint')}
                    action={t('uiOpenKeeWebX')}
                    actionId="web-open"
                    onAction={() => void openApp().then(close)}
                />
            );
            break;
        case 'web-locked':
            body = (
                <WebMessage
                    keeWebUrl={keeWebUrl}
                    title={t('uiWebLocked')}
                    hint={t('uiWebUnlockHint')}
                    action={t('uiWebUnlockInTab')}
                    actionId="web-unlock"
                    onAction={() => void web('focus').then(close)}
                />
            );
            break;
        case 'web-basic':
            body = <WebBasic keeWebUrl={keeWebUrl} tab={tab} onFilled={close} />;
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
            <h1 class="start__title">{t('uiOpenYourVault')}</h1>
            {props.error && <p class="error">{props.error}</p>}
            <input ref={input} type="file" accept=".kdbx" hidden onChange={onChange} id="start-file-input" />
            <button class="start__item" id="start-file" onClick={chooseFile}>
                <span class="start__icon">
                    <Icon name="file" />
                </span>
                {t('uiChooseFile')}
            </button>
            <button class="start__item" id="start-webdav" onClick={props.onWebDav}>
                <span class="start__icon">
                    <Icon name="cloud" />
                </span>
                {t('uiWebDav')}
            </button>
            <button class="start__item" id="start-new" onClick={() => void openApp().then(() => window.close())}>
                <span class="start__icon">
                    <Icon name="plus" />
                </span>
                {t('uiCreateVault')}
            </button>
            <div class="start__footer">
                <button class="link" id="start-demo" onClick={() => void props.onDemo()}>
                    {t('uiTryDemo')}
                </button>
                {props.onRecent && (
                    <button class="link" onClick={props.onRecent}>
                        {t('uiRecentVaults')}
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
                <button type="button" class="icon-btn" aria-label={t('uiBack')} onClick={props.onBack}>
                    <Icon name="back" size={18} />
                </button>
                <h1 class="bar__title">{t('uiWebDav')}</h1>
            </header>
            <label class="field">
                <span>{t('uiUrl')}</span>
                <input
                    id="webdav-url"
                    value={url}
                    onInput={(e) => setUrl(e.currentTarget.value)}
                    placeholder="https://cloud.example.com/vault.kdbx"
                    autoFocus
                />
            </label>
            <label class="field">
                <span>{t('uiUsername')}</span>
                <input id="webdav-user" value={user} onInput={(e) => setUser(e.currentTarget.value)} autoComplete="off" />
            </label>
            <label class="field">
                <span>{t('uiPassword')}</span>
                <input id="webdav-pass" type="password" value={pass} onInput={(e) => setPass(e.currentTarget.value)} />
            </label>
            <div class="form__end">
                <button class="primary" id="webdav-connect" disabled={!valid}>
                    {t('uiConnect')}
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
            setError(msg === 'invalid-password' ? t('uiWrongPassword') : msg);
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
                placeholder={t('uiPassword')}
                aria-label={t('uiPassword')}
                value={password}
                onInput={(e) => setPassword(e.currentTarget.value)}
                disabled={busy}
                autoFocus
            />
            {error && (
                <p class="error" id="unlock-error">
                    {error}
                </p>
            )}
            <button class="primary" id="unlock-submit" disabled={busy}>
                {busy ? t('uiUnlocking') : t('uiUnlock')}
            </button>
            <div class="unlock__more">
                {props.recent.length > 1 && target.kind === 'recent' && (
                    <select
                        class="select"
                        aria-label={t('uiVault')}
                        value={target.file.id}
                        onChange={(e) => props.onPick(props.recent.find((f) => f.id === e.currentTarget.value)!)}
                    >
                        {props.recent.map((f) => (
                            <option value={f.id}>{fileName(f.name)}</option>
                        ))}
                    </select>
                )}
                <button type="button" class="link" id="unlock-other" onClick={props.onOther}>
                    {t('uiOpenAnotherVault')}
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

function WebFooter({ keeWebUrl }: { keeWebUrl: string }) {
    return (
        <footer class="foot">
            <span class="sync sync--saved" id="web-state">
                <span class="sync__dot" />
                {t('uiWebConnected')}
            </span>
            <span class="foot__name">{hostOf(keeWebUrl) || keeWebUrl}</span>
        </footer>
    );
}

function Row(props: {
    entry: EntrySummary;
    selected?: boolean;
    canFill: boolean;
    onOpen: () => void;
    onFill?: () => void;
}) {
    const { entry } = props;
    return (
        <div class={props.selected ? 'row row--selected' : 'row'} data-entry={entry.title}>
            <button class="row__main" onClick={props.onOpen}>
                <Tile title={entry.title} icon={entry.icon} customIcon={entry.customIcon} />
                <span class="row__text">
                    <span class="row__title">{entry.title || t('uiNoTitle')}</span>
                    <span class="row__sub">{entry.user || entry.url}</span>
                </span>
            </button>
            {props.onFill && props.canFill && (
                <button class="fill-btn" onClick={props.onFill}>
                    {t('uiFill')}
                </button>
            )}
        </div>
    );
}

function List(props: {
    layout: Layout;
    source: Source;
    tab?: chrome.tabs.Tab;
    refreshKey: number;
    footer: ComponentChildren;
    deps: unknown;
    onOpen: (e: EntrySummary) => void;
    onFilled: () => void;
    onLocked: () => void;
}) {
    const { source } = props;
    const [query, setQuery] = useState('');
    const [list, setList] = useState<EntryList>({ suggested: [], items: [] });
    const [waiting, setWaiting] = useState(false);
    const host = hostOf(props.tab?.url);
    const canFill = !!host && props.tab?.id !== undefined;

    useEffect(() => {
        let stale = false;
        // A first request in web mode may wait for approval in the app tab.
        const slow = setTimeout(() => !stale && setWaiting(true), 1200);
        const timer = setTimeout(
            () => {
                source
                    .list(host ? props.tab?.url : undefined, query)
                    .then((l) => {
                        if (stale) {
                            return;
                        }
                        if ((l as { locked?: boolean }).locked) {
                            props.onLocked();
                            return;
                        }
                        setList(l);
                    })
                    .catch(() => {})
                    .finally(() => {
                        clearTimeout(slow);
                        setWaiting(false);
                    });
                source.activity();
            },
            query ? 120 : 0
        );
        return () => {
            stale = true;
            clearTimeout(timer);
            clearTimeout(slow);
        };
    }, [query, props.tab?.url, props.deps, props.refreshKey]);

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
                        placeholder={t('uiSearchVault')}
                        aria-label={t('uiSearchVault')}
                        value={query}
                        onInput={(e) => setQuery(e.currentTarget.value)}
                        autoFocus
                    />
                </label>
                {props.layout === 'popup' && (
                    <button
                        class="round-btn"
                        title={t('uiOpenSidePanel')}
                        aria-label={t('uiOpenSidePanel')}
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
                <button
                    class="round-btn"
                    title={t('uiOpenKeeWebX')}
                    aria-label={t('uiOpenKeeWebX')}
                    id="open-app"
                    onClick={() => void (source.full ? openApp() : web('focus')).then(props.onFilled)}
                >
                    <Icon name="expand" />
                </button>
                <button
                    class="round-btn"
                    title={t('uiLock')}
                    aria-label={t('uiLock')}
                    id="lock"
                    onClick={async () => {
                        await source.lock();
                        props.onLocked();
                    }}
                >
                    <Icon name="lock" />
                </button>
            </header>
            <div class="scroll">
                {waiting && (
                    <div class="notice" id="web-approve">
                        <strong>{t('uiWebApprove')}</strong>
                        <span>{t('uiWebApproveHint')}</span>
                    </div>
                )}
                {!query && host && (
                    <>
                        <h2 class="section">{t('uiSuggestedFor', host)}</h2>
                        {list.suggested.length ? (
                            list.suggested.map((e, i) => (
                                <Row
                                    entry={e}
                                    selected={i === 0}
                                    canFill={canFill}
                                    onOpen={() => props.onOpen(e)}
                                    onFill={() => void fill(e)}
                                />
                            ))
                        ) : (
                            <p class="empty">{t('uiNoLoginsForSite')}</p>
                        )}
                    </>
                )}
                <h2 class="section">{query ? t('uiResults') : t('uiRecent')}</h2>
                {list.items.map((e) => (
                    <Row
                        entry={e}
                        canFill={canFill}
                        onOpen={() => props.onOpen(e)}
                        onFill={query ? () => void fill(e) : undefined}
                    />
                ))}
                {query && !list.items.length && <p class="empty">{t('uiNothingFound')}</p>}
            </div>
            {props.footer}
        </div>
    );
}

const FIELDS: { key: string; label: string; secret?: boolean }[] = [
    { key: 'user', label: 'uiUsername' },
    { key: 'password', label: 'uiPassword', secret: true },
    { key: 'otp', label: 'uiOneTimeCode' },
    { key: 'url', label: 'uiWebsite' }
];

function Detail(props: {
    source: Source;
    entry: EntrySummary;
    tab?: chrome.tabs.Tab;
    onBack: () => void;
    onFilled: () => void;
}) {
    const { source } = props;
    const [entry, setEntry] = useState(props.entry);
    const [otp, setOtp] = useState('');
    const [copied, setCopied] = useState('');
    const canFill = !!hostOf(props.tab?.url) && props.tab?.id !== undefined;

    useEffect(() => {
        void source.entry(props.entry).then((e) => {
            setEntry(e);
            if (e.hasOtp) {
                void source.field(e.id, 'otp').then(setOtp);
            }
        });
    }, [props.entry.id]);

    const copy = async (field: string) => {
        const text = await source.field(entry.id, field);
        await navigator.clipboard.writeText(text);
        source.copied();
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
                <button class="icon-btn" aria-label={t('uiBack')} id="detail-back" onClick={props.onBack}>
                    <Icon name="back" size={18} />
                </button>
                <Tile title={entry.title} icon={entry.icon} customIcon={entry.customIcon} />
                <h1 class="bar__title">{entry.title || t('uiNoTitle')}</h1>
            </header>
            <div class="fields">
                {shown.map((f) => (
                    <button class="fields__row" data-field={f.key} onClick={() => void copy(f.key)}>
                        <span class="fields__text">
                            <span class="fields__label">{t(f.label)}</span>
                            <span class={f.secret ? 'fields__value fields__value--secret' : 'fields__value'}>
                                {values[f.key]}
                            </span>
                        </span>
                        <span class="fields__copy">{copied === f.key ? t('uiCopied') : t('uiCopy')}</span>
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
                        {t('uiFill')}
                    </button>
                </div>
            )}
        </div>
    );
}

function WebMessage(props: {
    keeWebUrl: string;
    title: string;
    hint: string;
    action: string;
    actionId: string;
    onAction: () => void;
}) {
    return (
        <div class="unlock">
            <Mark size={64} />
            <h1 class="unlock__name" id="web-title">
                {props.title}
            </h1>
            <p class="unlock__hint muted">{props.hint}</p>
            <button class="primary" id={props.actionId} onClick={props.onAction}>
                {props.action}
            </button>
            <p class="unlock__host muted">{hostOf(props.keeWebUrl) || props.keeWebUrl}</p>
        </div>
    );
}

/** Web mode with an older KeeWebX that cannot list entries. */
function WebBasic(props: { keeWebUrl: string; tab?: chrome.tabs.Tab; onFilled: () => void }) {
    const host = hostOf(props.tab?.url);
    const fill = async () => {
        await chrome.runtime.sendMessage({ action: 'invoke-action-click', tabId: props.tab!.id });
        props.onFilled();
    };
    return (
        <div class="list">
            <div class="scroll web-body">
                <p class="muted">{t('uiWebOldApp')}</p>
                {host && (
                    <button class="primary" id="web-fill" onClick={() => void fill()}>
                        {t('uiFillOn', host)}
                    </button>
                )}
            </div>
            <WebFooter keeWebUrl={props.keeWebUrl} />
        </div>
    );
}
