import { View } from 'framework/views/view';
import template from 'templates/extension/extension-create-group.hbs';

interface ExtensionFile {
    id: string;
    selected?: boolean;
}

interface ExtensionCreateGroupModel {
    files: ExtensionFile[];
    // Additional fields pass through to the template (extension name etc.).
    [key: string]: unknown;
}

class ExtensionCreateGroupView extends View {
    template = template;

    events: Record<string, string> = {
        'change #extension-create-group__file': 'fileChanged'
    };

    selectedFile: string;

    constructor(model: ExtensionCreateGroupModel) {
        super(model);

        const selected = model.files.find((f) => f.selected);
        this.selectedFile = selected ? selected.id : '';
    }

    render(): this | undefined {
        super.render(this.model);
        return this;
    }

    fileChanged(e: Event): void {
        this.selectedFile = (e.target as HTMLSelectElement).value;
    }
}

export { ExtensionCreateGroupView };
