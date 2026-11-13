import { useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { Storage } from 'storage';
import type { StorageBase } from 'storage/storage-base';
import { Locale } from 'util/locale';
import { setShortLivedProviderSessions } from 'comp/app/provider-preferences';
import { Events } from 'framework/events';
import { getSessionAccess } from 'comp/app/session-access';
import { usePreferences } from './app-preferences';
import { t } from './i18n';

interface ConfigField {
    id: string; title: string; type: string; value?: unknown; options?: Record<string, string>;
    desc?: string; placeholder?: string; pattern?: string; required?: boolean;
}
type Provider = StorageBase & {
    getSettingsConfig?(): { fields: ConfigField[] };
    applySetting?(key: string, value: unknown): void;
};
const label = (key: string) => (Locale as Record<string, string>)[key] || t(key);

export function ProviderPreferences({ model }: { model: AppModel }) {
    usePreferences();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [, refresh] = useState(0);
    const providers = (Object.values(Storage) as Provider[]).filter(provider => !provider.system && provider.name).sort((a, b) => (a.uipos ?? 0) - (b.uipos ?? 0));
    const access = getSessionAccess(model);
    const run = async (action: () => Promise<void> | void) => {
        if (busy || access.state !== 'open') return;
        setBusy(true); setMessage('');
        try { await action(); refresh(n => n + 1); Events.emit('refresh'); }
        catch { setMessage(t('Some provider settings could not be applied. Retry before closing the app.')); }
        finally { setBusy(false); }
    };
    return <section class="app-preferences" aria-label={t('Storage providers')}>
        <h2 class="group-title">{t('Storage providers')}</h2>
        <div class="cardlist">
            <label class="cardlist__row" for="setting-short-lived"><span>{t('Do not retain provider sessions')}</span>
                <input id="setting-short-lived" type="checkbox" checked={AppSettingsModel.shortLivedStorageToken} disabled={busy}
                    onChange={event => {
                        const enabled = event.currentTarget.checked;
                        void run(async () => {
                            await setShortLivedProviderSessions(enabled);
                        });
                    }} />
            </label>
            <p class="general-preferences__help">{t('Enabling this clears retained provider tokens. Providers may require sign-in again. WebDAV uses each vault’s saved connection details and has no sign-in session.')}</p>
            {providers.map(provider => <div key={provider.name!}>
                <label class="cardlist__row" for={`provider-${provider.name}`}><span>{label(provider.name!)}</span>
                    <input id={`provider-${provider.name}`} type="checkbox" checked={provider.enabled} disabled={busy || !AppSettingsModel.canOpenStorage}
                        onChange={event => {
                            const enabled = event.currentTarget.checked;
                            void run(() => {
                                if (!AppSettingsModel.canOpenStorage) return;
                                provider.setEnabled(enabled);
                                (AppSettingsModel as unknown as Record<string, unknown>)[provider.name!] = provider.enabled;
                            });
                        }} />
                </label>
                {provider.enabled && provider.getSettingsConfig?.().fields.map(field => <ProviderField key={field.id} provider={provider}
                    field={field} disabled={busy || !AppSettingsModel.canOpenStorage} apply={(value) => void run(() => {
                        if (!AppSettingsModel.canOpenStorage || !provider.enabled) return;
                        provider.applySetting?.(field.id, value);
                    })} />)}
                {provider.loggedIn && <div class="cardlist__row"><span>{t('Signed in to {}', label(provider.name!))}</span>
                    <button type="button" class="pill" disabled={busy} onClick={() => void run(async () => {
                        await provider.logout();
                    })}>{t('Sign out')}</button></div>}
            </div>)}
            {!AppSettingsModel.canOpenStorage && <p class="general-preferences__help">{t('Storage connections are disabled by this host.')}</p>}
            {message && <div class="general-preferences__help" role="alert">{message}{AppSettingsModel.shortLivedStorageToken && <button class="pill" type="button" disabled={busy} onClick={() => void run(() => setShortLivedProviderSessions(true))}>{t('Retry clearing provider sessions')}</button>}</div>}
        </div>
    </section>;
}

function ProviderField({ provider, field, disabled, apply }: {
    provider: Provider; field: ConfigField; disabled: boolean; apply(value: unknown): void;
}) {
    const id = `provider-setting-${provider.name}-${field.id}`;
    const [draft, setDraft] = useState(String(field.value ?? ''));
    const selected = field.id === 'webdavSaveMethod' && field.value === 'move' ? 'default' : String(field.value ?? '');
    if (!provider.applySetting || !['checkbox', 'select', 'text', 'password', 'url'].includes(field.type)) return null;
    return <div>
        <label class="cardlist__row" for={id}><span>{label(field.title)}</span>
            {field.type === 'checkbox' ? <input id={id} type="checkbox" checked={!!field.value} disabled={disabled} onChange={e => apply(e.currentTarget.checked)} />
                : field.type === 'select' ? <select id={id} class="plain-select" value={selected} disabled={disabled} onChange={e => apply(e.currentTarget.value)}>
                    {!Object.prototype.hasOwnProperty.call(field.options ?? {}, selected) && <option value={selected}>{selected}</option>}
                    {Object.entries(field.options ?? {}).map(([value, text]) => <option key={value} value={value}>{label(text)}</option>)}
                </select> : <input id={id} class="input" type={field.type} value={draft} disabled={disabled}
                    required={field.required} pattern={field.pattern} placeholder={field.placeholder && label(field.placeholder)}
                    onInput={e => {
                        const value = e.currentTarget.value;
                        setDraft(value);
                        // Empty resets provider detection; password whitespace is significant.
                        if (!value || e.currentTarget.checkValidity()) apply(value);
                    }} onBlur={e => { if (e.currentTarget.value) e.currentTarget.reportValidity(); }} />}
        </label>
        {field.desc && <p class="general-preferences__help">{label(field.desc)}</p>}
    </div>;
}
