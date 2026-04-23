import { View } from 'framework/views/view';
import template from 'templates/extension/extension-save-entry.hbs';

interface SaveEntryGroup {
    id: string;
    fileId: string;
    selected?: boolean;
}

interface SaveEntryConfig {
    askSave: string;
    groupId: string;
    fileId: string;
}

interface SaveEntryModel {
    allGroups: SaveEntryGroup[];
    askSave?: string;
    // Additional fields are passed through to the template (extensionName,
    // url, user, update flag) — we don't use them in the constructor and
    // the template renderer is loose-typed.
    [key: string]: unknown;
}

class ExtensionSaveEntryView extends View {
    template = template;

    events: Record<string, string> = {
        'change #extension-save-entry__auto': 'autoChanged',
        'change #extension-save-entry__group': 'groupChanged'
    };

    config: SaveEntryConfig;

    constructor(model: SaveEntryModel) {
        super(model);

        const selectedGroup = model.allGroups.find((g) => g.selected);
        this.config = {
            askSave: model.askSave || 'always',
            groupId: selectedGroup?.id ?? '',
            fileId: selectedGroup?.fileId ?? ''
        };
    }

    render(): this | undefined {
        super.render(this.model);
        return this;
    }

    autoChanged(e: Event): void {
        this.config.askSave = (e.target as HTMLInputElement).checked ? 'auto' : 'always';
    }

    groupChanged(e: Event): void {
        const select = e.target as HTMLSelectElement;
        const option = select.options[select.selectedIndex];
        this.config.groupId = option.value;
        this.config.fileId = option.dataset.file ?? '';
    }
}

export { ExtensionSaveEntryView };
