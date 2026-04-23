import { View } from 'framework/views/view';
import template from 'templates/extension/extension-connect.hbs';

interface ConnectFile {
    id: string;
    name: string;
    checked?: boolean;
}

interface ConnectConfig {
    askGet: unknown;
    allFiles: boolean;
    files: string[];
}

class ExtensionConnectView extends View {
    template = template;

    events: Record<string, string> = {
        'change #extension-connect__ask-get': 'askGetChanged',
        'change .extension-connect__file-check': 'fileChecked'
    };

    config: ConnectConfig;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(model: any) {
        super(model);
        this.config = {
            askGet: this.model.askGet,
            allFiles: !!this.model.allFiles,
            files: (this.model.files as ConnectFile[])
                .filter((f) => f.checked)
                .map((f) => f.id)
        };
    }

    render(): this | undefined {
        super.render({
            ...this.model,
            ...this.config,
            files: (this.model.files as ConnectFile[]).map((f) => ({
                id: f.id,
                name: f.name,
                checked: this.config.files.includes(f.id)
            }))
        });
        return this;
    }

    fileChecked(e: Event): void {
        const target = e.target as HTMLInputElement;
        const fileId = target.dataset.file;
        const checked = target.checked;

        if (fileId === 'all') {
            this.config.allFiles = checked;
            this.config.files = (this.model.files as ConnectFile[]).map((f) => f.id);
        } else if (fileId) {
            if (checked) {
                this.config.files.push(fileId);
            } else {
                this.config.files = this.config.files.filter((f) => f !== fileId);
                this.config.allFiles = false;
            }
        }

        this.render();

        const atLeastOneFileSelected =
            this.config.files.length > 0 || this.config.allFiles;

        const allowButton = document.querySelector(
            '.modal button[data-result=yes]'
        ) as HTMLElement | null;
        allowButton?.classList.toggle('hide', !atLeastOneFileSelected);
    }

    askGetChanged(e: Event): void {
        this.config.askGet = (e.target as HTMLInputElement).value;
    }
}

export { ExtensionConnectView };
