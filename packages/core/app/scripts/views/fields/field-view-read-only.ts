import { FieldView } from 'views/fields/field-view';
import { escape } from 'util/fn';

// Field values flow in as `string | ProtectedValue` from entry-model;
// the read-only renderer masks protected values as bullets and HTML-
// escapes plain strings.
interface ReadOnlyProtectedValue {
    isProtected: true;
    textLength: number;
}
type ReadOnlyValue = string | ReadOnlyProtectedValue | null | undefined;

class FieldViewReadOnly extends FieldView {
    readonly = true;

    renderValue(value: ReadOnlyValue): string {
        let rendered =
            value && typeof value === 'object' && value.isProtected
                ? new Array(value.textLength + 1).join('\u2022')
                : escape((value as string) ?? '');
        rendered = rendered.replace(/\n/g, '<br/>');
        return rendered;
    }
}

export { FieldViewReadOnly };
