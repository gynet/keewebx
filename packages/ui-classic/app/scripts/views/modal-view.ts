import { View } from 'framework/views/view';
import { Keys } from 'const/keys';
import template from 'templates/modal.hbs';

class ModalView extends View {
    parent = 'body';
    modal = 'alert';

    template = template;

    events: Record<string, string> = {
        'click .modal__buttons button': 'buttonClick',
        'click .modal__link': 'linkClick',
        'click': 'bodyClick'
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(model: any) {
        super(model);
        if (typeof this.model.esc === 'string') {
            this.onKey(Keys.DOM_VK_ESCAPE, this.escPressed, undefined, 'alert');
        }
        if (typeof this.model.enter === 'string') {
            this.onKey(Keys.DOM_VK_RETURN, this.enterPressed, undefined, 'alert');
        }
        this.once('remove', () => {
            if (this.model.view) {
                this.model.view.remove();
            }
        });
    }

    render(): this | undefined {
        super.render({
            ...this.model,
            body: this.model.body ? this.model.body.toString().split('\n') : ''
        });
        this.$el.addClass('modal--hidden');
        setTimeout(() => {
            this.$el.removeClass('modal--hidden');
            (document.activeElement as HTMLElement | null)?.blur();
        }, 20);
        if (this.model.view) {
            this.model.view.parent = this.el.querySelector('.modal__body');
            this.model.view.render();
        }
        return this;
    }

    change(config: { header?: string }): void {
        if (config.header) {
            this.$el.find('.modal__header').text(config.header);
        }
    }

    buttonClick(e: Event): void {
        const result = $(e.target as Element).data('result');
        this.closeWithResult(result);
    }

    linkClick(_e: Event): void {
        // Links open normally in the browser
    }

    bodyClick(e: Event): void {
        const target = e.target as Element | null;
        if (typeof this.model.click === 'string' && target && !target.matches('button')) {
            this.closeWithResult(this.model.click);
        }
    }

    escPressed(): void {
        this.closeWithResult(this.model.esc);
    }

    enterPressed(e: Event): void {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.closeWithResult(this.model.enter);
    }

    closeWithResult(result: unknown): void {
        const checked = this.model.checkbox
            ? this.$el.find('#modal__check').is(':checked')
            : undefined;
        this.emit('will-close');
        this.emit('result', result, checked);
        this.removeView();
    }

    closeWithoutResult(): void {
        this.emit('will-close');
        this.removeView();
    }

    removeView(): void {
        this.$el.addClass('modal--hidden');
        this.unbindEvents();
        setTimeout(() => this.remove(), 100);
    }

    closeImmediate(): void {
        this.emit('will-close');
        this.emit('result', undefined);
        this.unbindEvents();
        this.remove();
    }
}

export { ModalView };
