import { usePreferences } from './app-preferences';
import { t } from './i18n';
export function LanguagePreference() {
    const settings = usePreferences();
    const value = settings.locale || '';
    return <div class="cardlist app-preferences"><label class="cardlist__row" for="setting-locale"><span>{t('Language')}</span>
        <select id="setting-locale" class="plain-select" value={value} onChange={event => { settings.locale = event.currentTarget.value || null; }}>
            <option value="">{t('Browser language')}</option>
            <option value="en-US">English</option><option value="de-DE">Deutsch</option><option value="fr-FR">Français</option>
            {!['', 'en-US', 'de-DE', 'fr-FR'].includes(value) && <option value={value}>{t('Current: {}', value)}</option>}
        </select></label></div>;
}
