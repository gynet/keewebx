import { Events } from 'framework/events';
import { View } from 'framework/views/view';
import { DragDropInfo } from 'comp/app/drag-drop-info';
import { KeyHandler } from 'comp/browser/key-handler';
import { Alerts } from 'comp/ui/alerts';
import { Keys } from 'const/keys';
import { Locale } from 'util/locale';
import template from 'templates/menu/menu-item.hbs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loc = Locale as unknown as Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const alerts = Alerts as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dragDropInfo = DragDropInfo as unknown as { dragObject: any };

interface MenuOption {
    value: unknown;
}

class MenuItemView extends View {
    template = template;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    iconEl: any = null;
    itemViews: View[] = [];

    events: Record<string, string> = {
        'mouseover': 'mouseover',
        'mouseout': 'mouseout',
        'click .menu__item-option': 'selectOption',
        'click': 'selectItem',
        'dblclick': 'expandItem',
        'click .menu__item-edit': 'editItem',
        'click .menu__item-empty-trash': 'emptyTrash',
        'dragstart': 'dragstart',
        'dragover': 'dragover',
        'dragleave': 'dragleave',
        'drop': 'drop',
        'dragover .menu__item-drag-top': 'dragoverTop',
        'dragleave .menu__item-drag-top': 'dragleaveTop'
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(model: any, options?: Record<string, unknown>) {
        super(model, options);
        this.listenTo(this.model, 'change:title', this.changeTitle);
        this.listenTo(this.model, 'change:icon', this.changeIcon);
        this.listenTo(this.model, 'change:customIconId', this.render);
        this.listenTo(this.model, 'change:active', this.changeActive);
        this.listenTo(this.model, 'change:expanded', this.changeExpanded);
        this.listenTo(this.model, 'change:cls', this.changeCls);
        this.listenTo(this.model, 'change:iconCls', this.changeIconCls);
        this.listenTo(this.model, 'delete', this.remove);
        this.listenTo(this.model, 'insert', this.insertItem);
        const shortcut = this.model.shortcut;
        if (shortcut) {
            this.onKey(shortcut, this.selectItem, KeyHandler.SHORTCUT_OPT);
            if (shortcut !== Keys.DOM_VK_C) {
                this.onKey(shortcut, this.selectItem, KeyHandler.SHORTCUT_ACTION);
            }
        }
        this.once('remove', () => {
            this.removeInnerViews();
        });
    }

    render(): this | undefined {
        this.removeInnerViews();
        super.render(this.model);
        if (this.model.options) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).model = this.model;
        }
        this.iconEl = this.$el.find('.menu__item-icon');
        const items = this.model.items;
        if (items) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            items.forEach((item: any) => {
                if (item.visible) {
                    this.insertItem(item);
                }
            });
        }
        this.$el.toggleClass('menu__item--collapsed', !this.model.expanded);
        return this;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insertItem(item: any): void {
        const itemView = new MenuItemView(item, { parent: this.el });
        itemView.render();
        this.itemViews.push(itemView as unknown as View);
    }

    removeInnerViews(): void {
        this.itemViews.forEach((itemView) => itemView.remove());
        this.itemViews = [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changeTitle(_model: any, title: string): void {
        this.$el
            .find('.menu__item-title')
            .first()
            .text(title || '(no title)');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changeIcon(_model: any, icon: string | undefined): void {
        this.iconEl[0].className =
            'menu__item-icon fa ' + (icon ? 'fa-' + icon : 'menu__item-icon--no-icon');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changeActive(_model: any, active: boolean): void {
        this.$el.toggleClass('menu__item--active', active);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changeExpanded(_model: any, expanded: boolean): void {
        this.$el.toggleClass('menu__item--collapsed', !expanded);
        this.model.setExpanded(expanded);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changeCls(_model: any, cls: string, oldCls?: string): void {
        if (oldCls) {
            this.$el.removeClass(oldCls);
        }
        this.$el.addClass(cls);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changeIconCls(_model: any, cls?: string, oldCls?: string): void {
        const iconEl = this.el.querySelector('.menu__item-icon');
        if (!iconEl) return;
        if (oldCls) {
            iconEl.classList.remove(oldCls);
        }
        if (cls) {
            iconEl.classList.add(cls);
        }
    }

    mouseover(e: MouseEvent): void {
        if (!e.button) {
            this.$el.addClass('menu__item--hover');
            e.stopPropagation();
        }
    }

    mouseout(e: MouseEvent): void {
        this.$el.removeClass('menu__item--hover');
        e.stopPropagation();
    }

    selectItem(e: Event): void {
        e.stopPropagation();
        e.preventDefault();
        if (this.model.active) {
            return;
        }
        if (this.model.disabled) {
            alerts.info(this.model.disabled);
        } else {
            Events.emit('menu-select', { item: this.model });
        }
    }

    selectOption(e: Event): void {
        const options = this.model.options as MenuOption[] | undefined;
        const value = $(e.target as Element).data('value');
        if (options && options.length) {
            const option = options.find((op) => op.value === value);
            if (option) {
                Events.emit('menu-select', { item: this.model, option });
            }
        }
        e.stopImmediatePropagation();
        e.preventDefault();
    }

    expandItem(e: Event): void {
        if (this.model.toggleExpanded) {
            this.model.toggleExpanded();
        }
        e.stopPropagation();
    }

    editItem(e: Event): void {
        if (this.model.active && this.model.editable) {
            e.stopPropagation();
            switch (this.model.filterKey) {
                case 'tag':
                    Events.emit('edit-tag', this.model);
                    break;
                case 'group':
                    Events.emit('edit-group', this.model);
                    break;
            }
        }
    }

    emptyTrash(e: Event): void {
        e.stopPropagation();
        alerts.yesno({
            header: loc.menuEmptyTrashAlert,
            body: loc.menuEmptyTrashAlertBody,
            icon: 'minus-circle',
            success() {
                Events.emit('empty-trash');
            }
        });
    }

    dropAllowed(e: DragEvent): boolean {
        const types = e.dataTransfer?.types ?? [];
        for (let i = 0; i < types.length; i++) {
            if (types[i] === 'text/group' || types[i] === 'text/entry') {
                return !!(
                    dragDropInfo.dragObject && !dragDropInfo.dragObject.readOnly
                );
            }
        }
        return false;
    }

    dragstart(e: DragEvent): void {
        e.stopPropagation();
        if (this.model.drag) {
            e.dataTransfer?.setData('text/group', this.model.id);
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
            }
            dragDropInfo.dragObject = this.model;
        }
    }

    dragover(e: DragEvent): void {
        if (this.model.drop && this.dropAllowed(e)) {
            e.stopPropagation();
            e.preventDefault();
            this.$el.addClass('menu__item--drag');
        }
    }

    dragleave(e: DragEvent): void {
        e.stopPropagation();
        if (this.model.drop && this.dropAllowed(e)) {
            this.$el.removeClass('menu__item--drag menu__item--drag-top');
        }
    }

    drop(e: DragEvent): void {
        e.stopPropagation();
        if (this.model.drop && this.dropAllowed(e)) {
            const isTop = this.$el.hasClass('menu__item--drag-top');
            this.$el.removeClass('menu__item--drag menu__item--drag-top');
            if (isTop) {
                this.model.moveToTop(dragDropInfo.dragObject);
            } else {
                if (this.model.filterKey === 'trash') {
                    dragDropInfo.dragObject.moveToTrash();
                } else {
                    this.model.moveHere(dragDropInfo.dragObject);
                }
            }
            Events.emit('refresh');
        }
    }

    dropTopAllowed(e: DragEvent): boolean {
        const types = e.dataTransfer?.types ?? [];
        for (let i = 0; i < types.length; i++) {
            if (types[i] === 'text/group') {
                return true;
            }
        }
        return false;
    }

    dragoverTop(e: DragEvent): void {
        if (this.dropTopAllowed(e)) {
            this.$el.addClass('menu__item--drag-top');
        }
    }

    dragleaveTop(e: DragEvent): void {
        if (this.dropTopAllowed(e)) {
            this.$el.removeClass('menu__item--drag-top');
        }
    }
}

export { MenuItemView };
