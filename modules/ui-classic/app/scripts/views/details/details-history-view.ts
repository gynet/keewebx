/* eslint-disable @typescript-eslint/no-explicit-any */
import { View } from 'framework/views/view';
import { Alerts } from 'comp/ui/alerts';
import { Keys } from 'const/keys';
import { DateFormat } from 'comp/i18n/date-format';
import { StringFormat } from 'util/formatting/string-format';
import { Locale } from 'util/locale';
import { Copyable } from 'framework/views/copyable';
import { FieldViewReadOnly } from 'views/fields/field-view-read-only';
import { FieldViewReadOnlyRaw } from 'views/fields/field-view-read-only-raw';
import { escape } from 'util/fn';
import template from 'templates/details/details-history.hbs';

const loc = Locale as unknown as Record<string, any>;
const alerts = Alerts as unknown as { yesno(opts: any): void };

interface HistoryFormat {
    name: string;
    round: number;
    format(d: Date): string;
}

interface TimelineEntry {
    pos: number;
    rec: any;
}

interface LabelEntry {
    pos: number;
    val: number;
    text: string;
}

class DetailsHistoryView extends View {
    template = template;

    events: Record<string, string> = {
        'click .details__subview-close': 'closeHistory',
        'click .details__history-timeline-item': 'timelineItemClick',
        'click .details__history-arrow-prev': 'timelinePrevClick',
        'click .details__history-arrow-next': 'timelineNextClick',
        'click .details__history-button-revert': 'revertClick',
        'click .details__history-button-delete': 'deleteClick',
        'click .details__history-button-discard': 'discardClick'
    };

    formats: HistoryFormat[] = [
        {
            name: 'ms',
            round: 1,
            format(d: Date) {
                return DateFormat.dtStr(d);
            }
        },
        {
            name: 'sec',
            round: 1000,
            format(d: Date) {
                return DateFormat.dtStr(d);
            }
        },
        {
            name: 'min',
            round: 1000 * 60,
            format(d: Date) {
                return DateFormat.dtStr(d).replace(':00 ', ' ');
            }
        },
        {
            name: 'hour',
            round: 1000 * 60 * 60,
            format(d: Date) {
                return DateFormat.dtStr(d).replace(':00', '');
            }
        },
        {
            name: 'day',
            round: 1000 * 60 * 60 * 24,
            format(d: Date) {
                return DateFormat.dStr(d);
            }
        },
        {
            name: 'month',
            round: 1000 * 60 * 60 * 24 * 31,
            format(d: Date) {
                return DateFormat.dStr(d);
            }
        },
        {
            name: 'year',
            round: 1000 * 60 * 60 * 24 * 365,
            format(d: Date) {
                return String(d.getFullYear());
            }
        }
    ];

    fieldViews: any[] = [];
    visibleRecord: number | undefined = undefined;
    history: any;
    timeline: TimelineEntry[] = [];
    labels: LabelEntry[] = [];
    timelineEl: any;
    bodyEl: any;
    activeIx = 0;
    record: any;

    fieldCopied!: (e: any) => void;

    constructor(model: any, options?: any) {
        super(model, options);
        this.onKey(Keys.DOM_VK_ESCAPE, this.closeHistory);
        this.once('remove', () => {
            this.removeFieldViews();
        });
    }

    render(): this | undefined {
        super.render();
        this.history = this.model.getHistory();
        this.buildTimeline();
        this.timelineEl = this.$el.find('.details__history-timeline');
        this.bodyEl = this.$el.find('.details__history-body');
        this.timeline.forEach((item, ix) => {
            $('<i/>')
                .addClass('fa fa-circle details__history-timeline-item')
                .css('left', item.pos * 100 + '%')
                .attr('data-id', ix)
                .appendTo(this.timelineEl);
        });
        this.labels.forEach((label) => {
            $('<div/>')
                .addClass('details__history-timeline-label')
                .css('left', label.pos * 100 + '%')
                .text(label.text)
                .appendTo(this.timelineEl);
        });
        let visibleRecord = this.visibleRecord;
        if (visibleRecord === undefined) {
            visibleRecord = this.history.length - 1;
        }
        this.showRecord(visibleRecord ?? 0);
        return this;
    }

    removeFieldViews(): void {
        this.fieldViews.forEach((fieldView) => fieldView.remove());
        this.fieldViews = [];
    }

