import { describe, test, expect, mock } from 'bun:test';

// Mock framework dependencies
const modelDefaults = new Map<Function, Record<string, unknown>>();
mock.module('../../app/scripts/framework/model', () => {
    class Model {
        constructor(data?: Record<string, unknown>) {
            const defaults = modelDefaults.get(new.target);
            if (defaults) Object.assign(this, defaults);
            if (data) Object.assign(this, data);
        }
        set(props: Record<string, unknown>, _opts?: { silent?: boolean }) {
            Object.assign(this, props);
        }
        on(_event: string, _cb: Function) {}
        once(_event: string, _cb: Function) {}
        off(_event: string, _cb: Function) {}
        emit(_event: string, ..._args: unknown[]) {}
        static defineModelProperties(props: Record<string, unknown>, _opts?: Record<string, unknown>) {
            modelDefaults.set(this, { ...props });
        }
    }
    return { Model };
});

mock.module('../../app/scripts/collections/menu/menu-option-collection', () => {
    class MenuOptionCollection extends Array {
        remove(item: unknown) {
            const ix = this.indexOf(item);
            if (ix >= 0) this.splice(ix, 1);
        }
    }
    return { MenuOptionCollection };
});

mock.module('../../app/scripts/collections/menu/menu-item-collection', () => {
    class MenuItemCollection extends Array {
        constructor(items?: unknown[]) {
            super();
            if (items) this.push(...items);
        }
        remove(item: unknown) {
            const ix = this.indexOf(item);
            if (ix >= 0) this.splice(ix, 1);
        }
    }
    return { MenuItemCollection };
});

const { MenuOptionModel } = await import('../../app/scripts/models/menu/menu-option-model');
const { MenuItemModel } = await import('../../app/scripts/models/menu/menu-item-model');
const { MenuSectionModel } = await import('../../app/scripts/models/menu/menu-section-model');

describe('MenuOptionModel', () => {
    test('creates with default properties', () => {
        const opt = new MenuOptionModel();
        expect(opt.title).toBe('');
        expect(opt.cls).toBe('');
        expect(opt.value).toBe('');
        expect(opt.active).toBe(false);
        expect(opt.filterValue).toBeNull();
    });

    test('creates with custom properties', () => {
        const opt = new MenuOptionModel({ title: 'Red', cls: 'fa red', value: 'red', active: true, filterValue: 'red' });
        expect(opt.title).toBe('Red');
        expect(opt.cls).toBe('fa red');
        expect(opt.value).toBe('red');
        expect(opt.active).toBe(true);
        expect(opt.filterValue).toBe('red');
    });
});

describe('MenuItemModel', () => {
    test('creates with default properties', () => {
        const item = new MenuItemModel();
        expect(item.id).toBe('');
        expect(item.title).toBe('');
        expect(item.active).toBe(false);
        expect(item.expanded).toBe(true);
        expect(item.visible).toBe(true);
        expect(item.drag).toBe(false);
        expect(item.drop).toBe(false);
        expect(item.editable).toBe(false);
    });

    test('creates with custom properties', () => {
        const item = new MenuItemModel({
            title: 'All Items',
            icon: 'th-large',
            active: true,
            filterKey: '*'
        });
        expect(item.title).toBe('All Items');
        expect(item.icon).toBe('th-large');
        expect(item.active).toBe(true);
        expect(item.filterKey).toBe('*');
    });

    test('addOption creates options collection', () => {
        const item = new MenuItemModel();
        item.options = null;
        item.addOption({ cls: 'fa red', value: 'red', filterValue: 'red' });
        expect(item.options).toBeTruthy();
        expect(item.options!.length).toBe(1);
        expect(item.options![0].value).toBe('red');
    });

    test('toggleExpanded toggles state', () => {
        const item = new MenuItemModel({ expanded: true, items: [{}] });
        item.toggleExpanded();
        expect(item.expanded).toBe(false);
        item.toggleExpanded();
        expect(item.expanded).toBe(true);
    });

    test('toggleExpanded stays true when no items', () => {
        const item = new MenuItemModel({ expanded: false, items: [] });
        item.toggleExpanded();
        expect(item.expanded).toBe(true);
    });

    test('changeTitle updates title', () => {
        const item = new MenuItemModel({ title: 'Old' });
        item.changeTitle(null, 'New');
        expect(item.title).toBe('New');
    });
});

describe('MenuSectionModel', () => {
    test('creates with empty items', () => {
        const section = new MenuSectionModel();
        expect(section.items).toBeTruthy();
        expect(section.items.length).toBe(0);
        expect(section.scrollable).toBe(false);
        expect(section.grow).toBe(false);
    });

    test('creates with initial items', () => {
        const section = new MenuSectionModel([
            { title: 'Item 1', icon: 'star' },
            { title: 'Item 2', icon: 'folder' }
        ]);
        expect(section.items.length).toBe(2);
        expect((section.items[0] as MenuItemModel).title).toBe('Item 1');
        expect((section.items[1] as MenuItemModel).title).toBe('Item 2');
    });

    test('addItem adds converted item', () => {
        const section = new MenuSectionModel();
        section.addItem({ title: 'New Item' });
        expect(section.items.length).toBe(1);
    });

    test('setItems replaces all items', () => {
        const section = new MenuSectionModel([{ title: 'Old' }]);
        section.setItems([{ title: 'New 1' }, { title: 'New 2' }]);
        expect(section.items.length).toBe(2);
        expect((section.items[0] as MenuItemModel).title).toBe('New 1');
    });

    test('removeAllItems clears and restores defaults', () => {
        const section = new MenuSectionModel([{ title: 'Item 1' }]);
        section.defaultItems = [{ title: 'Default', icon: 'star' }];
        section.removeAllItems();
        expect(section.items.length).toBe(1);
        expect((section.items[0] as MenuItemModel).title).toBe('Default');
    });
});
