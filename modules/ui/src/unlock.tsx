/** No vault open: recent vaults on the left, an unlock card or a way to add one on the right. */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ByteUtils, Consts } from 'kdbxweb';
import type { AppModel } from 'models/app-model';
import { VaultApi } from 'comp/app/vault-api';
import { Locale } from 'util/locale';
import { Icon, Mark } from 'ui-kit/mark';
import { t } from './i18n';
import { ThemeToggle } from './theme';
import { ImportVault } from './import-vault';
import { CreateVault } from './create-vault';
import { SwipeVaultRow } from './swipe-vault-row';
import { LocalPasskeyUnlock } from './local-passkey-unlock';
import { SidebarToggle, useSidebarCollapse } from './sidebar-collapse';
import { PanelResizer } from 'ui-kit/panel-resizer';

interface RecentFile {
    id: string;
    name: string;
    storage: string | null;
    path?: string | null;
}

type Pane =
    | { kind: 'create' }
    | { kind: 'import' }
    | { kind: 'recent'; file: RecentFile }
    | { kind: 'file'; name: string; data: string }
    | { kind: 'webdav' }
    | { kind: 'webdav-unlock'; url: string; user: string; pass: string }
    | { kind: 'none' };

const kdbxName = (name: string) => (/\.kdbx$/i.test(name) ? name : `${name}.kdbx`);

function where(file: RecentFile): string {
    if (file.storage === 'webdav') {
        try {
            return `${t('WebDAV')} · ${new URL(String(file.path)).hostname}`;
        } catch {
            return t('WebDAV');
        }
    }
    return t('File on this device');
}

function toBase64(buf: ArrayBuffer): string {
    return ByteUtils.bytesToBase64(buf);
}

