/* eslint-disable @typescript-eslint/no-explicit-any */
import Pikaday from 'pikaday';
import { DateFormat } from 'comp/i18n/date-format';
import { FieldViewText } from 'views/fields/field-view-text';

class FieldViewDate extends FieldViewText {
    hasOptions = false;

    picker: any;

    renderValue(value: any): string {
        let result = value ? DateFormat.dStr(value) : '';
        if (value && this.model.lessThanNow && value < new Date()) {
            result += ' ' + this.model.lessThanNow;
        }
        return result;
    }

    getEditValue(value: any): string {
        return value ? DateFormat.dStr(value) : '';
    }

    startEdit(): void {
        super.startEdit();
        this.picker = new Pikaday({
            field: this.input[0],
            onSelect: this.pickerSelect.bind(this),
            onClose: this.pickerClose.bind(this),
            defaultDate: this.value,
            firstDay: 1,
            i18n: {
                previousMonth: '',
                nextMonth: '',
                months: DateFormat.months(),
                weekdays: DateFormat.weekDays(),
                weekdaysShort: DateFormat.shortWeekDays()
            }
        });
        this.picker.adjustPosition = this.adjustPickerPosition.bind(this);
        setTimeout(() => this.picker.show(), 0);
    }

    adjustPickerPosition(...args: any[]): void {
        (window as any).Pikaday = Pikaday;
        (Pikaday as any).prototype.adjustPosition.apply(this.picker, args);
        const shadowSpread = parseInt(this.input.css('--focus-shadow-spread')) || 0;
        if (shadowSpread) {
            const isOnTop = this.picker.el.classList.contains('top-aligned');
            const offset = isOnTop ? -shadowSpread : shadowSpread;
            const newTop = parseInt(this.picker.el.style.top) + offset;
            this.picker.el.style.top = `${newTop}px`;
        }
    }

    fieldValueBlur(e?: any): void {
        if (!this.picker) {
            super.fieldValueBlur(e);
        }
    }

    endEdit(newVal?: any, extra?: any): void {
        if (this.picker) {
            try {
                this.picker.destroy();
            } catch {
                /* ignore */
            }
            this.picker = null;
        }
        newVal = new Date(newVal);
        if (isNaN(newVal.getTime())) {
            newVal = null;
        }
        super.endEdit(newVal, extra);
    }

    pickerClose(): void {
        this.endEdit(this.input.val());
    }

    pickerSelect(dt: Date): void {
        this.endEdit(dt);
    }
}

export { FieldViewDate };
