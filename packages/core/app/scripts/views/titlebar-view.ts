import { View } from 'framework/views/view';
import { Events } from 'framework/events';
import { KeeWebLogo } from 'const/inline-images';
import template from 'templates/titlebar.hbs';

class TitlebarView extends View {
    parent = '.app__titlebar';

    template = template;

    events: Record<string, string> = {
        'click .titlebar__close': 'clickClose'
    };

    maximized = false;

    constructor() {
        super();

        this.maximized = false;

        this.listenTo(Events, 'app-maximized', this.appMaximized);
        this.listenTo(Events, 'app-unmaximized', this.appUnmaximized);
    }

    render(): this | undefined {
        super.render({
            maximized: this.maximized,
            iconSrc: KeeWebLogo
        });
        return this;
    }

    clickClose(): void {
        window.close();
    }

    appMaximized(): void {
        this.maximized = true;
        this.render();
    }

    appUnmaximized(): void {
        this.maximized = false;
        this.render();
    }
}

export { TitlebarView };
