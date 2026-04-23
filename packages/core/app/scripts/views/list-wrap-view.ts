import { View } from 'framework/views/view';

class ListWrapView extends View {
    parent = '.app__list-wrap';

    template = (): string => '';

    events: Record<string, string> = {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(model: any, options?: Record<string, unknown>) {
        super(model, options);
        this.listenTo(this.model.settings, 'change:tableView', this.setListLayout);
    }

    render(): this | undefined {
        super.render();
        this.setListLayout();
        return this;
    }

    setListLayout(): void {
        const tableView = !!this.model.settings.tableView;
        this.el.classList.toggle('app__list-wrap--table', tableView);
    }
}

export { ListWrapView };
