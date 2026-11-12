import { useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { createVault } from 'comp/app/vault-files';
import { Mark } from 'ui-kit/mark';
import { t } from './i18n';

export function CreateVault({ model, onCreated }: { model: AppModel; onCreated?: () => void }) {
    const [name, setName] = useState('');
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const create = async (event: Event) => {
        event.preventDefault();
        if (password !== confirmation) { setError(t('Passwords do not match.')); return; }
        setBusy(true);
        setError('');
        try {
            await createVault(model, name, password);
            setPassword('');
            setConfirmation('');
            onCreated?.();
        } catch (error) {
            setError(String((error as Error).message));
        } finally { setBusy(false); }
    };
    return <form class="card" aria-label={t('Create a vault')} onSubmit={create}>
        <Mark size={64} />
        <h1 class="card__title">{t('Create a vault')}</h1>
        <p class="card__sub">{t('Saved encrypted on this device.')}</p>
        <div class="card__form">
            <label class="vault-form__field">{t('Vault name')}<input class="input" required value={name}
                onInput={(event) => setName(event.currentTarget.value)} autoComplete="off" /></label>
            <label class="vault-form__field">{t('Master password')}<input class="input" required type="password"
                autoComplete="new-password" value={password} onInput={(event) => setPassword(event.currentTarget.value)} /></label>
            <label class="vault-form__field">{t('Confirm password')}<input class="input" required type="password"
                autoComplete="new-password" value={confirmation} onInput={(event) => setConfirmation(event.currentTarget.value)} /></label>
            {error && <p class="error" role="alert">{error}</p>}
            <button class="pill pill--primary" type="submit" disabled={busy}>{t(busy ? 'Creating…' : 'Create vault')}</button>
        </div>
    </form>;
}
