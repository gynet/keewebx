/* eslint-disable @typescript-eslint/no-explicit-any */
import * as kdbxweb from 'kdbxweb';
import { View } from 'framework/views/view';
import { Events } from 'framework/events';
import { CopyPaste } from 'comp/browser/copy-paste';
import { KeyHandler } from 'comp/browser/key-handler';
import { OtpQrReader } from 'comp/format/otp-qr-reader';
import { Alerts } from 'comp/ui/alerts';
import { Keys } from 'const/keys';
import { Timeouts } from 'const/timeouts';
import { AppSettingsModel } from 'models/app-settings-model';
import { GroupModel } from 'models/group-model';
import { Features } from 'util/features';
import { Locale } from 'util/locale';
import { FileSaver } from 'util/ui/file-saver';
import { Tip } from 'util/ui/tip';
import { Copyable } from 'framework/views/copyable';
import { Scrollable } from 'framework/views/scrollable';
import { DetailsAddFieldView } from 'views/details/details-add-field-view';
import { DetailsAttachmentView } from 'views/details/details-attachment-view';
import { DetailsHistoryView } from 'views/details/details-history-view';
import { DetailsIssuesView } from 'views/details/details-issues-view';
import { DropdownView } from 'views/dropdown-view';
import { createDetailsFields, createNewCustomField } from 'views/details/details-fields';
import { FieldViewCustom } from 'views/fields/field-view-custom';
import { IconSelectView } from 'views/icon-select-view';
import { isEqual } from 'util/fn';
import template from 'templates/details/details.hbs';
import emptyTemplate from 'templates/details/details-empty.hbs';
import groupTemplate from 'templates/details/details-group.hbs';

const loc = Locale as unknown as Record<string, any>;
const features = Features as unknown as { isMobile: boolean };
const settings = AppSettingsModel as unknown as Record<string, any>;
const otpQrReader = OtpQrReader as unknown as { read(): void };
const copyPaste = CopyPaste as unknown as {
    simpleCopy: boolean;
    createHiddenInput(text: string): void;
    copy(text: string): any;
    copyHtml(html: string): void;
};
const alerts = Alerts as unknown as { yesno(opts: any): void };

class DetailsView extends View {
    parent = '.app__details';
    fieldViews: any[] = [];
    fieldCopyTip: any = null;

    appModel: any;
    moreView: any;
    helpTipCopyShown?: boolean;
    dragging?: boolean;
    dragTimeout?: ReturnType<typeof setTimeout>;
    scroller: any;

    // Provided by Scrollable mixin
    initScroll!: () => void;
    removeScroll!: () => void;
    createScroll!: (opts: any) => void;
    pageResized!: () => void;
    removeInnerViews!: () => void;

    // Provided by Copyable mixin
    hideFieldCopyTip!: () => void;
    fieldCopied!: (e: any) => void;

    events: Record<string, string> = {
        'click .details__colors-popup-item': 'selectColor',
        'click .details__header-icon': 'toggleIcons',
        'click .details__attachment': 'toggleAttachment',
        'click .details__header-title': 'editTitle',
        'click .details__history-link': 'showHistory',
        'click .details__buttons-trash': 'moveToTrash',
        'click .details__buttons-trash-del': 'deleteFromTrash',
        'click .details__back-button': 'backClick',
        'click .details__attachment-add': 'attachmentBtnClick',
        'change .details__attachment-input-file': 'attachmentFileChange',
        'dragover .details': 'dragover',
        'dragleave .details': 'dragleave',
        'drop .details': 'drop',
        'contextmenu .details': 'contextMenu'
    };

