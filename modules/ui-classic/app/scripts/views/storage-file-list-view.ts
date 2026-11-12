import { View } from 'framework/views/view';
import { UrlFormat } from 'util/formatting/url-format';
import template from 'templates/storage-file-list.hbs';

interface StorageFile {
    path: string;
    name: string;
    dir?: boolean;
}

interface StorageFileRenderEntry {
    path: string;
    name: string;
    kdbx: boolean;
    dir?: boolean;
}

class StorageFileListView extends View {
    template = template;

    events: Record<string, string> = {
        'click .open-list__file': 'fileClick',
        'click .open-list__check-wrap': 'showAllCheckClick',
        'change #open-list__check': 'showAllCheckChange'
    };

    allStorageFiles: Record<string, StorageFile> = {};
    showHiddenFiles = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(model: any) {
        super(model);
        this.allStorageFiles = {};
        this.showHiddenFiles = false;
    }

    render(): this | undefined {
        let files: StorageFileRenderEntry[] = this.model.files.map((file: StorageFile) => {
            this.allStorageFiles[file.path] = file;
            return {
                path: file.path,
                name: file.name.replace(/\.kdbx$/i, ''),
                kdbx: UrlFormat.isKdbx(file.name),
                dir: file.dir
            };
        });
        const visibleFiles = files.filter((f) => f.dir || f.kdbx);
        const canShowHiddenFiles =
            visibleFiles.length > 0 && files.length > visibleFiles.length;
        if (!this.showHiddenFiles) {
            if (visibleFiles.length > 0) {
                files = visibleFiles;
            }
        }
        const density = files.length > 14 ? 3 : files.length > 7 ? 2 : 1;
        super.render({
            files,
            density,
            showHiddenFiles: this.showHiddenFiles,
            canShowHiddenFiles
        });
        return this;
    }

    fileClick(e: Event): void {
        const result = $(e.target as Element).closest('.open-list__file').data('path');
        const file = this.allStorageFiles[result];
        this.emit('selected', file);
    }

    showAllCheckClick(e: Event): void {
        e.stopPropagation();
    }

    showAllCheckChange(e: Event): void {
        this.showHiddenFiles = (e.target as HTMLInputElement).checked;
        this.render();
    }
}

export { StorageFileListView };
