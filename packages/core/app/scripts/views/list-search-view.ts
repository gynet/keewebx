/* eslint-disable @typescript-eslint/no-explicit-any */
import { View } from 'framework/views/view';
import { Events } from 'framework/events';
import { Shortcuts } from 'comp/app/shortcuts';
import { KeyHandler } from 'comp/browser/key-handler';
import { Keys } from 'const/keys';
import { Comparators } from 'util/data/comparators';
import { Features } from 'util/features';
import { StringFormat } from 'util/formatting/string-format';
import { Locale } from 'util/locale';
import { DropdownView } from 'views/dropdown-view';
import template from 'templates/list-search.hbs';

const loc = Locale as unknown as Record<string, any>;
const features = Features as unknown as { isMobile: boolean };
const shortcuts = Shortcuts as unknown as { altShortcutSymbol(short: boolean): string };

interface SortOption {
    value: string;
    icon: string;
    loc: () => string;
    text?: string;
    active?: boolean;
}

interface CreateOption {
    value: string;
    icon: string;
    text: string;
    hint?: string | null;
}

interface AdvancedSearch {
    user: boolean;
    other: boolean;
    url: boolean;
    protect: boolean;
    notes: boolean;
    pass: boolean;
    cs: boolean;
    regex: boolean;
    history: boolean;
    title: boolean;
}

class ListSearchView extends View {
    parent = '.list__header';

    template = template;

    events: Record<string, string> = {
        'keydown .list__search-field': 'inputKeyDown',
        'keypress .list__search-field': 'inputKeyPress',
        'input .list__search-field': 'inputChange',
        'focus .list__search-field': 'inputFocus',
        'click .list__search-btn-new': 'createOptionsClick',
        'click .list__search-btn-sort': 'sortOptionsClick',
        'click .list__search-icon-search': 'advancedSearchClick',
        'click .list__search-btn-menu': 'toggleMenu',
        'click .list__search-icon-clear': 'clickClear',
        'change .list__search-adv input[type=checkbox]': 'toggleAdvCheck'
    };

    inputEl: any = null;
    sortOptions: SortOption[] = [];
    sortIcons: Record<string, string> = {};
    createOptions: CreateOption[] = [];
    advancedSearchEnabled = false;
    advancedSearch: AdvancedSearch;
    entryTemplates: Record<string, any> = {};

    constructor(model: any) {
        super(model);
        this.sortOptions = [
            {
                value: 'title',
                icon: 'sort-alpha-down',
                loc: () =>
                    StringFormat.capFirst(loc.title as string) +
                    ' ' +
                    this.addArrow(loc.searchAZ as string)
            },
            {
                value: '-title',
                icon: 'sort-alpha-down-alt',
                loc: () =>
                    StringFormat.capFirst(loc.title as string) +
                    ' ' +
                    this.addArrow(loc.searchZA as string)
            },
            {
                value: 'website',
                icon: 'sort-alpha-down',
                loc: () =>
                    StringFormat.capFirst(loc.website as string) +
                    ' ' +
                    this.addArrow(loc.searchAZ as string)
            },
            {
                value: '-website',
                icon: 'sort-alpha-down-alt',
                loc: () =>
                    StringFormat.capFirst(loc.website as string) +
                    ' ' +
                    this.addArrow(loc.searchZA as string)
            },
            {
                value: 'user',
                icon: 'sort-alpha-down',
                loc: () =>
                    StringFormat.capFirst(loc.user as string) +
                    ' ' +
                    this.addArrow(loc.searchAZ as string)
            },
            {
                value: '-user',
                icon: 'sort-alpha-down-alt',
                loc: () =>
                    StringFormat.capFirst(loc.user as string) +
                    ' ' +
                    this.addArrow(loc.searchZA as string)
            },
            {
                value: 'created',
                icon: 'sort-numeric-down',
                loc: () =>
                    (loc.searchCreated as string) +
                    ' ' +
                    this.addArrow(loc.searchON as string)
            },
            {
                value: '-created',
                icon: 'sort-numeric-down-alt',
                loc: () =>
                    (loc.searchCreated as string) +
                    ' ' +
                    this.addArrow(loc.searchNO as string)
            },
            {
                value: 'updated',
                icon: 'sort-numeric-down',
                loc: () =>
                    (loc.searchUpdated as string) +
                    ' ' +
                    this.addArrow(loc.searchON as string)
            },
            {
                value: '-updated',
                icon: 'sort-numeric-down-alt',
                loc: () =>
                    (loc.searchUpdated as string) +
                    ' ' +
                    this.addArrow(loc.searchNO as string)
            },
            {
                value: '-attachments',
                icon: 'sort-amount-down',
                loc: () => loc.searchAttachments as string
            },
            { value: '-rank', icon: 'sort-amount-down', loc: () => loc.searchRank as string }
        ];
        this.sortIcons = {};
        this.sortOptions.forEach((opt) => {
            this.sortIcons[opt.value] = opt.icon;
        });
        this.advancedSearch = {
            user: true,
            other: true,
            url: true,
            protect: false,
            notes: true,
            pass: false,
            cs: false,
            regex: false,
            history: false,
            title: true
        };
        if (this.model.advancedSearch) {
            this.advancedSearch = { ...this.model.advancedSearch };
        }
        this.setLocale();
        this.onKey(Keys.DOM_VK_F, this.findKeyPress, KeyHandler.SHORTCUT_ACTION);
        this.onKey(Keys.DOM_VK_N, this.newKeyPress, KeyHandler.SHORTCUT_OPT);
        this.onKey(Keys.DOM_VK_DOWN, this.downKeyPress);
        this.onKey(Keys.DOM_VK_UP, this.upKeyPress);
        this.listenTo(this, 'show', this.viewShown);
        this.listenTo(this, 'hide', this.viewHidden);
        this.listenTo(Events, 'filter', this.filterChanged);
        this.listenTo(Events, 'set-locale', this.setLocale);
        this.listenTo(Events, 'page-blur', this.pageBlur);
        this.listenTo(this.model.files, 'change', this.fileListUpdated);

        this.once('remove', () => {
            this.removeKeypressHandler();
        });
    }

