import type { DatabaseSettings } from 'comp/app/database-settings';
import { t } from './i18n';

export function DatabaseSettingsFields({ value, onChange }: {
    value: DatabaseSettings; onChange: (value: DatabaseSettings) => void;
}) {
    const set = <K extends keyof DatabaseSettings>(key: K, next: DatabaseSettings[K]) => onChange({ ...value, [key]: next });
    const number = (key: 'historyItems' | 'historyBytes' | 'iterations' | 'memoryKiB' | 'parallelism' | 'keyChangeDays', label: string, min: number, factor = 1) =>
        <label class="vault-form__field">{t(label)}<input class="input" type="number" required min={min} step="any"
            value={value[key] === -1 ? -1 : value[key] / factor} onInput={(event) => {
                const raw = event.currentTarget.value;
                set(key, raw === '' ? NaN : Number(raw) === -1 ? -1 : Number(raw) * factor);
            }} /></label>;
    return <>
        <label class="vault-form__field">{t('Vault name')}<input class="input" required value={value.name}
            onInput={(event) => set('name', event.currentTarget.value)} /></label>
        <details class="database-advanced">
            <summary>{t('Advanced')}</summary>
            <label class="vault-form__field">{t('Default user')}<input class="input" value={value.defaultUser}
                onInput={(event) => set('defaultUser', event.currentTarget.value)} /></label>
            <label class="vault-form__field"><span><input type="checkbox" checked={value.recycleBin}
                onChange={(event) => set('recycleBin', event.currentTarget.checked)} /> {t('Enable trash')}</span></label>
            <label class="vault-form__field">{t('Entry history')}<select class="input" aria-label={t('Entry history')} value={value.historyItems < 0 ? '-1' : value.historyItems === 0 ? '0' : 'limited'}
                onChange={(event) => set('historyItems', event.currentTarget.value === 'limited' ? 10 : Number(event.currentTarget.value))}>
                <option value="limited">{t('Delete old history records automatically')}</option>
                <option value="-1">{t('Keep history')}</option><option value="0">{t('Disable history')}</option>
            </select></label>
            {value.historyItems > 0 && number('historyItems', 'History length, records per entry', 1)}
            {number('historyBytes', 'History size, MB (-1 for unlimited)', -1, 1024 * 1024)}
            <label class="vault-form__field">{t('Key derivation function')}<select class="input" aria-label={t('Key derivation function')} value={value.kdf}
                onChange={(event) => set('kdf', event.currentTarget.value)}>
                <option>Argon2d</option><option>Argon2id</option>{value.kdf === 'Aes' && <option value="Aes">AES (existing)</option>}
            </select></label>
            {value.kdf !== 'Aes' && <>
                {number('iterations', 'Iterations', 1)}{number('memoryKiB', 'Memory, KiB', 8)}{number('parallelism', 'Parallelism', 1)}
            </>}
            {number('keyChangeDays', 'Ask to change key after days (-1 to disable)', -1)}
        </details>
    </>;
}
