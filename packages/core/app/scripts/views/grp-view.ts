import { View } from 'framework/views/view';
import { Events } from 'framework/events';
import { Scrollable } from 'framework/views/scrollable';
import { IconSelectView } from 'views/icon-select-view';
import template from 'templates/grp.hbs';

interface IconSelection {
    id: string;
    custom?: boolean;
}

class GrpView extends View {
    parent = '.app__panel';

    template = template;

    events: Record<string, string> = {
        'click .grp__icon': 'showIconsSelect',
        'click .grp__buttons-trash': 'moveToTrash',
        'click .back-button': 'returnToApp',
        'input #grp__field-title': 'changeTitle',
        'focus #grp__field-auto-type-seq': 'focusAutoTypeSeq',
        'input #grp__field-auto-type-seq': 'changeAutoTypeSeq',
        'change #grp__check-search': 'setEnableSearching',
        'change #grp__check-auto-type': 'setEnableAutoType'
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createScroll!: (config: any) => void;
    pageResized!: () => void;

    render(): this | undefined {
        this.removeSubView();
        super.render({
            title: this.model.title,
            icon: this.model.icon || 'folder',
            customIcon: this.model.customIcon,
            enableSearching: this.model.getEffectiveEnableSearching(),
            readonly: this.model.top,
            canAutoType: false,
            autoTypeSeq: this.model.autoTypeSeq,
            autoTypeEnabled: this.model.getEffectiveEnableAutoType(),
            defaultAutoTypeSeq: this.model.getParentEffectiveAutoTypeSeq()
        });
        if (!this.model.title) {
            this.$el.find('#grp__field-title').focus();
        }
        this.createScroll({
            root: this.$el.find('.grp')[0],
            scroller: this.$el.find('.scroller')[0],
            bar: this.$el.find('.scroller__bar')[0]
        });
        this.pageResized();
        return this;
    }

    removeSubView(): void {
        if (this.views.sub) {
            (this.views.sub as View).remove();
            delete this.views.sub;
        }
    }

    changeTitle(e: Event): void {
        const title = $.trim((e.target as HTMLInputElement).value);
        if (title) {
            if (!this.model.top && title !== this.model.title) {
                this.model.setName(title);
            }
        } else {
            if (this.model.isJustCreated) {
                this.model.removeWithoutHistory();
                Events.emit('edit-group');
            }
        }
    }

    changeAutoTypeSeq(e: Event): void {
        const seq = $.trim((e.target as HTMLInputElement).value);
        this.model.setAutoTypeSeq(seq);
    }

    showIconsSelect(): void {
        if (this.views.sub) {
            this.removeSubView();
        } else {
            const subView = new IconSelectView(
                {
                    iconId: this.model.customIconId || this.model.iconId,
                    file: this.model.file
                },
                {
                    parent: this.$el.find('.grp__icons')[0]
                }
            );
            this.listenTo(subView, 'select', this.iconSelected);
            subView.render();
            this.views.sub = subView as unknown as View;
        }
        this.pageResized();
    }

    iconSelected(sel: IconSelection): void {
        if (sel.custom) {
            if (sel.id !== this.model.customIconId) {
                this.model.setCustomIcon(sel.id);
            }
        } else if (sel.id !== this.model.iconId) {
            this.model.setIcon(+sel.id);
        }
        this.render();
    }

    moveToTrash(): void {
        this.model.moveToTrash();
        Events.emit('select-all');
    }

    setEnableSearching(e: Event): void {
        const enabled = (e.target as HTMLInputElement).checked;
        this.model.setEnableSearching(enabled);
    }

    setEnableAutoType(e: Event): void {
        const enabled = (e.target as HTMLInputElement).checked;
        this.model.setEnableAutoType(enabled);
    }

    returnToApp(): void {
        Events.emit('edit-group');
    }
}

Object.assign(GrpView.prototype, Scrollable);

export { GrpView };