    setLocale(): void {
        this.sortOptions.forEach((opt) => {
            opt.text = opt.loc();
        });
        this.createOptions = [
            {
                value: 'entry',
                icon: 'key',
                text: StringFormat.capFirst(loc.entry as string),
                hint: features.isMobile
                    ? null
                    : `(${loc.searchShiftClickOr as string} ${shortcuts.altShortcutSymbol(true)})`
            },
            {
                value: 'group',
                icon: 'folder',
                text: StringFormat.capFirst(loc.group as string)
            }
        ];
        if (this.el) {
            this.render();
        }
    }

    pageBlur(): void {
        this.inputEl.blur();
    }

    removeKeypressHandler(): void {
        /* replaced inside viewShown */
    }

    viewShown(): void {
        const keypressHandler = (e: any) => this.documentKeyPress(e);
        Events.on('keypress', keypressHandler);
        this.removeKeypressHandler = () => Events.off('keypress', keypressHandler);
    }

    viewHidden(): void {
        this.removeKeypressHandler();
    }

    render(): this | undefined {
        let searchVal;
        if (this.inputEl) {
            searchVal = this.inputEl.val();
        }
        super.render({
            adv: this.advancedSearch,
            advEnabled: this.advancedSearchEnabled,
            canCreate: this.model.canCreateEntries()
        });
        this.inputEl = this.$el.find('.list__search-field');
        if (searchVal) {
            this.inputEl.val(searchVal);
        }
        return this;
    }

    inputKeyDown(e: any): void {
        switch (e.which) {
            case Keys.DOM_VK_UP:
            case Keys.DOM_VK_DOWN:
                break;
            case Keys.DOM_VK_RETURN:
                e.target.blur();
                break;
            case Keys.DOM_VK_ESCAPE:
                if (this.inputEl.val()) {
                    this.inputEl.val('');
                    this.inputChange();
                }
                e.target.blur();
                break;
            default:
                return;
        }
        e.preventDefault();
    }

    inputKeyPress(e: Event): void {
        e.stopPropagation();
    }

    inputChange(): void {
        const text = this.inputEl.val();
        this.inputEl[0].parentElement.classList.toggle('list__search-field-wrap--text', text);
        Events.emit('add-filter', { text });
    }

    inputFocus(e: Event): void {
        $(e.target).select();
    }

    documentKeyPress(e: any): void {
        if (this.hidden) {
            return;
        }
        const code = e.charCode;
        if (!code) {
            return;
        }
        this.hideSearchOptions();
        this.inputEl.val(String.fromCharCode(code)).focus();
        this.inputEl[0].setSelectionRange(1, 1);
        this.inputChange();
        e.preventDefault();
    }

    findKeyPress(e: Event): void {
        if (!this.hidden) {
            e.preventDefault();
            this.hideSearchOptions();
            this.inputEl.select().focus();
        }
    }

    newKeyPress(e: Event): void {
        if (!this.hidden) {
            e.preventDefault();
            this.hideSearchOptions();
            this.emit('create-entry');
        }
    }

    downKeyPress(e: Event): void {
        e.preventDefault();
        this.hideSearchOptions();
        this.emit('select-next');
    }

    upKeyPress(e: Event): void {
        e.preventDefault();
        this.hideSearchOptions();
        this.emit('select-prev');
    }

    filterChanged(filter: any): void {
        this.hideSearchOptions();
        if (filter.filter.text !== this.inputEl.val()) {
            this.inputEl.val(filter.text || '');
        }
        const sortIconCls = this.sortIcons[filter.sort] || 'sort';
        this.$el.find('.list__search-btn-sort>i').attr('class', 'fa fa-' + sortIconCls);
        let adv = !!filter.filter.advanced;
        if (this.model.advancedSearch) {
            adv = filter.filter.advanced !== this.model.advancedSearch;
        }
        if (this.advancedSearchEnabled !== adv) {
            this.advancedSearchEnabled = adv;
            this.$el.find('.list__search-adv').toggleClass('hide', !this.advancedSearchEnabled);
        }
    }

