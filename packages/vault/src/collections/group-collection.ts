import { Collection } from 'framework/collection';
import { GroupModel } from 'models/group-model';

class GroupCollection extends Collection<GroupModel> {
    static override model = GroupModel;
}

export { GroupCollection };
