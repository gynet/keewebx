import { Collection } from 'framework/collection';
import { Model } from 'framework/model';
import type { FileModel } from 'models/file-model';

// Runtime: checkType validates each pushed value via `static model`
// (the base Model class here, because FileCollection historically
// accepted any Model subclass in upstream KeeWeb). Type-wise we narrow
// to FileModel since every caller treats the collection's elements as
// such (accessing .active, .modified, .name, etc). instanceof Model
// succeeds for FileModel instances so the runtime check still passes.
class FileCollection extends Collection<FileModel> {
    static override model = Model;

    hasOpenFiles(): boolean {
        return this.some((file) => file.active);
    }

    hasUnsavedFiles(): boolean {
        return this.some((file) => file.modified);
    }

    hasDirtyFiles(): boolean {
        return this.some((file) => file.dirty);
    }

    getByName(name: string): FileModel | undefined {
        return this.find((file) => file.name.toLowerCase() === name.toLowerCase());
    }
}

export { FileCollection };
