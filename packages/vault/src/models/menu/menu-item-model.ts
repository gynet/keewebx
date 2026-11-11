import { Model } from 'framework/model';
import { MenuOptionCollection } from 'collections/menu/menu-option-collection';
import { MenuOptionModel } from 'models/menu/menu-option-model';

interface MenuItemProperties {
    id: string;
    title: string;
    locTitle: string;
    icon: string;
    customIcon: string | null;
    active: boolean;
    expanded: boolean;
    items: unknown[] | null;
    shortcut: number | null;
    options: MenuOptionCollection | null;
    cls: string | null;
    iconCls: string | null;
    iconStyle: string | null;
    itemStyle: string | null;
    disabled: boolean | Record<string, string>;
    visible: boolean;
    drag: boolean;
    drop: boolean;
    filterKey: string | null;
    filterValue: string | boolean | null;
    collapsible: boolean;
    defaultItem: boolean;
    page: string | null;
    editable: boolean;
    file: unknown | null;
    section: string | null;
}

class MenuItemModel extends Model {
    declare id: string;
    declare title: string;
    declare locTitle: string;
    declare icon: string;
    declare customIcon: string | null;
    declare active: boolean;
    declare expanded: boolean;
    declare items: unknown[] | null;
    declare shortcut: number | null;
    declare options: MenuOptionCollection | null;
    declare cls: string | null;
    declare iconCls: string | null;
    declare iconStyle: string | null;
    declare disabled: boolean | Record<string, string>;
    declare visible: boolean;
    declare drag: boolean;
    declare drop: boolean;
    declare filterKey: string | null;
    declare filterValue: string | boolean | null;
    declare collapsible: boolean;
    declare defaultItem: boolean;
    declare page: string | null;
    declare editable: boolean;
    declare file: unknown | null;
    declare section: string | null;

    constructor(model?: Record<string, unknown>) {
        super(model);
        if (model && model.file) {
            (model.file as Model).on('change:name', this.changeTitle.bind(this));
        }
    }

    addItem(item: unknown): void {
        (this.items as unknown[]).push(item);
    }

    addOption(option: Record<string, unknown>): void {
        if (!this.options) {
            this.options = new MenuOptionCollection();
        }
        this.options.push(new MenuOptionModel(option));
    }

    toggleExpanded(): void {
        const items = this.items;
        let expanded = !this.expanded;
        if (!items || !items.length) {
            expanded = true;
        }
        this.expanded = expanded;
    }

    changeTitle(_model: unknown, newTitle: string): void {
        this.title = newTitle;
    }
}

MenuItemModel.defineModelProperties({
    id: '',
    title: '',
    locTitle: '',
    icon: '',
    customIcon: null,
    active: false,
    expanded: true,
    items: null,
    shortcut: null,
    options: null,
    cls: null,
    iconCls: null,
    iconStyle: null,
    itemStyle: null,
    disabled: false,
    visible: true,
    drag: false,
    drop: false,
    filterKey: null,
    filterValue: null,
    collapsible: false,
    defaultItem: false,
    page: null,
    editable: false,
    file: null,
    section: null
});

export { MenuItemModel };
export type { MenuItemProperties };
