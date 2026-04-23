import { View } from 'framework/views/view';
import { Keys } from 'const/keys';
import { Locale } from 'util/locale';
import template from 'templates/open-config.hbs';

interface OpenConfigField {
    id: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loc = Locale as unknown as Record<string, any>;

class OpenConfigView extends View {
    template = template;

    events: Record<string, string> = {
        'click .open__config-btn-cancel': 'cancel',
        'click .open__config-btn-ok': 'apply',
        'input input': 'changeInput',
        'keyup input': 'keyup'
    };

    render(): this | undefined {
        super.render(this.model);
        this.$el.find(':input:first').focus();
        this.checkValidity();
        return this;
    }

    cancel(): void {
        this.emit('cancel');
    }

    apply(): void {
        const data = this.getData();
        if (data) {
            this.emit('apply', data);
        }
    }

    changeInput(): void {
        this.checkValidity();
    }

    keyup(e: KeyboardEvent): void {
        if ((e as unknown as { which: number }).which === Keys.DOM_VK_RETURN) {
            this.apply();
        }
    }

    checkValidity(): void {
        const isValid = this.getData();
        this.$el.find('.open__config-btn-ok').prop('disabled', !isValid);
    }

    getData(): Record<string, string> | null {
        let data: Record<string, string> | null = { storage: this.model.id };
        const fields: OpenConfigField[] = this.model.fields;
        for (const field of fields) {
            const input = this.$el.find('#open__config-field-' + field.id)[0] as
                | HTMLInputElement
                | undefined;
            if (data && input && input.checkValidity()) {
                data[field.id] = input.value;
            } else {
                data = null;
                break;
            }
        }
        return data;
    }

    setDisabled(disabled?: boolean): void {
        disabled = !!disabled;
        this.$el.find(':input:not(.open__config-btn-cancel)').prop('disabled', disabled);
        this.$el.toggleClass('open__config--disabled', disabled);
        if (disabled) {
            this.$el.find('.open__config-error').text('');
        }
    }

    setError(err: { notFound?: boolean } | string | undefined): void {
        const notFound = typeof err === 'object' && err && err.notFound;
        const errText = notFound
            ? (loc.openConfigErrorNotFound as string)
            : (loc.openConfigError as string).replace('{}', String(err));
        this.$el.find('.open__config-error').text(errText);
    }
}

export { OpenConfigView };