    constructor(model: any, options?: any) {
        super(model, options);
        this.initScroll();
        this.listenTo(Events, 'entry-selected', this.showEntry);
        this.listenTo(Events, 'copy-password', this.copyPassword);
        this.listenTo(Events, 'copy-user', this.copyUserName);
        this.listenTo(Events, 'copy-url', this.copyUrl);
        this.listenTo(Events, 'copy-otp', this.copyOtp);
        this.listenTo(Events, 'toggle-settings', this.settingsToggled);
        this.listenTo(Events, 'context-menu-select', this.contextMenuSelect);
        this.listenTo(Events, 'set-locale', this.render);
        this.listenTo(Events, 'qr-read', this.otpCodeRead);
        this.listenTo(Events, 'qr-enter-manually', this.otpEnterManually);
        this.onKey(
            Keys.DOM_VK_C,
            this.copyPasswordFromShortcut,
            KeyHandler.SHORTCUT_ACTION,
            false,
            true
        );
        this.onKey(Keys.DOM_VK_B, this.copyUserName, KeyHandler.SHORTCUT_ACTION);
        this.onKey(Keys.DOM_VK_U, this.copyUrl, KeyHandler.SHORTCUT_ACTION);
        this.onKey(Keys.DOM_VK_2, this.copyOtp, KeyHandler.SHORTCUT_OPT);
        this.onKey(
            Keys.DOM_VK_DELETE,
            this.deleteKeyPress,
            KeyHandler.SHORTCUT_ACTION,
            false,
            true
        );
        this.onKey(
            Keys.DOM_VK_BACK_SPACE,
            this.deleteKeyPress,
            KeyHandler.SHORTCUT_ACTION,
            false,
            true
        );
        this.once('remove', () => {
            this.removeFieldViews();
        });
    }

    removeFieldViews(): void {
        this.fieldViews.forEach((fieldView: any) => fieldView.remove());
        this.fieldViews = [];
        this.hideFieldCopyTip();
    }

