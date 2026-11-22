import { Collection } from 'framework/collection';
import { SettingsStore } from 'comp/settings/settings-store';
import { FileInfoModel, type FileInfoProperties } from 'models/file-info-model';

class FileInfoCollection extends Collection<FileInfoModel> {
    static override model = FileInfoModel;

    load(): Promise<void> {
        return SettingsStore.load('file-info').then((data: unknown) => {
            if (Array.isArray(data)) {
                let migrated = false;
                for (const item of data as Array<Partial<FileInfoProperties>>) {
                    if (item?.keyFileHash) {
                        item.keyFileHash = null;
                        item.keyFileName ||= 'Key file';
                        migrated = true;
                    }
                    this.push(new FileInfoModel(item));
                }
                if (migrated) return SettingsStore.save('file-info', this);
            }
        });
    }

    save(): void {
        SettingsStore.save('file-info', this);
    }

    getMatch(
        storage: string | null | undefined,
        name: string | null | undefined,
        path: string | null | undefined
    ): FileInfoModel | undefined {
        return this.find((fi: FileInfoModel) => {
            return (
                (fi.storage || '') === (storage || '') &&
                (fi.name || '') === (name || '') &&
                (fi.path || '') === (path || '')
            );
        });
    }

    getByName(name: string): FileInfoModel | undefined {
        return this.find((file: FileInfoModel) => file.name.toLowerCase() === name.toLowerCase());
    }
}

const instance = new FileInfoCollection();

export { instance as FileInfoCollection };
