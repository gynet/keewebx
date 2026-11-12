import { StringFormat } from 'util/formatting/string-format';

const DateFormat = {
    /** Set by the interface when the user picks a language. */
    locale: 'en-US' as string,

    months(): string[] {
        const format = new Intl.DateTimeFormat(DateFormat.locale, { month: 'long' });
        const months: string[] = [];
        for (let month = 0; month < 12; month++) {
            months.push(format.format(new Date(2008, month)));
        }
        return months;
    },

    weekDays(): string[] {
        const format = new Intl.DateTimeFormat(DateFormat.locale, { weekday: 'long' });
        const weekdays: string[] = [];
        for (let day = 1; day < 8; day++) {
            weekdays.push(format.format(new Date(2007, 9, 6 + day)));
        }
        return weekdays;
    },

    shortWeekDays(): string[] {
        const format = new Intl.DateTimeFormat(DateFormat.locale, { weekday: 'short' });
        const weekdays: string[] = [];
        for (let day = 1; day < 8; day++) {
            weekdays.push(format.format(new Date(2007, 9, 6 + day)));
        }
        return weekdays;
    },

    dtStr(dt: Date | number | null | undefined): string {
        if (typeof dt === 'number') {
            dt = new Date(dt);
        }
        return dt
            ? new Intl.DateTimeFormat(DateFormat.locale, {
                  dateStyle: 'medium',
                  timeStyle: 'medium'
              }).format(dt)
            : '';
    },

    dStr(dt: Date | number | null | undefined): string {
        if (typeof dt === 'number') {
            dt = new Date(dt);
        }
        return dt
            ? new Intl.DateTimeFormat(DateFormat.locale, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric'
              }).format(dt)
            : '';
    },

    dtStrFs(dt: Date | number | null | undefined): string {
        if (typeof dt === 'number') {
            dt = new Date(dt);
        }
        return dt
            ? dt.getFullYear() +
                  '-' +
                  StringFormat.pad(dt.getMonth() + 1, 2) +
                  '-' +
                  StringFormat.pad(dt.getDate(), 2) +
                  'T' +
                  StringFormat.pad(dt.getHours(), 2) +
                  '-' +
                  StringFormat.pad(dt.getMinutes(), 2) +
                  '-' +
                  StringFormat.pad(dt.getSeconds(), 2)
            : '';
    }
};

export { DateFormat };
