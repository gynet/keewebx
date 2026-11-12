import { FieldView } from 'views/fields/field-view';

class FieldViewReadOnlyRaw extends FieldView {
    readonly = true;

    renderValue(value: unknown): unknown {
        return value;
    }
}

export { FieldViewReadOnlyRaw };