    render(): this | undefined {
        (Tip as any).destroyTips(this.$el);
        this.removeScroll();
        this.removeFieldViews();
        this.removeInnerViews();
        if (!this.model) {
            this.template = emptyTemplate;
            super.render();
            return this;
        }
        if (this.model instanceof (GroupModel as any)) {
            this.template = groupTemplate;
            super.render();
            return this;
        }
        const model = {
            deleted: this.appModel.filter.trash,
            canEditColor: this.model.file.supportsColors && !this.model.readOnly,
            canEditIcon: this.model.file.supportsIcons && !this.model.readOnly,
            showButtons: !this.model.backend && !this.model.readOnly,
            ...this.model
        };
        this.template = template;
        super.render(model);
        this.setSelectedColor(this.model.color);
        this.addFieldViews();
        this.checkPasswordIssues();
        this.createScroll({
            root: this.$el.find('.details__body')[0],
            scroller: this.$el.find('.scroller')[0],
            bar: this.$el.find('.scroller__bar')[0]
        });
        this.$el.find('.details').removeClass('details--drag');
        this.dragging = false;
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
        }
        this.pageResized();
        this.showCopyTip();
        return this;
    }

    getFieldView(name: string): any {
        return this.fieldViews.find((fv: any) => fv.model.name === name);
    }

    addFieldViews(): void {
        const { fieldViews, fieldViewsAside } = createDetailsFields(this) as any;

        const hideEmptyFields = settings.hideEmptyFields;

        const fieldsMainEl = this.$el.find('.details__body-fields');
        const fieldsAsideEl = this.$el.find('.details__body-aside');
        for (const views of [fieldViews, fieldViewsAside]) {
            for (const fieldView of views as any[]) {
                fieldView.parent = views === fieldViews ? fieldsMainEl[0] : fieldsAsideEl[0];
                fieldView.render();
                fieldView.on('change', this.fieldChanged.bind(this));
                fieldView.on('copy', (e: any) => this.copyFieldValue(e));
                // auto-type removed in web-only fork
                if (hideEmptyFields) {
                    const value = fieldView.model.value();
                    if (!value || value.length === 0 || value.byteLength === 0) {
                        if (this.model.isJustCreated) {
                            const fieldsHiddenForNewEntriesWhenEmpty = [
                                '$URL',
                                '$Notes',
                                'Tags',
                                'Expires',
                                'History'
                            ];
                            if (
                                !fieldsHiddenForNewEntriesWhenEmpty.includes(fieldView.model.name)
                            ) {
                                continue;
                            }
                        }
                        fieldView.hide();
                    }
                }
            }
        }

        this.fieldViews = (fieldViews as any[]).concat(fieldViewsAside as any[]);

        if (!this.model.backend) {
            this.moreView = new (DetailsAddFieldView as any)();
            this.moreView.render();
            this.moreView.on('add-field', this.addNewField.bind(this));
            this.moreView.on('more-click', this.toggleMoreOptions.bind(this));
        }
    }

    addNewField(title?: string): void {
        this.moreView.remove();
        this.moreView = null;
        let newFieldTitle = title || loc.detNetField;
        if (this.model.fields[newFieldTitle]) {
            for (let i = 1; ; i++) {
                const newFieldTitleVariant = newFieldTitle + i;
                if (!this.model.fields[newFieldTitleVariant]) {
                    newFieldTitle = newFieldTitleVariant;
                    break;
                }
            }
        }

        const fieldView = createNewCustomField(
            newFieldTitle,
            {
                parent: this.$el.find('.details__body-fields')[0]
            },
            this.model
        );

        fieldView.on('change', this.fieldChanged.bind(this));
        fieldView.render();
        fieldView.edit();
        this.fieldViews.push(fieldView);
    }

    toggleMoreOptions(): void {
        const views = (this as any).views;
        if (views.dropdownView) {
            views.dropdownView.remove();
            views.dropdownView = null;
        } else {
            setTimeout(() => {
                const dropdownView: any = new (DropdownView as any)();
                this.listenTo(dropdownView, 'cancel', this.toggleMoreOptions);
                this.listenTo(dropdownView, 'select', this.moreOptionsSelect);
                const hideEmptyFields = settings.hideEmptyFields;
                const moreOptions: any[] = [];
                if (hideEmptyFields) {
                    this.fieldViews.forEach(function (this: DetailsView, fieldView: any) {
                        if (fieldView.isHidden()) {
                            moreOptions.push({
                                value: 'add:' + fieldView.model.name,
                                icon: 'pencil-alt',
                                text: loc.detMenuAddField.replace('{}', fieldView.model.title)
                            });
                        }
                    }, this);
                    moreOptions.push({
                        value: 'add-new',
                        icon: 'plus',
                        text: loc.detMenuAddNewField
                    });
                    if (this.model.url) {
                        moreOptions.push({
                            value: 'add-website',
                            icon: 'plus',
                            text: loc.detMenuAddNewWebsite
                        });
                    }
                    moreOptions.push({
                        value: 'toggle-empty',
                        icon: 'eye',
                        text: loc.detMenuShowEmpty
                    });
                } else {
                    moreOptions.push({
                        value: 'add-new',
                        icon: 'plus',
                        text: loc.detMenuAddNewField
                    });
                    if (this.model.url) {
                        moreOptions.push({
                            value: 'add-website',
                            icon: 'plus',
                            text: loc.detMenuAddNewWebsite
                        });
                    }
                    moreOptions.push({
                        value: 'toggle-empty',
                        icon: 'eye-slash',
                        text: loc.detMenuHideEmpty
                    });
                }
                moreOptions.push({ value: 'otp', icon: 'clock', text: loc.detSetupOtp });
                moreOptions.push({ value: 'clone', icon: 'clone', text: loc.detClone });
                moreOptions.push({
                    value: 'copy-to-clipboard',
                    icon: 'copy',
                    text: loc.detCopyEntryToClipboard
                });
                const rect = this.moreView.labelEl[0].getBoundingClientRect();
                dropdownView.render({
                    position: { top: rect.bottom, left: rect.left },
                    options: moreOptions
                });
                views.dropdownView = dropdownView;
            });
        }
    }

    moreOptionsSelect(e: any): void {
        const views = (this as any).views;
        views.dropdownView.remove();
        views.dropdownView = null;
        switch (e.item) {
            case 'add-new':
                this.addNewField();
                break;
            case 'add-website':
                this.addNewField(this.model.getNextUrlFieldName());
                break;
            case 'toggle-empty': {
                const hideEmptyFields = settings.hideEmptyFields;
                settings.hideEmptyFields = !hideEmptyFields;
                this.render();
                break;
            }
            case 'otp':
                this.setupOtp();
                break;
            case 'clone':
                this.clone();
                break;
            case 'copy-to-clipboard':
                this.copyToClipboard();
                break;
            default:
                if (e.item.lastIndexOf('add:', 0) === 0) {
                    const fieldName = e.item.substr(4);
                    const fieldView = this.fieldViews.find((f: any) => f.model.name === fieldName);
                    fieldView.show();
                    fieldView.edit();
                }
        }
    }

    getUserNameCompletions(part: string): string[] {
        return this.appModel.completeUserNames(part);
    }

    setSelectedColor(color: string | null): void {
        this.$el
            .find('.details__colors-popup > .details__colors-popup-item')
            .removeClass('details__colors-popup-item--active');
        const colorEl = this.$el.find('.details__header-color')[0];
        for (const cls of colorEl.classList) {
            if (cls.indexOf('color') > 0 && cls.lastIndexOf('details', 0) !== 0) {
                colorEl.classList.remove(cls);
            }
        }
        if (color) {
            this.$el
                .find('.details__colors-popup > .' + color + '-color')
                .addClass('details__colors-popup-item--active');
            colorEl.classList.add(color + '-color');
        }
    }

    selectColor(e: any): void {
        let color = $(e.target).closest('.details__colors-popup-item').data('color');
        if (!color) {
            return;
        }
        if (color === this.model.color) {
            color = null;
        }
        this.model.setColor(color);
        this.entryUpdated();
    }

    toggleIcons(): void {
        if (this.model.backend) {
            return;
        }
        const views = (this as any).views;
        if (views.sub && views.sub instanceof (IconSelectView as any)) {
            this.render();
            return;
        }
        this.removeSubView();
        const subView: any = new (IconSelectView as any)(
            {
                iconId: this.model.customIconId || this.model.iconId,
                url: this.model.url,
                file: this.model.file
            },
            {
                parent: this.scroller[0],
                replace: true
            }
        );
        this.listenTo(subView, 'select', this.iconSelected);
        subView.render();
        this.pageResized();
        views.sub = subView;
    }

    toggleAttachment(e: any): void {
        const attBtn = $(e.target).closest('.details__attachment');
        const id = attBtn.data('id');
        const attachment = this.model.attachments[id];
        if (e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) {
            this.downloadAttachment(attachment);
            return;
        }
        const views = (this as any).views;
        if (views.sub && views.sub.attId === id) {
            this.render();
            return;
        }
        this.removeSubView();
        const subView: any = new (DetailsAttachmentView as any)(attachment, {
            parent: this.scroller[0],
            replace: true
        });
        subView.attId = id;
        subView.render(this.pageResized.bind(this));
        subView.on('download', () => this.downloadAttachment(attachment));
        this.listenTo(subView, 'close', this.render.bind(this));
        views.sub = subView;
        attBtn.addClass('details__attachment--active');
    }

    removeSubView(): void {
        this.$el.find('.details__attachment').removeClass('details__attachment--active');
        const views = (this as any).views;
        if (views.sub) {
            views.sub.remove();
            delete views.sub;
        }
    }

    downloadAttachment(attachment: any): void {
        const data = attachment.getBinary();
        if (!data) {
            return;
        }
        const mimeType = attachment.mimeType || 'application/octet-stream';
        const blob = new Blob([data], { type: mimeType });
        FileSaver.saveAs(blob, attachment.title);
    }

    iconSelected(sel: any): void {
        if (sel.custom) {
            if (sel.id !== this.model.customIconId) {
                this.model.setCustomIcon(sel.id);
                this.entryUpdated();
            } else {
                this.render();
            }
        } else if (sel.id !== this.model.iconId) {
            this.model.setIcon(+sel.id);
            this.entryUpdated();
        } else {
            this.render();
        }
    }

    showEntry(entry: any): void {
        this.model = entry;
        this.initOtp();
        this.render();
        if (entry && !entry.title && entry.isJustCreated) {
            this.editTitle();
        }
    }

    initOtp(): void {
        if (!this.model) {
            return;
        }

        this.model.initOtpGenerator?.();
    }

    copyKeyPress(editView: any): boolean | undefined {
        if (!editView || this.isHidden()) {
            return false;
        }
        if (!window.getSelection()?.toString()) {
            const fieldText = editView.getTextValue();
            if (!fieldText) {
                return undefined;
            }
            if (!copyPaste.simpleCopy) {
                copyPaste.createHiddenInput(fieldText);
            }
            const copyRes = copyPaste.copy(fieldText);
            this.copyFieldValue({ source: editView, copyRes });

            return true;
        }
        return false;
    }

    copyPasswordFromShortcut(e: any): void {
        if (!this.model) {
            return;
        }
        const copied = this.copyKeyPress(this.getFieldView('$Password'));
        if (copied) {
            e.preventDefault();
        }
    }

    copyPassword(): void {
        this.copyKeyPress(this.getFieldView('$Password'));
    }

    copyUserName(): void {
        this.copyKeyPress(this.getFieldView('$UserName'));
    }

    copyUrl(): void {
        this.copyKeyPress(this.getFieldView('$URL'));
    }

    copyOtp(): void {
        const otpField = this.getFieldView('$otp');
        this.copyKeyPress(otpField);
    }

    showCopyTip(): void {
        if (this.helpTipCopyShown) {
            return;
        }
        this.helpTipCopyShown = settings.helpTipCopyShown;
        if (this.helpTipCopyShown) {
            return;
        }
        settings.helpTipCopyShown = true;
        this.helpTipCopyShown = true;
        if (!this.moreView) {
            return;
        }
        const label = this.moreView.labelEl;
        const tip: any = new (Tip as any)(label, { title: loc.detCopyHint, placement: 'right' });
        tip.show();
        this.fieldCopyTip = tip;
        setTimeout(() => {
            tip.hide();
        }, (Timeouts as any).AutoHideHint);
    }

    settingsToggled(): void {
        this.hideFieldCopyTip();
    }

    fieldChanged(e: any): void {
        if (e.field) {
            if (e.field[0] === '$') {
                let fieldName = e.field.substr(1);
                if (fieldName === 'otp') {
                    if (this.otpFieldChanged(e.val)) {
                        this.entryUpdated();
                        return;
                    }
                } else if (e.newField) {
                    if (fieldName) {
                        this.model.setField(fieldName, undefined);
                    }
                    fieldName = e.newField;
                    let i = 0;
                    while (this.model.hasField(fieldName)) {
                        i++;
                        fieldName = e.newField + i;
                    }
                    const allowEmpty = this.model.group.isEntryTemplatesGroup();
                    this.model.setField(fieldName, e.val, allowEmpty);
                    this.entryUpdated();
                    return;
                } else if (fieldName === 'File') {
                    const newFile = this.appModel.files.get(e.val);
                    this.model.moveToFile(newFile);
                    this.appModel.activeEntryId = this.model.id;
                    this.entryUpdated();
                    Events.emit('entry-selected', this.model);
                    return;
                } else if (fieldName) {
                    this.model.setField(fieldName, e.val);
                }
                const views = (this as any).views;
                if (fieldName === 'Password' && views.issues) {
                    views.issues.passwordChanged();
                }
            } else if (e.field === 'Tags') {
                this.model.setTags(e.val);
                this.appModel.updateTags();
            } else if (e.field === 'Expires') {
                const dt = e.val || undefined;
                if (!isEqual(dt, this.model.expires)) {
                    this.model.setExpires(dt);
                }
            }
            this.entryUpdated(true);
            this.fieldViews.forEach(function (this: DetailsView, fieldView: any, ix: number) {
                // TODO: render the view instead
                if (
                    (fieldView instanceof (FieldViewCustom as any) &&
                        !fieldView.model.newField &&
                        !this.model.hasField(fieldView.model.title)) ||
                    (fieldView.model.isExtraUrl &&
                        !fieldView.model.newField &&
                        !this.model.hasField(fieldView.model.name.replace('$', '')))
                ) {
                    fieldView.remove();
                    this.fieldViews.splice(ix, 1);
                } else {
                    fieldView.update();
                }
            }, this);
        } else if (e.newField) {
            this.render();
            return;
        }
        if (e.tab) {
            this.focusNextField(e.tab);
        }
    }

    otpFieldChanged(value: any): boolean {
        let oldValue: any = this.model.fields.otp;
        if (oldValue && oldValue.isProtected) {
            oldValue = oldValue.getText();
        }
        if (value && value.isProtected) {
            value = value.getText();
        }
        if (oldValue === value) {
            this.render();
            return false;
        }
        this.model.setOtpUrl(value);
        return true;
    }

    dragover(e: any): void {
        e.preventDefault();
        e.stopPropagation();
        const dt = e.dataTransfer;
        if (
            !dt.types ||
            (dt.types.indexOf ? dt.types.indexOf('Files') === -1 : !dt.types.contains('Files'))
        ) {
            dt.dropEffect = 'none';
            return;
        }
        dt.dropEffect = 'copy';
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
        }
        if (this.model && !this.dragging) {
            this.dragging = true;
            this.$el.find('.details').addClass('details--drag');
        }
    }

    dragleave() {
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
        }
        this.dragTimeout = setTimeout(() => {
            this.$el.find('.details').removeClass('details--drag');
            this.dragging = false;
        }, 100);
    }

    drop(e: any): void {
        e.preventDefault();
        if (!this.model) {
            return;
        }
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
        }
        this.$el.find('.details').removeClass('details--drag');
        this.dragging = false;
        const files = e.target.files || e.dataTransfer.files;
        this.addAttachedFiles(files);
    }

    attachmentBtnClick(): void {
        this.$el.find('.details__attachment-input-file')[0].click();
    }

    attachmentFileChange(e: any): void {
        this.addAttachedFiles(e.target.files);
    }

    addAttachedFiles(files: any): void {
        for (const file of files) {
            const reader = new FileReader();
            reader.onload = () => {
                this.addAttachment(file.name, reader.result);
            };
            reader.readAsArrayBuffer(file);
        }
    }

    addAttachment(name: string, data: any): void {
        this.model.addAttachment(name, data).then(() => {
            this.entryUpdated();
        });
    }

    deleteKeyPress(e: any): void {
        const views = (this as any).views;
        if (views.sub && views.sub.attId !== undefined) {
            e.preventDefault();
            const attachment = this.model.attachments[views.sub.attId];
            this.model.removeAttachment(attachment.title);
            this.render();
        }
    }

    editTitle(): void {
        const input = $('<input/>')
            .addClass('details__header-title-input')
            .attr({ autocomplete: 'off', spellcheck: 'false', placeholder: 'Title' })
            .val(this.model.title);
        input.bind({
            blur: this.titleInputBlur.bind(this) as any,
            input: this.titleInputInput.bind(this) as any,
            keydown: this.titleInputKeydown.bind(this) as any,
            keypress: this.titleInputInput.bind(this) as any
        });
        $('.details__header-title').replaceWith(input);
        (input.focus()[0] as HTMLInputElement).setSelectionRange(
            this.model.title.length,
            this.model.title.length
        );
    }

    titleInputBlur(e: any): void {
        this.setTitle(e.target.value);
    }

    titleInputInput(e: any): void {
        e.stopPropagation();
    }

    titleInputKeydown(e: any): void {
        (KeyHandler as any).reg();
        e.stopPropagation();
        const code = e.keyCode || e.which;
        if (code === Keys.DOM_VK_RETURN) {
            $(e.target).unbind('blur');
            this.setTitle(e.target.value);
        } else if (code === Keys.DOM_VK_ESCAPE) {
            $(e.target).unbind('blur');
            if (this.model.isJustCreated) {
                this.model.removeWithoutHistory();
                Events.emit('refresh');
                return;
            }
            this.render();
        } else if (code === Keys.DOM_VK_TAB) {
            e.preventDefault();
            $(e.target).unbind('blur');
            this.setTitle(e.target.value);
            if (!e.shiftKey) {
                this.focusNextField({ field: '$Title' });
            }
        }
    }

    setTitle(title: any): void {
        if (this.model.title instanceof kdbxweb.ProtectedValue) {
            title = kdbxweb.ProtectedValue.fromString(title);
        }
        if (title !== this.model.title) {
            this.model.setField('Title', title);
            this.entryUpdated(true);
        }
        const newTitle = $('<h1 class="details__header-title"></h1>').text(title || '(no title)');
        this.$el.find('.details__header-title-input').replaceWith(newTitle);
    }

    entryUpdated(skipRender?: boolean): void {
        Events.emit('entry-updated', { entry: this.model });
        this.initOtp();
        if (!skipRender) {
            this.render();
        }
    }

    focusNextField(config: any): void {
        let found = false;
        let nextFieldView: any;
        if (config.field === '$Title' && !config.prev) {
            found = true;
        }
        const start = config.prev ? this.fieldViews.length - 1 : 0;
        const end = config.prev ? -1 : this.fieldViews.length;
        const inc = config.prev ? -1 : 1;
        for (let i = start; i !== end; i += inc) {
            const fieldView = this.fieldViews[i];
            if (fieldView.model.name === config.field) {
                found = true;
            } else if (found && !fieldView.readonly && !fieldView.isHidden()) {
                nextFieldView = fieldView;
                break;
            }
        }
        if (nextFieldView) {
            nextFieldView.edit();
        }
    }

    showHistory(): void {
        this.removeSubView();
        const subView = new (DetailsHistoryView as any)(this.model, {
            parent: this.scroller[0],
            replace: true
        });
        this.listenTo(subView, 'close', this.historyClosed.bind(this));
        subView.render();
        this.pageResized();
        (this as any).views.sub = subView;
    }

    historyClosed(e: any): void {
        if (e.updated) {
            this.entryUpdated();
        } else {
            this.render();
        }
    }

    moveToTrash(): void {
        const doMove = () => {
            this.model.moveToTrash();
            Events.emit('refresh');
        };
        if (features.isMobile) {
            alerts.yesno({
                header: loc.detDelToTrash,
                body: loc.detDelToTrashBody,
                icon: 'trash-alt',
                success: doMove
            });
        } else {
            doMove();
        }
    }

    clone(): void {
        const newEntry = this.model.cloneEntry(' ' + loc.detClonedName);
        Events.emit('select-entry', newEntry);
    }

    copyToClipboard(): void {
        copyPaste.copyHtml(this.model.getHtml());
    }

    deleteFromTrash(): void {
        alerts.yesno({
            header: loc.detDelFromTrash,
            body: loc.detDelFromTrashBody,
            hint: loc.detDelFromTrashBodyHint,
            icon: 'minus-circle',
            success: () => {
                this.model.deleteFromTrash();
                Events.emit('refresh');
            }
        });
    }

    backClick(): void {
        Events.emit('toggle-details', false);
    }

    contextMenu(e: any): void {
        const canCopy = document.queryCommandSupported('copy');
        const options: any[] = [];
        if (canCopy) {
            options.push({
                value: 'det-copy-password',
                icon: 'copy',
                text: loc.detMenuCopyPassword
            });
            options.push({
                value: 'det-copy-user',
                icon: 'copy',
                text: loc.detMenuCopyUser
            });
        }
        if (typeof navigator.share === 'function') {
            options.push({
                value: 'det-share-password',
                icon: 'share-alt',
                text: 'Share Password'
            });
        }
        options.push({ value: 'det-add-new', icon: 'plus', text: loc.detMenuAddNewField });
        options.push({ value: 'det-clone', icon: 'clone', text: loc.detClone });
        if (canCopy) {
            options.push({
                value: 'copy-to-clipboard',
                icon: 'clipboard',
                text: loc.detCopyEntryToClipboard
            });
        }
        Events.emit('show-context-menu', Object.assign(e, { options }));
    }

    contextMenuSelect(e: any): void {
        switch (e.item) {
            case 'det-copy-password':
                this.copyPassword();
                break;
            case 'det-copy-user':
                this.copyUserName();
                break;
            case 'det-share-password':
                this.sharePassword();
                break;
            case 'det-add-new':
                this.addNewField();
                break;
            case 'det-clone':
                this.clone();
                break;
            case 'copy-to-clipboard':
                this.copyToClipboard();
                break;
        }
    }

    sharePassword(): void {
        if (!this.model) {
            return;
        }
        const passwordField = this.getFieldView('$Password');
        if (!passwordField) {
            return;
        }
        const text = passwordField.getTextValue();
        if (!text) {
            return;
        }
        navigator
            .share({
                title: this.model.title || 'Password',
                text
            })
            .catch((err: DOMException) => {
                if (err.name !== 'AbortError') {
                    this.copyPassword();
                }
            });
    }

    setupOtp(): void {
        otpQrReader.read();
    }

    otpCodeRead(otp: any): void {
        this.model.setOtp(otp);
        this.entryUpdated();
    }

    otpEnterManually(): void {
        if (this.model.fields.otp) {
            const otpField = this.fieldViews.find((f: any) => f.model.name === '$otp');
            if (otpField) {
                otpField.edit();
            }
        } else {
            this.moreView.remove();
            this.moreView = null;
            const fieldView = new (FieldViewCustom as any)(
                {
                    name: '$otp',
                    title: 'otp',
                    newField: 'otp',
                    value: kdbxweb.ProtectedValue.fromString('')
                },
                {
                    parent: this.$el.find('.details__body-fields')[0]
                }
            );
            fieldView.on('change', this.fieldChanged.bind(this));
            fieldView.render();
            fieldView.edit();
            this.fieldViews.push(fieldView);
        }
    }

    toggleAutoType(): void {
        // No-op: auto-type removed in web-only fork
    }

    checkPasswordIssues(): void {
        if (!this.model.readOnly) {
            (this as any).views.issues = new (DetailsIssuesView as any)(this.model);
            (this as any).views.issues.render();
        }
    }

    copyFieldValue(e: any): void {
        this.fieldCopied(e);
    }
}

Object.assign(DetailsView.prototype, Scrollable);
Object.assign(DetailsView.prototype, Copyable);

export { DetailsView };
