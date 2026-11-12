import { Locale } from 'util/locale';
import { FieldView } from 'views/fields/field-view';

const loc = Locale as Record<string, string | undefined>;

// History values are passed in by entry-model and carry the saved-record
// count plus an optional `unsaved` flag for the in-memory pending entry.
interface HistoryValue {
    length: number;
    unsaved?: boolean;
}

class FieldViewHistory extends FieldView {
    readonly = true;

    renderValue(value: HistoryValue): string {
        if (!value.length) {
            return loc.detHistoryEmpty ?? '';
        }
        let text =
            value.length +
            ' ' +
            (value.length === 1
                ? (loc.detHistoryRec ?? '')
                : (loc.detHistoryRecs ?? ''));
        if (value.unsaved) {
            text += ' (' + (loc.detHistoryModified ?? '') + ')';
        }
        return '<a class="details__history-link">' + text + '</a>';
    }
}

export { FieldViewHistory };
