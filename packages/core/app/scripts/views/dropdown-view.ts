import { Events } from 'framework/events';
import { View } from 'framework/views/view';
import { Keys } from 'const/keys';
import template from 'templates/dropdown.hbs';

interface DropdownModel {
    selectedOption?: number;
}

interface DropdownRenderConfig {
    options: unknown[];
    position: {
        left?: number;
        right?: number;
        top: number;
    };
    [key: string]: unknown;
}

class DropdownView extends View {
    parent = 'body';
    modal = 'dropdown';

    template = template;

    events: Record<string, string> = {
        'click .dropdown__item': 'itemClick'
    };

    selectedOption: number | undefined;

    constructor(model?: DropdownModel) {
        super(model);

        Events.emit('dropdown-shown');
        this.bodyClick = this.bodyClick.bind(this);

        this.listenTo(Events, 'show-context-menu', this.bodyClick);
        this.listenTo(Events, 'dropdown-shown', this.bodyClick);
        $('body').on('click contextmenu keydown', this.bodyClick);

        this.onKey(Keys.DOM_VK_UP, this.upPressed, undefined, 'dropdown');
        this.onKey(Keys.DOM_VK_DOWN, this.downPressed, undefined, 'dropdown');
        this.onKey(Keys.DOM_VK_RETURN, this.enterPressed, undefined, 'dropdown');
        this.onKey(Keys.DOM_VK_ESCAPE, this.escPressed, undefined, 'dropdown');

        this.once('remove', () => {
            $('body').off('click contextmenu keydown', this.bodyClick);
        });

        this.selectedOption = model?.selectedOption;
    }

    render(config?: DropdownRenderConfig): this | undefined {
        if (!config) {
            return this;
        }
        this.options = config;
        super.render(config);
        const ownRect = this.$el[0].getBoundingClientRect();
        const bodyRect = document.body.getBoundingClientRect();
        let left =
            config.position.left ??
            ((config.position.right ?? 0) - ownRect.right + ownRect.left);
        let top = config.position.top;
        if (left + ownRect.width > bodyRect.right) {
            left = Math.max(0, bodyRect.right - ownRect.width);
        }
        if (top + ownRect.height > bodyRect.bottom) {
            top = Math.max(0, bodyRect.bottom - ownRect.height);
        }
        this.$el.css({ top, left });
        if (typeof this.selectedOption === 'number') {
            this.renderSelectedOption();
        }
        return this;
    }

    bodyClick(e?: KeyboardEvent): void {
        if (
            e &&
            [Keys.DOM_VK_UP, Keys.DOM_VK_DOWN, Keys.DOM_VK_RETURN, Keys.DOM_VK_ESCAPE].includes(
                e.which
            )
        ) {
            return;
        }
        if (!this.removed) {
            this.emit('cancel');
        }
    }

    itemClick(e: MouseEvent): void {
        e.stopPropagation();
        const el = $(e.target as Element).closest('.dropdown__item');
        const selected = el.data('value');
        this.emit('select', { item: selected, el });
    }

    upPressed(e: KeyboardEvent): void {
        e.preventDefault();
        const options = this.options.options as unknown[];
        if (!this.selectedOption) {
            this.selectedOption = options.length - 1;
        } else {
            this.selectedOption--;
        }
        this.renderSelectedOption();
    }

    downPressed(e: KeyboardEvent): void {
        e.preventDefault();
        const options = this.options.options as unknown[];
        if (this.selectedOption === undefined || this.selectedOption === options.length - 1) {
            this.selectedOption = 0;
        } else {
            this.selectedOption++;
        }
        this.renderSelectedOption();
    }

    renderSelectedOption(): void {
        this.$el.find('.dropdown__item').removeClass('dropdown__item--active');
        this.$el
            .find(`.dropdown__item:nth(${this.selectedOption})`)
            .addClass('dropdown__item--active');
    }

    enterPressed(): void {
        if (!this.removed && this.selectedOption !== undefined) {
            const el = this.$el.find(`.dropdown__item:nth(${this.selectedOption})`);
            const selected = el.data('value');
            this.emit('select', { item: selected, el });
        }
    }

    escPressed(e: KeyboardEvent): void {
        e.stopImmediatePropagation();
        if (!this.removed) {
            this.emit('cancel');
        }
    }
}

export { DropdownView };
