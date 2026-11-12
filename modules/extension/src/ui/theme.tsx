import { createThemeController, ThemeButton, ThemePicker } from 'ui-kit/theme';
import { t } from './i18n';

const theme = createThemeController('uiTheme');
export function ThemeToggle() {
    return <ThemeButton controller={theme} className="round-btn"
        toLight={t('uiThemeToLight')} toDark={t('uiThemeToDark')} />;
}
export function ThemeSelect() {
    return <ThemePicker controller={theme} className="plain-select" label={t('uiTheme')}
        system={t('uiThemeSystem')} light={t('uiThemeLight')} dark={t('uiThemeDark')} />;
}
