import { keyboardShortcutHelp } from './keyboard-shortcuts';
import { usePreferences } from './app-preferences';
import { t } from './i18n';

export function ShortcutReference() {
    const settings = usePreferences();
    const shortcuts = keyboardShortcutHelp(navigator.platform).filter(shortcut => !shortcut.policy || settings[shortcut.policy]);
    return <details class="preference-help shortcut-reference"><summary>{t('Keyboard reference')}</summary>
        <p>{t('Shortcuts apply to the current interface. Dialogs and recovery screens keep their own controls; text editing keeps native shortcuts.')}</p>
        <p>{t('Toolbar buttons and visible menus provide the same actions on touch screens.')}</p>
        <dl>{shortcuts.map(shortcut => <div key={shortcut.id}>
            <dt>{t(shortcut.label)} <kbd>{shortcut.shortcut}</kbd></dt><dd>{t(shortcut.when)}</dd>
        </div>)}</dl>
    </details>;
}
