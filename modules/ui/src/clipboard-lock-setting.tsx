import { t } from './i18n';

export function ClipboardLockSetting({ value, onChange }: { value: boolean; onChange(value: boolean): void }) {
    return <label class="cardlist__row">
        <span title={t('Copies of usernames, URLs and other fields keep the vault open.')}>
            {t('Lock after copying a password')}
        </span>
        <input id="setting-lock-on-copy" type="checkbox" checked={value}
            onChange={event => onChange(event.currentTarget.checked)} />
    </label>;
}