export function Unlock({ model, extensionRequest = false, onCancelExtensionRequest, onPasskeySetup, canOpen, onOpened, onCreating }: {
    model: AppModel; extensionRequest?: boolean; onCancelExtensionRequest?(): void; onPasskeySetup(id: string): void;
    canOpen?(): boolean; onOpened?(): void; onCreating?(busy: boolean): void;
}) {
    const sidebar = useSidebarCollapse('start');
    const additional = !!onOpened;
    const [creating, setCreating] = useState(false);
    const recent: RecentFile[] = model.fileInfos.filter(fi => !additional || !model.files.get(fi.id)?.active).map((fi) => ({
        id: fi.id,
        name: fi.name,
        storage: fi.storage,
        path: fi.path
    }));
    const [pane, setPane] = useState<Pane>(!additional && recent[0] ? { kind: 'recent', file: recent[0] } : { kind: 'none' });
    const fileInput = useRef<HTMLInputElement>(null);
    const readVersion = useRef(0);
    const setupIntent = useRef(0);
    const [readingFile, setReadingFile] = useState(false);
    const [fileError, setFileError] = useState<{ message: string; retry?: File } | null>(null);
    useEffect(() => () => { ++readVersion.current; }, []);

    const cancelFileRead = () => {
        ++setupIntent.current;
        ++readVersion.current;
        setReadingFile(false);
        setFileError(null);
    };
    const selectPane = (next: Pane) => {
        cancelFileRead();
        setPane(next);
    };
    const readFile = async (file: File) => {
        const version = ++readVersion.current;
        setReadingFile(true);
        setFileError(null);
        try {
            const data = await file.arrayBuffer();
            if (version !== readVersion.current) return;
            // Match Classic's signature check before replacing the selected vault.
            const signature = data.byteLength >= 8 ? new DataView(data) : null;
            const magic = signature?.getUint32(0, true);
            const format = signature?.getUint32(4, true);
            if (magic !== Consts.Signatures.FileMagic || format !== Consts.Signatures.Sig2Kdbx) {
                setFileError({ message: t(magic === Consts.Signatures.FileMagic && format === Consts.Signatures.Sig2Kdb
                    ? Locale.openKdbFileBody : Locale.openWrongFileBody) });
                return;
            }
            ++setupIntent.current;
            setPane({ kind: 'file', name: file.name, data: toBase64(data) });
        } catch {
            if (version === readVersion.current) {
                setFileError({ message: t(Locale.openFailedRead), retry: file });
            }
        } finally {
            if (version === readVersion.current) setReadingFile(false);
        }
    };
    const chooseFile = () => {
        const input = fileInput.current;
        const file = input?.files?.[0];
        if (input) input.value = '';
        if (file) void readFile(file);
    };

    return (
        <div class={`start start--foldable${sidebar.collapsed ? ' sidebar-folded' : ''}`} style={{ '--start-sidebar-width': `${sidebar.width}px` }}>
            <aside class="start__side" aria-label={t('Your vaults')}>
                <SidebarToggle collapsed={sidebar.collapsed} toggle={sidebar.toggle} controls="start-sidebar-content" label={t('Your vaults')} />
                <div class="sidebar-rail">
                    <button type="button" class="round" disabled={creating} aria-label={t('Open a file')} title={t('Open a file')} onClick={() => { sidebar.toggle(); fileInput.current?.click(); }}><Icon name="file" size={18} /></button>
                    <ThemeToggle />
                </div>
                <div id="start-sidebar-content" class="start-sidebar-content">
                <div class="start__tools">
                    {!additional && <a class="link" href="index.html?ui=classic">{t('Open Classic')}</a>}
                    <ThemeToggle />
                </div>
                {recent.length > 0 && <h2 class="start__heading">{t('Your vaults')}</h2>}
                {recent.map((file) => {
                    const on = pane.kind === 'recent' && pane.file.id === file.id;
                    return (
                        <SwipeVaultRow key={file.id}>
                        <button
                            class={on ? 'vault-row vault-row--on' : 'vault-row'}
                            disabled={creating}
                            data-vault={file.name}
                            onClick={() => selectPane({ kind: 'recent', file })}
                        >
                            <span class="vault-row__icon">
                                <Icon name={file.storage === 'webdav' ? 'cloud' : 'file'} size={18} />
                            </span>
                            <span class="vault-row__text">
                                <span class="vault-row__name">{kdbxName(file.name)}</span>
                                <span class="vault-row__where">{where(file)}</span>
                            </span>
                        </button>
                        {!additional && model.settings.canRemoveLatest && <button class="round vault-row__remove"
                            aria-label={t('Remove {} from this browser', kdbxName(file.name))}
                            title={t(file.storage ? 'Forget this vault' : 'Remove local copy')}
                            onClick={() => {
                                const message = file.storage
                                    ? 'Forget {} on this browser? Its cached copy and saved connection details will be removed. The remote database will not be deleted.'
                                    : 'Remove {} from this browser? Its encrypted local copy and recent entry will be deleted. Download a backup first if this is your only copy. Original files on disk are not deleted.';
                                if (!window.confirm(t(message, kdbxName(file.name)))) return;
                                model.removeFileInfo(file.id);
                                selectPane({ kind: 'none' });
                            }}><Icon name="trash" size={16} /></button>}
                        </SwipeVaultRow>
                    );
                })}
                <h2 class={recent.length ? 'start__heading start__gap' : 'start__heading'}>{t('Add a vault')}</h2>
                {model.settings.canCreate && <button class="add-row" id="create-vault" disabled={creating} onClick={() => selectPane({ kind: 'create' })}>
                    <span class="add-row__icon"><Icon name="plus" /></span>{t('Create a vault')}
                </button>}
                {(model.settings.canImportXml || model.settings.canImportCsv) && <button class="add-row" disabled={creating} onClick={() => selectPane({ kind: 'import' })}>{t('Import XML or CSV')}</button>}
                <input ref={fileInput} type="file" accept=".kdbx,.kdb" disabled={creating} hidden onChange={chooseFile} id="open-file-input" />
                <button class="add-row" id="open-file" disabled={creating} onClick={() => fileInput.current?.click()}>
                    <span class="add-row__icon">
                        <Icon name="file" />
                    </span>
                    {t('Open a file')}
                </button>
                {readingFile && <p role="status">{t('Reading file…')}</p>}
                {fileError && <div role="alert" id="open-file-error">
                    <p class="error">{fileError.message}</p>
                    <button type="button" class="link" onClick={() => {
                        if (fileError.retry) void readFile(fileError.retry);
                        else fileInput.current?.click();
                    }}>{fileError.retry ? t('Retry reading file') : t('Choose another file')}</button>
                </div>}
                <button class="add-row" id="open-webdav" disabled={creating} onClick={() => selectPane({ kind: 'webdav' })}>
                    <span class="add-row__icon">
                        <Icon name="cloud" />
                    </span>
                    {t('Connect to WebDAV')}
                </button>
                {!additional && <button class="add-row" id="open-demo" onClick={() => { cancelFileRead(); VaultApi.openDemo({}); }}>
                    <span class="add-row__icon">
                        <Icon name="play" />
                    </span>
                    {t('Try the demo')}
                </button>}
                </div>
            </aside>
            <PanelResizer label={t('Resize Your vaults panel')} value={sidebar.width} min={240} max={sidebar.max}
                onChange={sidebar.setWidth} onReset={() => sidebar.setWidth(360)} />
            <main class="start__main" style={extensionRequest ? { flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start' } : undefined}>
                {extensionRequest && <div class="card" role="status" style={{ marginBottom: '16px' }}>
                    <p>{t('Unlock to connect a browser extension')}</p>
                    <button class="pill" type="button" onClick={onCancelExtensionRequest}>{t('Cancel extension request')}</button>
                </div>}
                {pane.kind === 'import' ? <div class="card"><ImportVault model={model} onDone={onOpened} canImport={canOpen} /></div>
                    : pane.kind === 'create' ? <CreateVault model={model} onCreated={onOpened} onBusyChange={busy => { setCreating(busy); onCreating?.(busy); }} /> : pane.kind === 'webdav' ? (
                    <WebDavForm onNext={(url, user, pass) => selectPane({ kind: 'webdav-unlock', url, user, pass })} />
                ) : pane.kind === 'none' ? (
                    <div class="card">
                        <Mark size={76} />
                        <h1 class="card__title">{t('Open a vault')}</h1>
                        <p class="card__sub">{t(additional ? 'Open a KeePass file, connect to WebDAV, or create a vault.' : 'Open a KeePass file, connect to WebDAV, or try the demo.')}</p>
                    </div>
                ) : (
                    <UnlockCard key={JSON.stringify(pane)} model={model} pane={pane} canOpen={canOpen} onOpened={onOpened} onUnlock={cancelFileRead} capturePasskeySetup={() => {
                        const intent = setupIntent.current;
                        return (id: string) => { if (setupIntent.current === intent) onPasskeySetup(id); };
                    }} />
                )}
            </main>
        </div>
    );
}

function UnlockCard({ model, pane, onUnlock, capturePasskeySetup, canOpen, onOpened }: {
    model: AppModel;
    pane: Exclude<Pane, { kind: 'webdav' } | { kind: 'none' } | { kind: 'create' } | { kind: 'import' }>;
    onUnlock(): void; capturePasskeySetup(): (id: string) => void;
    canOpen?(): boolean; onOpened?(): void;
}) {
    const mounted = useRef(true);
    useLayoutEffect(() => () => { mounted.current = false; }, []);
    const admission = canOpen ? () => mounted.current && canOpen() : undefined;
    const [setupAfterUnlock, setSetupAfterUnlock] = useState(false);
    const [password, setPassword] = useState('');
    const [show, setShow] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [diagnostic, setDiagnostic] = useState('');
    const errorDetails = useRef<HTMLDetailsElement>(null);
    const setMessage = (message: string) => {
        errorDetails.current?.removeAttribute('open');
        setDiagnostic('');
        setError(message);
    };
    const [keyFile, setKeyFile] = useState<{ name: string; data: string } | null>(null);
    const [readingKey, setReadingKey] = useState(false);
    const keyInput = useRef<HTMLInputElement>(null);
    const name =
        pane.kind === 'recent'
            ? pane.file.name
            : pane.kind === 'file'
            ? pane.name
            : decodeURIComponent(pane.url.split('/').pop() || 'vault');
    const sub =
        pane.kind === 'recent' ? where(pane.file) : pane.kind === 'file' ? t('File on this device') : t('WebDAV');

    const unlock = async (e: Event) => {
        e.preventDefault();
        onUnlock();
        setBusy(true);
        setMessage('');
        try {
            const navigateToSetup = capturePasskeySetup();
            let result: unknown;
            const key = keyFile ? { keyFileData: keyFile.data, keyFileName: keyFile.name } : {};
            if (pane.kind === 'recent') {
                result = await VaultApi.unlock({ id: pane.file.id, password, ...key, canOpen: admission });
            } else if (pane.kind === 'file') {
                result = await VaultApi.openData({ name: pane.name, data: pane.data, password, ...key, canOpen: admission });
            } else {
                result = await VaultApi.openWebDav({ url: pane.url, user: pane.user, pass: pane.pass, password, ...key, canOpen: admission });
            }
            if (admission && !admission()) return;
            if (setupAfterUnlock) {
                const id = (result as { openedFileId?: unknown })?.openedFileId;
                const file = typeof id === 'string' ? model.files.get(id) : undefined;
                if (file?.active) navigateToSetup(file.id);
            }
            onOpened?.();
        } catch (err) {
            if (!mounted.current) return;
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'invalid-password') setMessage(t('Wrong password'));
            else {
                setMessage(`${t(Locale.openErrorDescription)}. ${t('Try again or choose another file.')}`);
                setDiagnostic(msg);
            }
            setBusy(false);
        }
    };

    return (
        <form class="card" onSubmit={unlock}>
            <Mark size={76} />
            <h1 class="card__title">{kdbxName(name)}</h1>
            <p class="card__sub">{sub}</p>
            <label class="sr-only" for="password">
                {t('Master password')}
            </label>
            <div style={{ position: 'relative', width: '100%' }}>
                <input
                    id="password"
                    class={error ? 'input input--error' : 'input'}
                    type={show ? 'text' : 'password'}
                    placeholder={t('Master password')}
                    value={password}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                    disabled={busy}
                    autoFocus
                    style={{ paddingRight: '48px' }}
                />
                <button
                    type="button"
                    class="icon-btn"
                    aria-label={show ? t('Hide password') : t('Show password')}
                    onClick={() => setShow(!show)}
                    style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)' }}
                >
                    <Icon name="eye" size={18} />
                </button>
            </div>
            <div class="unlock-key-file">
                <input ref={keyInput} id="unlock-key-file" type="file" hidden disabled={busy || readingKey}
                    onChange={async (event) => {
                        const file = event.currentTarget.files?.[0];
                        if (!file) return;
                        setReadingKey(true);
                        try { setKeyFile({ name: file.name, data: toBase64(await file.arrayBuffer()) }); setMessage(''); }
                        catch { setMessage(t('Unable to read the key file.')); }
                        finally { setReadingKey(false); }
                    }} />
                <button type="button" class="link" disabled={busy || readingKey} onClick={() => keyInput.current?.click()}>
                    {keyFile ? t('Key file: {}', keyFile.name) : t('Use a key file')}
                </button>
                {keyFile && <button type="button" class="link" disabled={busy || readingKey} onClick={() => {
                    setKeyFile(null); if (keyInput.current) keyInput.current.value = '';
                }}>{t('Remove key file')}</button>}
            </div>
            {error && (
                <p class="error" role="alert" id="unlock-error" style={{ alignSelf: 'flex-start' }}>
                    {error}
                </p>
            )}
            {diagnostic && <details ref={errorDetails} id="unlock-error-details" style={{ alignSelf: 'stretch' }}>
                <summary>{t('Error details')}</summary>
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{diagnostic}</pre>
            </details>}
            <LocalPasskeyUnlock model={model} id={pane.kind === 'recent' ? pane.file.id : undefined}
                setupAfterUnlock={setupAfterUnlock} onSetupChange={setSetupAfterUnlock} canOpen={admission} onOpened={onOpened}
                keyFile={keyFile} busy={busy || readingKey} setBusy={setBusy} setMessage={setMessage} onAttempt={onUnlock} />
            <button class="pill pill--primary pill--block" id="unlock" disabled={busy || readingKey}>
                {busy ? t('Unlocking…') : t('Unlock')}
            </button>
        </form>
    );
}

