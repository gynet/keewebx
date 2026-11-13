import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { Storage } from 'storage';
import { Locale } from 'util/locale';
import { canOpenProvider } from 'comp/app/vault-policy';
import { getSessionAccess } from 'comp/app/session-access';
import { t } from './i18n';

export interface ProviderItem { name: string; path: string; dir?: boolean; rev?: string; id?: string; opts?: Record<string, unknown>; }
interface ConfigField { id: string; title: string; type?: string; required?: boolean; pattern?: string; placeholder?: string; accept?: string; value?: unknown; options?: Record<string, string>; }
export interface BrowsableProvider {
    name: string; enabled: boolean; system?: boolean; supportsOpen?: boolean;
    needShowOpenConfig?(): boolean;
    getOpenConfig?(): { fields: ConfigField[] };
    applyConfig?(values: Record<string, unknown>, callback: (error?: unknown) => void, options?: { signal: AbortSignal }): void;
    list?(directory: string | null, callback: (error?: unknown, files?: ProviderItem[]) => void, options?: Record<string, unknown>): void;
}
export function browsableProviders(): BrowsableProvider[] {
    return (Object.values(Storage) as BrowsableProvider[]).filter(provider => provider.name !== 'webdav' &&
        canOpenProvider(provider.name) && typeof provider.list === 'function');
}
const label = (value: string) => (Locale as Record<string, string>)[value] || t(value);
export function ProviderOpen({ model, provider, title, canOpen, select, cancel }: {
    model: AppModel; provider: BrowsableProvider; title: string; canOpen?(): boolean;
    select(item: ProviderItem): void; cancel(): void;
}) {
    const fields = provider.getOpenConfig?.().fields ?? [];
    const [configure, setConfigure] = useState(!!provider.needShowOpenConfig?.());
    const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map(field => [field.id, field.value ?? (field.type === 'checkbox' ? false : '')])));
    const [directories, setDirectories] = useState<string[]>([]), [items, setItems] = useState<ProviderItem[]>([]);
    const [showOther, setShowOther] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const mounted = useRef(true), request = useRef<AbortController | null>(null), access = getSessionAccess(model);
    const epoch = useRef(access.epoch).current;
    const valid = () => mounted.current && access.state === 'open' && access.epoch === epoch &&
        canOpenProvider(provider.name) && (!canOpen || canOpen());
    const load = (path: string[]) => {
        request.current?.abort(); const controller = new AbortController(); request.current = controller;
        if (!valid()) return;
        setBusy(true); setError(''); setItems([]);
        let settled = false;
        try { provider.list!(path[path.length - 1] ?? null, (failure, files) => {
            if (settled || controller.signal.aborted || !valid()) return;
            settled = true; request.current = null; setBusy(false);
            if (failure) { setError(String(failure)); return; }
            setDirectories(path); setItems((files ?? []).filter(file => typeof file.name === 'string' && typeof file.path === 'string'));
        }, { ...values, signal: controller.signal }); }
        catch (failure) { if (valid()) { setBusy(false); setError(String(failure)); } }
    };
    useEffect(() => {
        mounted.current = true;
        const off = access.subscribeInvalidation(() => { request.current?.abort(); cancel(); });
        if (!configure) load([]);
        return () => { mounted.current = false; request.current?.abort(); off(); };
    }, []);
    const apply = (event: Event) => {
        event.preventDefault(); if (busy || !valid()) return;
        const controller = new AbortController(); request.current?.abort(); request.current = controller;
        setBusy(true); setError('');
        let settled = false;
        const done = (failure?: unknown) => {
            if (settled) return; settled = true;
            if (controller.signal.aborted || !valid()) return;
            setBusy(false);
            if (failure) { setError(String(failure)); return; }
            setConfigure(false); load([]);
        };
        try { if (provider.applyConfig) provider.applyConfig(values, done, { signal: controller.signal }); else done(); }
        catch (failure) { done(failure); }
    };
    const close = () => { mounted.current = false; request.current?.abort(); cancel(); };
    return <section class="card" aria-label={title} style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}>
        <h1>{title}</h1>
        {configure ? <form onSubmit={apply}>
            <fieldset disabled={busy} style={{ minWidth: 0, border: 0, padding: 0 }}>
                {fields.map(field => <label class="vault-form__field" key={field.id}>{label(field.title)}
                    {field.type === 'file' ? <input class="input" type="file" required={field.required} accept={field.accept} onChange={event => setValues({ ...values, [field.id]: event.currentTarget.files?.[0] })} /> : field.type === 'select' ? <select class="input" value={String(values[field.id])} onChange={event => setValues({ ...values, [field.id]: event.currentTarget.value })}>
                        {Object.entries(field.options ?? {}).map(([value, text]) => <option value={value}>{label(text)}</option>)}
                    </select> : field.type === 'checkbox' ? <input type="checkbox" checked={values[field.id] === true} onChange={event => setValues({ ...values, [field.id]: event.currentTarget.checked })} />
                        : <input class="input" type={['password', 'url', 'number'].includes(field.type ?? '') ? field.type : 'text'}
                            required={field.required} pattern={field.pattern} placeholder={field.placeholder && label(field.placeholder)} value={String(values[field.id])}
                            onInput={event => setValues({ ...values, [field.id]: event.currentTarget.value })} />}
                </label>)}
                <button class="btn" type="submit">{t('Connect')}</button>
            </fieldset>
        </form> : <>
            <p>{directories[directories.length - 1] || t('Root folder')}</p>
            <label><input type="checkbox" checked={showOther} onChange={event => setShowOther(event.currentTarget.checked)} />{t('Show other files')}</label>
            {!!directories.length && <button class="pill" disabled={busy} onClick={() => load(directories.slice(0, -1))}>{t('Parent folder')}</button>}
            <div role="list">{items.filter(item => item.dir || showOther || /\.kdbx$/i.test(item.name)).sort((a, b) => Number(!!b.dir) - Number(!!a.dir) || a.name.localeCompare(b.name)).map(item =>
                <div role="listitem" key={item.id || item.path}><button class="vault-row" disabled={busy} onClick={() => {
                    if (!valid()) return;
                    if (item.dir) load([...directories, item.path]);
                    else { request.current?.abort(); select(item); }
                }}>{item.dir ? `${t('Folder')}: ` : ''}{item.name}</button></div>)}</div>
            {!busy && items.length === 0 && <p>{t('No files found.')}</p>}
            <button class="pill" disabled={busy} onClick={() => load(directories)}>{t('Refresh')}</button>
            {!!fields.length && <button class="pill" disabled={busy} onClick={() => setConfigure(true)}>{t('Connection settings')}</button>}
        </>}
        {busy && <p role="status">{t('Loading…')}</p>}
        {error && <p role="alert">{error}</p>}
        <button class="pill" type="button" onClick={close}>{t('Cancel')}</button>
    </section>;
}
