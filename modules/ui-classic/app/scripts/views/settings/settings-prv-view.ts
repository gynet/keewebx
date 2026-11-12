/* eslint-disable @typescript-eslint/no-explicit-any */
import { View } from 'framework/views/view';
import { Storage } from 'storage';
import template from 'templates/settings/settings-prv.hbs';

const storage = Storage as unknown as Record<string, any>;

class SettingsPrvView extends View {
    template = template;

    events: Record<string, string> = {
        'change .settings__general-prv-field-sel': 'changeField',
        'input .settings__general-prv-field-txt': 'changeField',
        'change .settings__general-prv-field-check': 'changeCheckbox'
    };

    render(): this | undefined {
        const s = storage[this.model.name];
        if (s && s.getSettingsConfig) {
            super.render(s.getSettingsConfig());
        }
        return this;
    }

    changeField(e: any): void {
        const id = e.target.dataset.id;
        const value = e.target.value;
        if (value && !e.target.checkValidity()) {
            return;
        }
        const s = storage[this.model.name];
        s.applySetting(id, value);
        if ($(e.target).is('select')) {
            this.render();
        }
    }

    changeCheckbox(e: any): void {
        const id = e.target.dataset.id;
        const value = !!e.target.checked;
        const s = storage[this.model.name];
        s.applySetting(id, value);
    }
}

export { SettingsPrvView };