function WebDavForm({ onNext }: { onNext: (url: string, user: string, pass: string) => void }) {
    const [url, setUrl] = useState('');
    const [user, setUser] = useState('');
    const [pass, setPass] = useState('');
    const valid = /^https?:\/\/.+\/.+/.test(url.trim());
    return (
        <form
            class="card"
            onSubmit={(e) => {
                e.preventDefault();
                if (valid) {
                    onNext(url.trim(), user, pass);
                }
            }}
        >
            <h1 class="card__title">{t('Connect to WebDAV')}</h1>
            <p class="card__sub">{t('The address of a .kdbx file on your server')}</p>
            <div class="card__form">
                <label class="field-label">
                    {t('File address')}
                    <input
                        id="webdav-url"
                        class="input"
                        value={url}
                        placeholder="https://cloud.example.com/vault.kdbx"
                        onInput={(e) => setUrl(e.currentTarget.value)}
                        autoFocus
                    />
                </label>
                <label class="field-label">
                    {t('Username')}
                    <input id="webdav-user" class="input" value={user} onInput={(e) => setUser(e.currentTarget.value)} />
                </label>
                <label class="field-label">
                    {t('Password')}
                    <input
                        id="webdav-pass"
                        class="input"
                        type="password"
                        value={pass}
                        onInput={(e) => setPass(e.currentTarget.value)}
                    />
                </label>
            </div>
            <button class="pill pill--primary pill--block" id="webdav-next" disabled={!valid}>
                {t('Continue')}
            </button>
        </form>
    );
}
