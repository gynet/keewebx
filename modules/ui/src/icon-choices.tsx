import { ENTRY_ICONS } from 'const/icon-registry';
import { EntryIcon } from 'ui-kit/icons';
import { t } from './i18n';
const name = (value: string) => value.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
export function IconChoices({ value, customIcons, disabled, onChange, onUpload }: {
    value: string; customIcons: Record<string, string>; disabled: boolean; onChange(value: string): void; onUpload(file: File): void;
}) {
    return <>
        <fieldset disabled={disabled}><legend>{t('Built-in icon')}</legend>
            <div class="entry-appearance__icons">{ENTRY_ICONS.map((icon, index) => <label key={icon} title={name(icon)}>
                <input type="radio" name="appearance-icon" aria-label={t('Icon: {}', name(icon))} checked={value === `builtin:${index}`} onChange={() => onChange(`builtin:${index}`)} />
                <EntryIcon name={icon} size={24} />
            </label>)}</div>
        </fieldset>
        {Object.keys(customIcons).length > 0 && <fieldset disabled={disabled}><legend>{t('Custom icons in this vault')}</legend>
            <div class="entry-appearance__icons">{Object.entries(customIcons).map(([id, data], index) => <label key={id}>
                <input type="radio" name="appearance-icon" aria-label={t('Custom icon {}', String(index + 1))} checked={value === `custom:${id}`} onChange={() => onChange(`custom:${id}`)} />
                <img src={data} alt="" width="28" height="28" />
            </label>)}</div>
        </fieldset>}
        <label class="vault-form__field">{t('Upload icon')}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled}
            onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) onUpload(file); }} /></label>
    </>;
}
