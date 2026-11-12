/** No vault open: recent vaults on the left, an unlock card or a way to add one on the right. */
import { useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { VaultApi } from 'comp/app/vault-api';
import { Icon, Mark } from 'ui-kit/mark';
import { t } from './i18n';
import { ThemeToggle } from './theme';
import { CreateVault } from './create-vault';
import { SwipeVaultRow } from './swipe-vault-row';

interface RecentFile {
    id: string;
    name: string;
    storage: string | null;
    path?: string | null;
}

type Pane =
    | { kind: 'create' }
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
    let s = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

export function Unlock({ model }: { model: AppModel }) {
    const recent: RecentFile[] = model.fileInfos.map((fi) => ({
        id: fi.id,
        name: fi.name,
        storage: fi.storage,
        path: fi.path
    }));
    const [pane, setPane] = useState<Pane>(recent[0] ? { kind: 'recent', file: recent[0] } : { kind: 'none' });
    const fileInput = useRef<HTMLInputElement>(null);

    const chooseFile = async () => {
        const file = fileInput.current?.files?.[0];
        if (file) {
            setPane({ kind: 'file', name: file.name, data: toBase64(await file.arrayBuffer()) });
        }
    };

    return (
        <div class="start">
            <aside class="start__side" aria-label={t('Your vaults')}>
                <div class="start__tools">
                    <a class="link" href="index.html?ui=classic">{t('Open Classic')}</a>
                    <ThemeToggle />
                </div>
                {recent.length > 0 && <h2 class="start__heading">{t('Your vaults')}</h2>}
                {recent.map((file) => {
                    const on = pane.kind === 'recent' && pane.file.id === file.id;
                    return (
                        <SwipeVaultRow key={file.id}>
                        <button
                            class={on ? 'vault-row vault-row--on' : 'vault-row'}
                            data-vault={file.name}
                            onClick={() => setPane({ kind: 'recent', file })}
                        >
                            <span class="vault-row__icon">
                                <Icon name={file.storage === 'webdav' ? 'cloud' : 'file'} size={18} />
                            </span>
                            <span class="vault-row__text">
                                <span class="vault-row__name">{kdbxName(file.name)}</span>
                                <span class="vault-row__where">{where(file)}</span>
                            </span>
                        </button>
                        {!file.storage && model.settings.canRemoveLatest && <button class="round vault-row__remove"
                            aria-label={t('Remove {} from this browser', kdbxName(file.name))}
                            title={t('Remove local copy')}
                            onClick={() => {
                                if (!window.confirm(t('Remove {} from this browser? Its encrypted local copy and recent entry will be deleted. Download a backup first if this is your only copy. Original files on disk are not deleted.', kdbxName(file.name)))) return;
                                model.removeFileInfo(file.id);
                                setPane({ kind: 'none' });
                            }}><Icon name="trash" size={16} /></button>}
                        </SwipeVaultRow>
                    );
                })}
                <h2 class={recent.length ? 'start__heading start__gap' : 'start__heading'}>{t('Add a vault')}</h2>
                {model.settings.canCreate && <button class="add-row" id="create-vault" onClick={() => setPane({ kind: 'create' })}>
                    <span class="add-row__icon"><Icon name="plus" /></span>{t('Create a vault')}
                </button>}
                <input ref={fileInput} type="file" accept=".kdbx" hidden onChange={chooseFile} id="open-file-input" />
                <button class="add-row" id="open-file" onClick={() => fileInput.current?.click()}>
                    <span class="add-row__icon">
                        <Icon name="file" />
                    </span>
                    {t('Open a file')}
                </button>
                <button class="add-row" id="open-webdav" onClick={() => setPane({ kind: 'webdav' })}>
                    <span class="add-row__icon">
                        <Icon name="cloud" />
                    </span>
                    {t('Connect to WebDAV')}
                </button>
                <button class="add-row" id="open-demo" onClick={() => VaultApi.openDemo({})}>
                    <span class="add-row__icon">
                        <Icon name="play" />
                    </span>
                    {t('Try the demo')}
                </button>
            </aside>
            <main class="start__main">
                {pane.kind === 'create' ? <CreateVault model={model} /> : pane.kind === 'webdav' ? (
                    <WebDavForm onNext={(url, user, pass) => setPane({ kind: 'webdav-unlock', url, user, pass })} />
                ) : pane.kind === 'none' ? (
                    <div class="card">
                        <Mark size={76} />
                        <h1 class="card__title">{t('Open a vault')}</h1>
                        <p class="card__sub">{t('Open a KeePass file, connect to WebDAV, or try the demo.')}</p>
                    </div>
                ) : (
                    <UnlockCard key={JSON.stringify(pane)} pane={pane} />
                )}
            </main>
        </div>
    );
}

function UnlockCard({ pane }: { pane: Exclude<Pane, { kind: 'webdav' } | { kind: 'none' } | { kind: 'create' }> }) {
    const [password, setPassword] = useState('');
    const [show, setShow] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
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
        setBusy(true);
        setError('');
        try {
            if (pane.kind === 'recent') {
                await VaultApi.unlock({ id: pane.file.id, password });
            } else if (pane.kind === 'file') {
                await VaultApi.openData({ name: pane.name, data: pane.data, password });
            } else {
                await VaultApi.openWebDav({ url: pane.url, user: pane.user, pass: pane.pass, password });
            }
        } catch (err) {
            const msg = (err as Error).message;
            setError(msg === 'invalid-password' ? t('Wrong password') : msg);
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
            {error && (
                <p class="error" id="unlock-error" style={{ alignSelf: 'flex-start' }}>
                    {error}
                </p>
            )}
            <button class="pill pill--primary pill--block" id="unlock" disabled={busy}>
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
