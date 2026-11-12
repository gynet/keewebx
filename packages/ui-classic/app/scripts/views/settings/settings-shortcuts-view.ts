/* eslint-disable @typescript-eslint/no-explicit-any */
import { View } from 'framework/views/view';
import { Shortcuts } from 'comp/app/shortcuts';
import { Keys } from 'const/keys';
import { Features } from 'util/features';
import { Locale } from 'util/locale';
import template from 'templates/settings/settings-shortcuts.hbs';

const loc = Locale as unknown as Record<string, any>;
const features = Features as unknown as { isMac: boolean };
const shortcuts = Shortcuts as unknown as {
    actionShortcutSymbol(short: boolean): string;
    altShortcutSymbol(short: boolean): string;
    globalShortcutText(type: string): string;
    setGlobalShortcut(type: string, value: any): void;
    keyEventToShortcut(e: any): { value: any; text: string; valid: boolean };
    presentShortcut(value: any): string;
};

class SettingsShortcutsView extends View {
    template = template;

    systemShortcuts = [
        'Meta+A',
        'Alt+A',
        'Alt+C',
        'Alt+D',
        'Meta+F',
        'Meta+C',
        'Meta+B',
        'Meta+U',
        'Meta+T',
        'Alt+N',
        'Meta+O',
        'Meta+S',
        'Meta+G',
        'Meta+,',
        'Meta+L'
    ];

    events: Record<string, string> = {
        'click button.shortcut': 'shortcutClick'
    };

    render(): this | undefined {
        super.render({
            cmd: shortcuts.actionShortcutSymbol(true),
            alt: shortcuts.altShortcutSymbol(true),
            globalIsLarge: !features.isMac,
            autoTypeSupported: false,
            globalShortcuts: undefined
        });
        return this;
    }

    shortcutClick(e: any): void {
        const globalShortcutType = e.target.dataset.shortcut;

        const existing = $(`.shortcut__editor[data-shortcut=${globalShortcutType}]`);
        if (existing.length) {
            existing.remove();
            return;
        }

        const shortcutEditor = $('<div/>')
            .addClass('shortcut__editor')
            .attr('data-shortcut', globalShortcutType);
        $('<div/>').text(loc.setShEdit as string).appendTo(shortcutEditor);
        const shortcutEditorInput = $('<input/>')
            .addClass('shortcut__editor-input')
            .val(shortcuts.globalShortcutText(globalShortcutType))
            .appendTo(shortcutEditor);
        if (!features.isMac) {
            shortcutEditorInput.addClass('shortcut__editor-input--large');
        }

        shortcutEditor.insertAfter($(e.target).parent());
        shortcutEditorInput.focus();
        shortcutEditorInput.on('keypress', (ev: any) => ev.preventDefault());
        shortcutEditorInput.on('keydown', (ev: any) => {
            ev.preventDefault();
            ev.stopImmediatePropagation();

            if (ev.which === Keys.DOM_VK_DELETE || ev.which === Keys.DOM_VK_BACK_SPACE) {
                shortcuts.setGlobalShortcut(globalShortcutType, undefined);
                this.render();
                return;
            }
            if (ev.which === Keys.DOM_VK_ESCAPE) {
                shortcutEditorInput.blur();
                return;
            }

            const shortcut = shortcuts.keyEventToShortcut(ev);
            const presentableShortcutText = shortcuts.presentShortcut(shortcut.value);

            shortcutEditorInput.val(presentableShortcutText);

            const exists = this.systemShortcuts.includes(shortcut.text);
            shortcutEditorInput.toggleClass('input--error', exists);

            const isValid = shortcut.valid && !exists;
            if (isValid) {
                shortcuts.setGlobalShortcut(globalShortcutType, shortcut.value);
                this.render();
            }
        });
    }
}

export { SettingsShortcutsView };
