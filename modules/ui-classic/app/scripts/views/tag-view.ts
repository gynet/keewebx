import { Events } from 'framework/events';
import { View } from 'framework/views/view';
import { Alerts } from 'comp/ui/alerts';
import { Locale } from 'util/locale';
import template from 'templates/tag.hbs';

interface TagLike {
    title: string;
}

class TagView extends View {
    parent = '.app__panel';

    template = template;

    events: Record<string, string> = {
        'click .tag__buttons-trash': 'moveToTrash',
        'click .back-button': 'returnToApp',
        'click .tag__btn-rename': 'renameTag'
    };

    tag: TagLike | undefined;
    title: string | null | undefined;

    render(): this | undefined {
        if (this.tag) {
            super.render({
                title: this.tag.title
            });
        }
        return this;
    }

    showTag(tag: TagLike): void {
        this.tag = tag;
        this.render();
    }

    renameTag(): void {
        const title = $.trim(this.$el.find('#tag__field-title').val()) as string;
        if (!title || !this.tag || title === this.tag.title) {
            return;
        }
        const loc = Locale as unknown as Record<string, string>;
        if (/[;,:]/.test(title)) {
            Alerts.error({
                header: loc['tagBadName'],
                body: loc['tagBadNameBody'].replace('{}', '`,`, `;`, `:`')
            });
            return;
        }
        if (
            this.model.tags.some((t: string) => t.toLowerCase() === title.toLowerCase())
        ) {
            Alerts.error({ header: loc['tagExists'], body: loc['tagExistsBody'] });
            return;
        }
        this.model.renameTag(this.tag.title, title);
        Events.emit('select-all');
    }

    moveToTrash(): void {
        this.title = null;
        const loc = Locale as unknown as Record<string, string>;
        Alerts.yesno({
            header: loc['tagTrashQuestion'],
            body: loc['tagTrashQuestionBody'],
            success: () => {
                if (this.tag) {
                    this.model.renameTag(this.tag.title, undefined);
                    Events.emit('select-all');
                }
            }
        });
    }

    returnToApp(): void {
        Events.emit('edit-tag');
    }
}

export { TagView };
