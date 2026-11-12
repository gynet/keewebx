import { createThemeController, ThemeButton, ThemePicker } from 'ui-kit/theme';
import { storageKey } from 'comp/settings/storage-namespace';
import { t } from './i18n';

export const theme = createThemeController(storageKey('uiTheme'));
export function ThemeToggle() {
    return <ThemeButton controller={theme} className="round"
        toLight={t('Switch to light mode')} toDark={t('Switch to dark mode')} />;
}
export function ThemeSelect() {
    return <ThemePicker controller={theme} className="plain-select" label={t('Theme')}
        system={t('System')} light={t('Light')} dark={t('Dark')} />;
}
