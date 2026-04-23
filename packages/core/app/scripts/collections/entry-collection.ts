import { Collection } from 'framework/collection';
import { EntryModel } from 'models/entry-model';

class EntryCollection extends Collection<EntryModel> {
    static override model = EntryModel;
}

export { EntryCollection };