    createOptionsClick(e: any): void {
        e.stopImmediatePropagation();
        if (e.shiftKey) {
            this.hideSearchOptions();
            this.emit('create-entry');
            return;
        }
        this.toggleCreateOptions();
    }

    sortOptionsClick(e: Event): void {
        this.toggleSortOptions();
        e.stopImmediatePropagation();
    }

    advancedSearchClick(): void {
        this.advancedSearchEnabled = !this.advancedSearchEnabled;
        this.$el.find('.list__search-adv').toggleClass('hide', !this.advancedSearchEnabled);
        let advanced: AdvancedSearch | boolean = false;
        if (this.advancedSearchEnabled) {
            advanced = this.advancedSearch;
        } else if (this.model.advancedSearch) {
            advanced = this.model.advancedSearch;
        }
        Events.emit('add-filter', { advanced });
    }

    toggleMenu(): void {
        Events.emit('toggle-menu');
    }

    toggleAdvCheck(e: any): void {
        const setting = $(e.target).data('id') as keyof AdvancedSearch;
        this.advancedSearch[setting] = e.target.checked;
        Events.emit('add-filter', { advanced: this.advancedSearch });
    }

    hideSearchOptions(): void {
        if (this.views.searchDropdown) {
            (this.views.searchDropdown as View).remove();
            this.views.searchDropdown = null as any;
            this.$el
                .find('.list__search-btn-sort,.list__search-btn-new')
                .removeClass('sel--active');
        }
    }

    toggleSortOptions(): void {
        if (this.views.searchDropdown && (this.views.searchDropdown as any).isSort) {
            this.hideSearchOptions();
            return;
        }
        this.hideSearchOptions();
        this.$el.find('.list__search-btn-sort').addClass('sel--active');
        const view = new DropdownView();
        (view as any).isSort = true;
        this.listenTo(view, 'cancel', this.hideSearchOptions);
        this.listenTo(view, 'select', this.sortDropdownSelect);
        this.sortOptions.forEach((opt) => {
            opt.active = this.model.sort === opt.value;
        });
        view.render({
            position: {
                top: this.$el.find('.list__search-btn-sort')[0].getBoundingClientRect().bottom,
                right: this.$el[0].getBoundingClientRect().right + 1
            },
            options: this.sortOptions
        });
        this.views.searchDropdown = view as unknown as View;
    }

    toggleCreateOptions(): void {
        if (this.views.searchDropdown && (this.views.searchDropdown as any).isCreate) {
            this.hideSearchOptions();
            return;
        }

        this.hideSearchOptions();
        this.$el.find('.list__search-btn-new').addClass('sel--active');
        const view = new DropdownView();
        (view as any).isCreate = true;
        this.listenTo(view, 'cancel', this.hideSearchOptions);
        this.listenTo(view, 'select', this.createDropdownSelect);
        view.render({
            position: {
                top: this.$el.find('.list__search-btn-new')[0].getBoundingClientRect().bottom,
                right: this.$el[0].getBoundingClientRect().right + 1
            },
            options: this.createOptions.concat(this.getCreateEntryTemplateOptions() as any)
        });
        this.views.searchDropdown = view as unknown as View;
    }

    getCreateEntryTemplateOptions(): Array<{ value: string; icon: string; text: string }> {
        const entryTemplates = this.model.getEntryTemplates();
        const hasMultipleFiles = this.model.files.length > 1;
        this.entryTemplates = {};
        const options: Array<{ value: string; icon: string; text: string }> = [];
        entryTemplates.forEach((tmpl: any) => {
            const id = 'tmpl:' + tmpl.entry.id;
            options.push({
                value: id,
                icon: tmpl.entry.icon,
                text: hasMultipleFiles
                    ? tmpl.file.name + ' / ' + tmpl.entry.title
                    : tmpl.entry.title
            });
            this.entryTemplates[id] = tmpl;
        });
        options.sort(Comparators.stringComparator('text', true));
        options.push({
            value: 'tmpl',
            icon: 'sticky-note-o',
            text: StringFormat.capFirst(loc.template as string)
        });
        return options;
    }

    sortDropdownSelect(e: { item: string }): void {
        this.hideSearchOptions();
        Events.emit('set-sort', e.item);
    }

    createDropdownSelect(e: { item: string }): void {
        this.hideSearchOptions();
        switch (e.item) {
            case 'entry':
                this.emit('create-entry');
                break;
            case 'group':
                this.emit('create-group');
                break;
            case 'tmpl':
                this.emit('create-template');
                break;
            default:
                if (this.entryTemplates[e.item]) {
                    this.emit('create-entry', { template: this.entryTemplates[e.item] });
                }
        }
    }

    addArrow(str: string): string {
        return str.replace('{}', '\u2192');
    }

    fileListUpdated(): void {
        this.render();
    }

    clickClear(): void {
        this.inputEl.val('');
        this.inputChange();
    }
}

export { ListSearchView };
