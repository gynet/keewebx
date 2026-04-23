/* eslint-disable @typescript-eslint/no-explicit-any */
import { FieldViewText } from 'views/fields/field-view-text';
import { escape } from 'util/fn';
import tagsTemplate from 'templates/details/fields/tags.hbs';

/**
 * Deterministic hue from a tag string, so the same tag always gets
 * the same color. Simple djb2-style hash mod 360.
 */
function tagHue(tag: string): number {
    let hash = 0;
    for (let i = 0; i < tag.length; i++) {
        hash = tag.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash) % 360;
}

class FieldViewTags extends FieldViewText {
    hasOptions = false;

    tagsAutocomplete: any;

    renderValue(value: any): string {
        if (!value || !value.length) {
            return '';
        }
        return (value as string[])
            .map(
                (tag) =>
                    `<span class="tag-chip" style="--tag-hue:${tagHue(tag)}">${escape(tag)}</span>`
            )
            .join('');
    }

    getEditValue(value: any): string {
        return value ? value.join(', ') : '';
    }

    getTextValue(): string {
        return this.value ? this.value.join(', ') : '';
    }

    valueToTags(val: string): string[] {
        const allTags: Record<string, string> = {};
        this.model.tags.forEach((tag: string) => {
            allTags[tag.toLowerCase()] = tag;
        });
        const valueTags: Record<string, string> = {};
        val.split(/\s*[;,:]\s*/)
            .filter((tag) => tag)
            .map((tag) => allTags[tag.toLowerCase()] || tag)
            .forEach((tag) => {
                valueTags[tag] = tag;
            });
        return Object.keys(valueTags);
    }

    endEdit(newVal?: any, extra?: any): void {
        if (newVal !== undefined) {
            newVal = this.valueToTags(newVal);
        }
        if (this.tagsAutocomplete) {
            this.tagsAutocomplete.remove();
            this.tagsAutocomplete = null;
        }
        super.endEdit(newVal, extra);
    }

    startEdit(): void {
        super.startEdit();
        const fieldRect = this.input[0].getBoundingClientRect();
        const shadowSpread = parseInt(this.input.css('--focus-shadow-spread')) || 0;
        this.tagsAutocomplete = $('<div class="details__field-autocomplete"></div>').appendTo(
            'body'
        );
        this.tagsAutocomplete.css({
            top: fieldRect.bottom + shadowSpread,
            left: fieldRect.left,
            width: fieldRect.width - 2
        });
        this.tagsAutocomplete.mousedown(this.tagsAutocompleteClick.bind(this));
        this.setTags();
    }

    fieldValueInput(e: Event): void {
        e.stopPropagation();
        this.setTags();
        super.fieldValueInput(e);
    }

    getAvailableTags(): string[] {
        const tags = this.valueToTags(this.input.val());
        const last = tags[tags.length - 1];
        const isLastPart = last && this.model.tags.indexOf(last) < 0;
        return this.model.tags.filter((tag: string) => {
            return (
                tags.indexOf(tag) < 0 &&
                (!isLastPart || tag.toLowerCase().indexOf(last.toLowerCase()) >= 0)
            );
        });
    }

    setTags(): void {
        const availableTags = this.getAvailableTags();
        const tagsHtml = tagsTemplate({ tags: availableTags });
        this.tagsAutocomplete.html(tagsHtml);
        this.tagsAutocomplete.toggle(!!tagsHtml);
    }

    tagsAutocompleteClick(e: any): void {
        e.stopPropagation();
        if (e.target.classList.contains('details__field-autocomplete-item')) {
            const selectedTag = $(e.target).text();
            let newVal = this.input.val();
            if (newVal) {
                const tags = this.valueToTags(newVal);
                const last = tags[tags.length - 1];
                const isLastPart = last && this.model.tags.indexOf(last) < 0;
                if (isLastPart) {
                    newVal = newVal.substr(0, newVal.lastIndexOf(last)) + selectedTag;
                } else {
                    newVal += ', ' + selectedTag;
                }
            } else {
                newVal = selectedTag;
            }
            this.input.val(newVal);
            this.input.focus();
            this.setTags();
        }
        this.afterPaint(() => {
            this.input.focus();
        });
    }
}

export { FieldViewTags };
