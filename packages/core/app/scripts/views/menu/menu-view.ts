import { Events } from 'framework/events';
import { View } from 'framework/views/view';
import { KeyHandler } from 'comp/browser/key-handler';
import { Keys } from 'const/keys';
import { AppSettingsModel } from 'models/app-settings-model';
import { Resizable } from 'framework/views/resizable';
import { DragView } from 'views/drag-view';
import { MenuSectionView } from 'views/menu/menu-section-view';
import { throttle } from 'util/fn';
import template from 'templates/menu/menu.hbs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settings = AppSettingsModel as unknown as any;

class MenuView extends View {
    parent = '.app__menu';

    template = template;

    events: Record<string, string> = {};

    sectionViews: View[] = [];

    minWidth = 130;
    maxWidth = 300;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(model: any, options?: Record<string, unknown>) {
        super(model, options);
        this.listenTo(this.model, 'change:sections', this.menuChanged);
        this.listenTo(this, 'view-resize', this.viewResized);
        this.onKey(
            Keys.DOM_VK_UP,
            this.selectPreviousSection,
            KeyHandler.SHORTCUT_ACTION + KeyHandler.SHORTCUT_OPT
        );
        this.onKey(
            Keys.DOM_VK_DOWN,
            this.selectNextSection,
            KeyHandler.SHORTCUT_ACTION + KeyHandler.SHORTCUT_OPT
        );
        this.once('remove', () => {
            this.sectionViews.forEach((sectionView) => sectionView.remove());
            this.sectionViews = [];
        });
    }

    render(): this | undefined {
        super.render();
        const sectionsEl = this.$el.find('.menu');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.model.sections.forEach((section: any) => {
            const sectionView = new MenuSectionView(section, { parent: sectionsEl[0] });
            sectionView.render();
            if (section.drag) {
                const dragEl = $('<div/>')
                    .addClass('menu__drag-section')
                    .appendTo(sectionsEl);
                const dragView = new DragView('y', { parent: dragEl[0] });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (sectionView as any).listenDrag(dragView);
                dragView.render();
                this.sectionViews.push(dragView as unknown as View);
            }
            this.sectionViews.push(sectionView as unknown as View);
        });
        if (typeof settings.menuViewWidth === 'number') {
            this.$el.width(settings.menuViewWidth);
        }
        return this;
    }

    menuChanged(): void {
        this.render();
    }

    viewResized = throttle((size: number) => {
        settings.menuViewWidth = size;
    }, 1000);

    switchVisibility(visible: boolean): void {
        this.$el.toggleClass('menu-visible', visible);
    }

    selectPreviousSection(): void {
        Events.emit('select-previous-menu-item');
    }

    selectNextSection(): void {
        Events.emit('select-next-menu-item');
    }
}

Object.assign(MenuView.prototype, Resizable);

export { MenuView };
