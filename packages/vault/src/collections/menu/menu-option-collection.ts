import { Collection } from 'framework/collection';
import { MenuOptionModel } from 'models/menu/menu-option-model';

class MenuOptionCollection extends Collection<MenuOptionModel> {
    static override model = MenuOptionModel;
}

export { MenuOptionCollection };
