import { View } from 'framework/views/view';
import { AppSettingsModel } from 'models/app-settings-model';
import { Resizable } from 'framework/views/resizable';
import { Scrollable } from 'framework/views/scrollable';
import { MenuItemView } from 'views/menu/menu-item-view';
import { throttle } from 'util/fn';
import template from 'templates/menu/menu-section.hbs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settings = AppSettingsModel as unknown as any;

class MenuSectionView extends View {
    template = template;

    events: Record<string, string> = {};

    itemViews: View[] = [];

    minHeight = 55;
    autoHeight = 'auto';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    itemsEl: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scroll: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createScroll!: (config: any) => void;
    initScroll!: () => void;
    pageResized!: () => void;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(model: any, options?: Record<string, unknown>) {
        super(model, options);
        this.listenTo(this.model, 'change-items', this.itemsChanged);
        this.listenTo(this.model, 'change:visible', this.visibilityChanged);
        this.listenTo(this, 'view-resize', this.viewResized);
        this.once('remove', () => {
            if (this.scroll) {
                this.scroll.dispose();
            }
            this.removeInnerViews();
        });
    }

    render(): this | undefined {
        if (!this.itemsEl) {
            super.render(this.model);
            this.itemsEl = this.model.scrollable ? this.$el.find('.scroller') : this.$el;
            if (this.model.scrollable) {
                this.initScroll();
                this.createScroll({
                    root: this.$el[0],
                    scroller: this.$el.find('.scroller')[0],
                    bar: this.$el.find('.scroller__bar')[0]
                });
            }
        } else {
            this.removeInnerViews();
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.model.items.forEach((item: any) => {
            const itemView = new MenuItemView(item, { parent: this.itemsEl[0] });
            itemView.render();
            this.itemViews.push(itemView as unknown as View);
        });
        if (this.model.drag) {
            const height = settings.tagsViewHeight;
            if (typeof height === 'number') {
                this.$el.height();
                this.$el.css('flex', '0 0 ' + height + 'px');
            }
        }
        // Honor section-level visibility. Used for the static "File" settings
        // entry (#17) which is hidden until a database is open.
        if (this.model.visible === false) {
            this.$el.hide();
        } else {
            this.$el.show();
        }
        this.pageResized();
        return this;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    visibilityChanged(_model: any, visible: boolean | undefined): void {
        if (visible === false) {
            this.$el.hide();
        } else {
            this.$el.show();
        }
    }

    maxHeight(): number {
        return this.$el.parent().height() - 116;
    }

    removeInnerViews(): void {
        this.itemViews.forEach((itemView) => itemView.remove());
        this.itemViews = [];
    }

    itemsChanged(): void {
        this.render();
    }

    viewResized(size: number): void {
        this.$el.css('flex', '0 0 ' + (size ? size + 'px' : 'auto'));
        this.saveViewHeight(size);
    }

    saveViewHeight = throttle((size: number) => {
        settings.tagsViewHeight = size;
    }, 1000);
}

Object.assign(MenuSectionView.prototype, Resizable);
Object.assign(MenuSectionView.prototype, Scrollable);

export { MenuSectionView };
