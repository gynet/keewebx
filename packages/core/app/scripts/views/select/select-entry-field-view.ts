/* eslint-disable @typescript-eslint/no-explicit-any */
import { View } from 'framework/views/view';
import { Events } from 'framework/events';
import { Keys } from 'const/keys';
import { Scrollable } from 'framework/views/scrollable';
import template from 'templates/select/select-entry-field.hbs';
import { PasswordPresenter } from 'util/formatting/password-presenter';

interface SelectEntryFieldEntry {
    field: string;
    value: any;
}

class SelectEntryFieldView extends View {
    parent = 'body';
    modal = 'select-entry-field';

    template = template;

    events: Record<string, string> = {
        'click .select-entry-field__item': 'itemClicked',
        'click .select-entry-field__cancel-btn': 'cancelClicked'
    };

    result: any = null;

    fields: SelectEntryFieldEntry[];
    activeField: string | undefined;

    initScroll!: () => void;
    createScroll!: (config: any) => void;

    constructor(model: any) {
        super(model);

        this.fields = this.model.entry ? this.getFields(this.model.entry) : [];
        this.activeField = this.fields[0]?.field;

        this.initScroll();
        this.listenTo(Events, 'main-window-blur', this.mainWindowBlur);
        this.setupKeys();
    }

    setupKeys(): void {
        this.onKey(Keys.DOM_VK_UP, this.upPressed, undefined, 'select-entry-field');
        this.onKey(Keys.DOM_VK_DOWN, this.downPressed, undefined, 'select-entry-field');
        this.onKey(Keys.DOM_VK_ESCAPE, this.escPressed, undefined, 'select-entry-field');
        this.onKey(Keys.DOM_VK_RETURN, this.enterPressed, undefined, 'select-entry-field');
    }

    render(): this | undefined {
        super.render({
            needsTouch: this.model.needsTouch,
            deviceShortName: this.model.deviceShortName,
            fields: this.fields,
            activeField: this.activeField
        });

        (document.activeElement as HTMLElement | null)?.blur();

        const scrollRoot = this.el.querySelector('.select-entry-field__items');
        if (scrollRoot) {
            this.createScroll({
                root: scrollRoot,
                scroller: this.el.querySelector('.scroller'),
                bar: this.el.querySelector('.scroller__bar')
            });
        }
        return this;
    }

    getFields(entry: any): SelectEntryFieldEntry[] {
        return Object.entries(entry.getAllFields() as Record<string, any>)
            .map(([field, value]) => ({
                field,
                value
            }))
            .filter(({ value }) => value)
            .map(({ field, value }) => ({
                field,
                value: value.isProtected ? PasswordPresenter.present(value.length) : value
            }));
    }

    upPressed(e: Event): void {
        e.preventDefault();
        if (!this.activeField) {
            return;
        }

        const activeIndex = this.fields.findIndex((f) => f.field === this.activeField) - 1;
        if (activeIndex >= 0) {
            this.activeField = this.fields[activeIndex].field;
            this.render();
        }
    }

    downPressed(e: Event): void {
        e.preventDefault();
        if (!this.activeField) {
            return;
        }

        const activeIndex = this.fields.findIndex((f) => f.field === this.activeField) + 1;
        if (activeIndex < this.fields.length) {
            this.activeField = this.fields[activeIndex].field;
            this.render();
        }
    }

    escPressed(): void {
        this.emit('result', undefined);
    }

    enterPressed(): void {
        if (!this.activeField) {
            return;
        }

        this.emit('result', this.activeField);
    }

    itemClicked(e: Event): void {
        const target = e.target as HTMLElement;
        const item = target.closest('.select-entry-field__item') as HTMLElement | null;
        if (!item) return;
        this.activeField = item.dataset.field;

        this.emit('result', this.activeField);
    }

    mainWindowBlur(): void {
        this.emit('result', undefined);
    }

    showAndGetResult(): Promise<any> {
        this.render();
        return new Promise((resolve) => {
            this.once('result', (result: any) => {
                this.remove();
                resolve(result);
            });
        });
    }

    cancelClicked(): void {
        this.emit('result', undefined);
    }
}

Object.assign(SelectEntryFieldView.prototype, Scrollable);

export { SelectEntryFieldView };