    showRecord(ix: number): void {
        this.activeIx = ix;
        this.record = this.timeline[ix].rec;
        this.timelineEl
            .find('.details__history-timeline-item')
            .removeClass('details__history-timeline-item--active');
        this.timelineEl
            .find('.details__history-timeline-item[data-id="' + ix + '"]')
            .addClass('details__history-timeline-item--active');
        this.removeFieldViews();
        this.bodyEl.empty();
        const colorCls = this.record.color ? this.record.color + '-color' : '';
        this.fieldViews.push(
            new FieldViewReadOnly({
                name: 'Rev',
                title: loc.detHistoryVersion as string,
                value: ix + 1
            })
        );
        this.fieldViews.push(
            new FieldViewReadOnly({
                name: 'Updated',
                title: loc.detHistorySaved as string,
                value:
                    DateFormat.dtStr(this.record.updated) +
                    (this.record.unsaved
                        ? ' (' + (loc.detHistoryCurUnsavedState as string) + ')'
                        : '') +
                    (ix === this.history.length - 1 && !this.record.unsaved
                        ? ' (' + (loc.detHistoryCurState as string) + ')'
                        : '')
            })
        );
        this.fieldViews.push(
            new FieldViewReadOnlyRaw({
                name: '$Title',
                title: StringFormat.capFirst(loc.title as string),
                value:
                    '<i class="fa fa-' +
                        this.record.icon +
                        ' ' +
                        colorCls +
                        '"></i> ' +
                        escape(this.record.title) ||
                    '(' + (loc.detHistoryNoTitle as string) + ')'
            })
        );
        this.fieldViews.push(
            new FieldViewReadOnly({
                name: '$UserName',
                title: StringFormat.capFirst(loc.user as string),
                value: this.record.user
            })
        );
        this.fieldViews.push(
            new FieldViewReadOnly({
                name: '$Password',
                title: StringFormat.capFirst(loc.password as string),
                value: this.record.password
            })
        );
        this.fieldViews.push(
            new FieldViewReadOnly({
                name: '$URL',
                title: StringFormat.capFirst(loc.website as string),
                value: this.record.url
            })
        );
        this.fieldViews.push(
            new FieldViewReadOnly({
                name: '$Notes',
                title: StringFormat.capFirst(loc.notes as string),
                value: this.record.notes
            })
        );
        this.fieldViews.push(
            new FieldViewReadOnly({
                name: 'Tags',
                title: StringFormat.capFirst(loc.tags as string),
                value: this.record.tags.join(', ')
            })
        );
        this.fieldViews.push(
            new FieldViewReadOnly({
                name: 'Expires',
                title: loc.detExpires as string,
                value: this.record.expires ? DateFormat.dtStr(this.record.expires) : ''
            })
        );
        for (const [field, value] of Object.entries(this.record.fields as Record<string, any>)) {
            this.fieldViews.push(
                new FieldViewReadOnly({ name: '$' + field, title: field, value })
            );
        }
        if (this.record.attachments.length) {
            this.fieldViews.push(
                new FieldViewReadOnly({
                    name: 'Attachments',
                    title: loc.detAttachments as string,
                    value: this.record.attachments.map((att: any) => att.title).join(', ')
                })
            );
        }
        this.fieldViews.forEach((fieldView) => {
            fieldView.parent = this.bodyEl[0];
            fieldView.render();
            fieldView.on('copy', this.fieldCopied.bind(this));
        });
        const buttons = this.$el.find('.details__history-buttons');
        buttons.find('.details__history-button-revert').toggle(ix < this.history.length - 1);
        buttons.find('.details__history-button-delete').toggle(ix < this.history.length - 1);
        buttons
            .find('.details__history-button-discard')
            .toggle(
                (this.record.unsaved &&
                    ix === this.history.length - 1 &&
                    this.history.length > 1) ||
                    false
            );
    }

    timelineItemClick(e: Event): void {
        const id = $(e.target).closest('.details__history-timeline-item').data('id');
        this.showRecord(id);
    }

    timelinePrevClick(): void {
        if (this.activeIx > 0) {
            this.showRecord(this.activeIx - 1);
        }
    }

    timelineNextClick(): void {
        if (this.activeIx < this.timeline.length - 1) {
            this.showRecord(this.activeIx + 1);
        }
    }

    buildTimeline(): void {
        const firstRec = this.history[0];
        const lastRec = this.history[this.history.length - 1];
        this.timeline = this.history.map((rec: any) => ({
            pos: (rec.updated - firstRec.updated) / (lastRec.updated - firstRec.updated),
            rec
        }));
        const period = lastRec.updated - firstRec.updated;
        const format = this.getDateFormat(period);
        this.labels = this.getLabels(
            firstRec.updated.getTime(),
            lastRec.updated.getTime(),
            format.round
        ).map((label) => ({
            pos: (label - firstRec.updated) / (lastRec.updated - firstRec.updated),
            val: label,
            text: format.format(new Date(label))
        }));
    }

    getDateFormat(period: number): HistoryFormat {
        for (let i = 0; i < this.formats.length; i++) {
            if (period < this.formats[i].round * 1.2) {
                return this.formats[i > 0 ? i - 1 : 0];
            }
        }
        return this.formats[this.formats.length - 1];
    }

    getLabels(first: number, last: number, round: number): number[] {
        const count = Math.floor((last - first) / round);
        if (count > 2) {
            round *= Math.ceil(count / 2);
        }
        const labels: number[] = [];
        let label = Math.ceil(first / round) * round;
        while (label < last) {
            labels.push(label);
            label += round;
        }
        if (labels.length > 1 && (labels[0] - first) / (last - first) < 0.1) {
            labels.shift();
        }
        return labels;
    }

    closeHistory(updated?: boolean): void {
        this.emit('close', { updated });
    }

    revertClick(): void {
        alerts.yesno({
            header: loc.detHistoryRevertAlert as string,
            body: loc.detHistoryRevertAlertBody as string,
            success: () => {
                this.model.revertToHistoryState(this.record.entry);
                this.closeHistory(true);
            }
        });
    }

    deleteClick(): void {
        alerts.yesno({
            header: loc.detHistoryDeleteAlert as string,
            body: loc.detHistoryDeleteAlertBody as string,
            success: () => {
                this.model.deleteHistory(this.record.entry);
                this.visibleRecord = this.activeIx;
                this.render();
            }
        });
    }

    discardClick(): void {
        alerts.yesno({
            header: loc.detHistoryDiscardChangesAlert as string,
            body: loc.detHistoryDiscardChangesAlertBody as string,
            success: () => {
                this.model.discardUnsaved();
                this.closeHistory(true);
            }
        });
    }
}

Object.assign(DetailsHistoryView.prototype, Copyable);

export { DetailsHistoryView };
