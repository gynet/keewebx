/* eslint-disable @typescript-eslint/no-explicit-any */
import { View } from 'framework/views/view';
import { Events } from 'framework/events';
import { Keys } from 'const/keys';
import { Scrollable } from 'framework/views/scrollable';
import { StringFormat } from 'util/formatting/string-format';
import template from 'templates/settings/settings.hbs';

class SettingsView extends View {
    parent = '.app__body';

    template = template;

    events: Record<string, string> = {
        'click .settings__back-button': 'returnToApp'
    };

    pageEl: any;
    file: any;
    page: any;

    initScroll!: () => void;
    createScroll!: (config: any) => void;
    pageResized!: () => void;

    constructor(model: any, options?: any) {
        super(model, options);
        this.initScroll();
        this.listenTo(Events, 'set-page', this.setPage);
        this.onKey(Keys.DOM_VK_ESCAPE, this.returnToApp);
    }

    render(): this | undefined {
        super.render();
        this.createScroll({
            root: this.$el.find('.settings')[0],
            scroller: this.$el.find('.scroller')[0],
            bar: this.$el.find('.scroller__bar')[0]
        });
        this.pageEl = this.$el.find('.scroller');
        return this;
    }

    setPage(e: any): void {
        const { page, section, file } = e;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const module = require('./settings-' + page + '-view');
        const viewName = StringFormat.pascalCase(page);
        const SettingsPageView = module[`Settings${viewName}View`];
        if (this.views.page) {
            (this.views.page as View).remove();
        }
        this.views.page = new SettingsPageView(file, { parent: this.pageEl[0] });
        (this.views.page as any).appModel = this.model;
        (this.views.page as View).render();
        this.file = file;
        this.page = page;
        this.pageResized();
        this.scrollToSection(section);
    }

    scrollToSection(section?: string): void {
        let scrollEl: HTMLElement | null = null;
        if (section) {
            scrollEl = (this.views.page as View).el.querySelector(`#${section}`);
        }
        if (!scrollEl) {
            scrollEl = (this.views.page as View).el.querySelector(`h1`);
        }
        if (scrollEl) {
            scrollEl.scrollIntoView(true);
        }
    }

    returnToApp(): void {
        Events.emit('toggle-settings', false);
    }
}

Object.assign(SettingsView.prototype, Scrollable);

export { SettingsView };
