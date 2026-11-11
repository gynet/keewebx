import { Collection } from 'framework/collection';
import { MenuItemModel } from 'models/menu/menu-item-model';

class MenuItemCollection extends Collection<MenuItemModel> {
    static override model = MenuItemModel;
}

export { MenuItemCollection };
