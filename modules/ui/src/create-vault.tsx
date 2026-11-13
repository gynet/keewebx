import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { createVault, saveVault } from 'comp/app/vault-files';
import { Mark } from 'ui-kit/mark';
import { t } from './i18n';
import { defaultDatabaseSettings } from 'comp/app/database-settings';
import { DatabaseSettingsFields } from './database-settings-fields';

export function CreateVault({ model, onCreated, onBusyChange }: { model: AppModel; onCreated?: () => void; onBusyChange?(busy: boolean): void }) {
    const [settings, setSettings] = useState(defaultDatabaseSettings);
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const created = useRef<FileModel>();
    const running = useRef(false);
    const mounted = useRef(true);
    useLayoutEffect(() => () => { mounted.current = false; }, []);
    const create = async (event: Event) => {
        event.preventDefault();
        if (running.current) return;
        if (password !== confirmation) { setError(t('Passwords do not match.')); return; }
        running.current = true;
        setBusy(true); onBusyChange?.(true);
        setError('');
        try {
            if (created.current) {
                if (!created.current.active || model.files.get(created.current.id) !== created.current) {
                    throw new Error(t('The vault is no longer open.'));
                }
                await saveVault(model, created.current);
            } else {
                await createVault(model, settings.name, password, settings, file => { created.current = file; });
            }
            if (!mounted.current) return;
            setPassword('');
            setConfirmation('');
            onCreated?.();
        } catch (error) {
            if (mounted.current) setError(String((error as Error).message));
        } finally {
            running.current = false;
            if (mounted.current) { setBusy(false); onBusyChange?.(false); }
        }
    };
    return <form class="card" aria-label={t('Create a vault')} onSubmit={create}>
        <Mark size={64} />
        <h1 class="card__title">{t('Create a vault')}</h1>
        <p class="card__sub">{t('Saved encrypted on this device.')}</p>
        <div class="card__form">
            <fieldset disabled={busy || !!created.current} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: '12px' }}>
            <DatabaseSettingsFields value={settings} onChange={setSettings} />
            <label class="vault-form__field">{t('Master password')}<input class="input" required type="password"
                autoComplete="new-password" value={password} onInput={(event) => setPassword(event.currentTarget.value)} /></label>
            <label class="vault-form__field">{t('Confirm password')}<input class="input" required type="password"
                autoComplete="new-password" value={confirmation} onInput={(event) => setConfirmation(event.currentTarget.value)} /></label>
            </fieldset>
            {created.current && error && <p role="status">{t('The vault is open but its initial save failed. Retry saving or return to your open vaults.')}</p>}
            {error && <p class="error" role="alert">{error}</p>}
            <button class="pill pill--primary" type="submit" disabled={busy}>{t(busy ? 'Creating…' : created.current ? 'Retry saving' : 'Create vault')}</button>
        </div>
    </form>;
}
