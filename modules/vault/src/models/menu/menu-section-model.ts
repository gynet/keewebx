import { Model } from 'framework/model';
import { MenuItemCollection } from 'collections/menu/menu-item-collection';
import { MenuItemModel } from './menu-item-model';

function convertItem(item: MenuItemModel | Record<string, unknown>): MenuItemModel {
    return item instanceof MenuItemModel ? item : new MenuItemModel(item);
}

interface MenuSectionProperties {
    defaultItems: Record<string, unknown>[] | null;
    items: MenuItemCollection | null;
    scrollable: boolean;
    grow: boolean;
    drag: boolean;
    visible: boolean | undefined;
    active: boolean;
}

class MenuSectionModel extends Model {
    declare defaultItems: Record<string, unknown>[] | null;
    declare items: MenuItemCollection;
    declare scrollable: boolean;
    declare grow: boolean;
    declare drag: boolean;
    declare visible: boolean | undefined;
    declare active: boolean;

    constructor(items: Array<MenuItemModel | Record<string, unknown>> = []) {
        super({ items: new MenuItemCollection(items.map(convertItem)) });
    }

    addItem(item: MenuItemModel | Record<string, unknown>): void {
        this.items.push(convertItem(item));
        this.emit('change-items');
    }

    removeAllItems(): void {
        this.items.length = 0;
        if (this.defaultItems) {
            this.items.push(
                ...this.defaultItems.map((item) => new MenuItemModel(item))
            );
        }
        this.emit('change-items');
    }

    removeByFile(file: unknown): void {
        const items = this.items;
        items.find((item: MenuItemModel) => {
            if (item.file === file) {
                items.remove(item);
                return true;
            }
            return false;
        });
        this.emit('change-items');
    }

    replaceByFile(file: unknown, newItem: MenuItemModel): void {
        const items = this.items;
        items.find((item: MenuItemModel, ix: number) => {
            if (item.file === file) {
                items[ix] = newItem;
                return true;
            }
            return false;
        });
        this.emit('change-items');
    }

    setItems(items: Array<MenuItemModel | Record<string, unknown>>): void {
        this.items.length = 0;
        this.items.push(...items.map(convertItem));
        this.emit('change-items');
    }
}

MenuSectionModel.defineModelProperties({
    defaultItems: null,
    items: null,
    scrollable: false,
    grow: false,
    drag: false,
    visible: undefined,
    active: false
});

export { MenuSectionModel };
export type { MenuSectionProperties };
