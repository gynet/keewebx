import { FieldView } from 'views/fields/field-view';
import { escape } from 'util/fn';

interface SelectOption {
    id: string;
    value: string;
    selected?: boolean;
}

class FieldViewSelect extends FieldView {
    readonly = true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any;

    renderValue(value: SelectOption[]): string {
        return (
            '<select>' +
            value
                .map((opt) => {
                    return (
                        '<option ' +
                        'value="' +
                        escape(opt.id) +
                        '" ' +
                        (opt.selected ? 'selected ' : '') +
                        '>' +
                        escape(opt.value) +
                        '</option>'
                    );
                })
                .join('') +
            '</select>'
        );
    }

    render(): this | undefined {
        super.render();
        this.valueEl.addClass('details__field-value--select');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.valueEl.find('select:first').change((e: any) => {
            this.triggerChange({ val: e.target.value, field: this.model.name });
        });
        return this;
    }

    fieldLabelClick(): void {
        // no-op; select handles its own interactions
    }

    fieldValueClick(): void {
        // no-op
    }

    edit(): void {
        // no-op
    }

    startEdit(): void {
        // no-op
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    endEdit(newVal?: any, extra?: any): void {
        if (!this.editing) {
            return;
        }
        delete this.input;
        super.endEdit(newVal, extra);
    }
}

export { FieldViewSelect };
