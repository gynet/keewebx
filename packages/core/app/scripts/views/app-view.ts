/* eslint-disable @typescript-eslint/no-explicit-any */
import { View } from 'framework/views/view';
import { Events } from 'framework/events';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { SettingsManager } from 'comp/settings/settings-manager';
import { Alerts } from 'comp/ui/alerts';
import { Keys } from 'const/keys';
import { UpdateModel } from 'models/update-model';
import { Features } from 'util/features';
import { Locale } from 'util/locale';
import { Logger } from 'util/logger';
import { CsvParser } from 'util/data/csv-parser';
import { DetailsView } from 'views/details/details-view';
import { DragView } from 'views/drag-view';
import { DropdownView } from 'views/dropdown-view';
import { FooterView } from 'views/footer-view';
import { GeneratorPresetsView } from 'views/generator-presets-view';
import { GrpView } from 'views/grp-view';
import { KeyChangeView } from 'views/key-change-view';
import { ListView } from 'views/list-view';
import { ListWrapView } from 'views/list-wrap-view';
import { MenuView } from 'views/menu/menu-view';
import { OpenView } from 'views/open-view';
import { SettingsView } from 'views/settings/settings-view';
import { TagView } from 'views/tag-view';
import { ImportCsvView } from 'views/import-csv-view';
import { TitlebarView } from 'views/titlebar-view';
import template from 'templates/app.hbs';

const loc = Locale as unknown as Record<string, any>;
const features = Features as unknown as {
    isMobile: boolean;
    browserCssClass: string;
    renderCustomTitleBar: boolean;
};
const alerts = Alerts as unknown as {
    alert(opts: any): void;
    error(opts: any): void;
    alertDisplayed: boolean;
    buttons: { ok: any; cancel: any };
};
const settingsManager = SettingsManager as unknown as {
    setTheme(theme: string): void;
    setFontSize(size: number): void;
    setLocale(loc: string): void;
};
const idleTracker = IdleTracker as unknown as { regUserAction(): void };
const updateModel = UpdateModel as unknown as { updateStatus: string };

class AppView extends View {
    parent = 'body';

    template = template;

    events: Record<string, string> = {
        contextmenu: 'contextMenu',
        drop: 'drop',
        dragenter: 'dragover',
        dragover: 'dragover',
        'click a[target=_blank]': 'extLinkClick',
        mousedown: 'bodyClick'
    };

    titlebarStyle = 'default';
    panelEl: any;
    autoSaveTimer?: ReturnType<typeof setInterval>;

    constructor(model: any) {
        super(model);

        this.titlebarStyle = this.model.settings.titlebarStyle;

        const views = (this as any).views;
        views.menu = new (MenuView as any)(this.model.menu, { ownParent: true });
        views.menuDrag = new (DragView as any)('x', { parent: '.app__menu-drag' });
        views.footer = new (FooterView as any)(this.model, { ownParent: true });
        views.listWrap = new (ListWrapView as any)(this.model, { ownParent: true });
        views.list = new (ListView as any)(this.model, { ownParent: true });
        views.listDrag = new (DragView as any)('x', { parent: '.app__list-drag' });
        views.list.dragView = views.listDrag;
        views.details = new (DetailsView as any)(undefined, { ownParent: true });
        views.details.appModel = this.model;
        if (this.titlebarStyle !== 'default' && features.renderCustomTitleBar) {
            views.titlebar = new (TitlebarView as any)(this.model);
        }

        views.menu.listenDrag(views.menuDrag);
        views.list.listenDrag(views.listDrag);

        this.listenTo(this.model.settings, 'change:theme', this.setTheme);
        this.listenTo(this.model.settings, 'change:locale', this.setLocale);
        this.listenTo(this.model.settings, 'change:fontSize', this.setFontSize);
        this.listenTo(this.model.settings, 'change:autoSaveInterval', this.setupAutoSave);
        this.listenTo(this.model.settings, 'change:tagStyle', () => this.model._tagsChanged());
        this.listenTo(this.model.files, 'change', this.fileListUpdated);

        this.listenTo(Events, 'select-all', this.selectAll);
        this.listenTo(Events, 'menu-select', this.menuSelect);
        this.listenTo(Events, 'lock-workspace', this.lockWorkspace);
        this.listenTo(Events, 'show-file', this.showFileSettings);
        this.listenTo(Events, 'open-file', this.toggleOpenFile);
        this.listenTo(Events, 'save-all', this.saveAll);
        this.listenTo(Events, 'remote-key-changed', this.remoteKeyChanged);
        this.listenTo(Events, 'key-change-pending', this.keyChangePending);
        this.listenTo(Events, 'toggle-settings', this.toggleSettings);
        this.listenTo(Events, 'toggle-menu', this.toggleMenu);
        this.listenTo(Events, 'toggle-details', this.toggleDetails);
        this.listenTo(Events, 'show-open-view', this.showOpenIfNotThere);
        this.listenTo(Events, 'edit-group', this.editGroup);
        this.listenTo(Events, 'edit-tag', this.editTag);
        this.listenTo(Events, 'edit-generator-presets', this.editGeneratorPresets);
        this.listenTo(Events, 'launcher-open-file', this.launcherOpenFile);
        this.listenTo(Events, 'user-idle', this.userIdle);
        this.listenTo(Events, 'os-lock', this.osLocked);
        this.listenTo(Events, 'power-monitor-suspend', this.osLocked);
        this.listenTo(Events, 'app-minimized', this.appMinimized);
        this.listenTo(Events, 'show-context-menu', this.showContextMenu);
        this.listenTo(Events, 'second-instance', this.showSingleInstanceAlert);
        this.listenTo(Events, 'enter-full-screen', this.enterFullScreen);
        this.listenTo(Events, 'leave-full-screen', this.leaveFullScreen);
        this.listenTo(Events, 'import-csv-requested', this.showImportCsv);

        this.listenTo(UpdateModel, 'change:updateReady', this.updateApp);

        window.onbeforeunload = this.beforeUnload.bind(this) as any;
        window.onresize = this.windowResize.bind(this);
        window.onblur = this.windowBlur.bind(this) as any;

        this.onKey(Keys.DOM_VK_ESCAPE, this.escPressed);
        this.onKey(Keys.DOM_VK_BACK_SPACE, this.backspacePressed);

        this.setWindowClass();
        this.setupAutoSave();
    }

    setWindowClass(): void {
        const browserCssClass = features.browserCssClass;
        if (browserCssClass) {
            document.body.classList.add(browserCssClass);
        }
        if (this.titlebarStyle !== 'default') {
            document.body.classList.add('titlebar-' + this.titlebarStyle);
            if (features.renderCustomTitleBar) {
                document.body.classList.add('titlebar-custom');
            }
        }
        if (features.isMobile) {
            document.body.classList.add('mobile');
        }
    }

    render(): this | undefined {
        super.render({
            beta: this.model.isBeta,
            titlebarStyle: this.titlebarStyle,
            customTitlebar: features.renderCustomTitleBar
        });
        this.panelEl = this.$el.find('.app__panel:first');
        const views = (this as any).views;
        views.listWrap.render();
        views.menu.render();
        views.menuDrag.render();
        views.footer.render();
        views.list.render();
        views.listDrag.render();
        views.details.render();
        views.titlebar?.render();
        this.showLastOpenFile();
        return this;
    }

    showOpenFile(): void {
        this.hideContextMenu();
        const views = (this as any).views;
        views.menu.hide();
        views.menuDrag.$el.parent().hide();
        views.listWrap.hide();
        views.list.hide();
        views.listDrag.hide();
        views.details.hide();
        views.footer.toggle(this.model.files.hasOpenFiles());
        this.hidePanelView();
        this.hideSettings();
        this.hideOpenFile();
        this.hideKeyChange();
        this.hideImportCsv();
        views.open = new (OpenView as any)(this.model);
        views.open.render();
        views.open.on('close', () => {
            this.showEntries();
        });
    }

    showLastOpenFile(): void {
        this.showOpenFile();
        const lastOpenFile = this.model.fileInfos[0];
        if (lastOpenFile) {
            const views = (this as any).views;
            views.open.currentSelectedIndex = 0;
            views.open.showOpenFileInfo(lastOpenFile);
        }
    }

    launcherOpenFile(file: any): void {
        if (file && file.data && /\.kdbx$/i.test(file.data)) {
            this.showOpenFile();
            (this as any).views.open.showOpenLocalFile(file.data, file.key);
        }
    }

    updateApp(): void {
        if (updateModel.updateStatus === 'ready' && !this.model.files.hasOpenFiles()) {
            window.location.reload();
        }
    }

    showEntries(): void {
        const views = (this as any).views;
        views.menu.show();
        views.menuDrag.$el.parent().show();
        views.listWrap.show();
        views.listDrag.show();
        views.details.show();
        views.footer.show();
        this.hidePanelView();
        this.hideOpenFile();
        this.hideSettings();
        this.hideKeyChange();
        this.hideImportCsv();

        views.list.show();
    }

    hideOpenFile(): void {
        const views = (this as any).views;
        if (views.open) {
            views.open.remove();
            views.open = null;
        }
    }

    hidePanelView(): void {
        const views = (this as any).views;
        if (views.panel) {
            views.panel.remove();
            views.panel = null;
            this.panelEl.addClass('hide');
        }
    }

    showPanelView(view: any): void {
        const views = (this as any).views;
        views.listWrap.hide();
        views.list.hide();
        views.listDrag.hide();
        views.details.hide();
        this.hidePanelView();
        view.render();
        views.panel = view;
        this.panelEl.removeClass('hide');
    }

    hideSettings(): void {
        const views = (this as any).views;
        if (views.settings) {
            this.model.menu.setMenu('app');
            views.settings.remove();
            views.settings = null;
        }
    }

    hideKeyChange(): void {
        const views = (this as any).views;
        if (views.keyChange) {
            views.keyChange.hide();
            views.keyChange = null;
        }
    }

    hideImportCsv(): void {
        const views = (this as any).views;
        if (views.importCsv) {
            views.importCsv.remove();
            views.importCsv = null;
        }
    }

    showSettings(selectedMenuItem?: any): void {
        const views = (this as any).views;
        this.model.menu.setMenu('settings');
        views.menu.show();
        views.menuDrag.$el.parent().show();
        views.listWrap.hide();
        views.list.hide();
        views.listDrag.hide();
        views.details.hide();
        this.hidePanelView();
        this.hideOpenFile();
        this.hideKeyChange();
        this.hideImportCsv();
        views.settings = new (SettingsView as any)(this.model);
        views.settings.render();
        if (!selectedMenuItem) {
            selectedMenuItem = this.model.menu.generalSection.items[0];
        }
        this.model.menu.select({ item: selectedMenuItem });
        views.menu.switchVisibility(false);
    }

    showEditGroup(group: any): void {
        this.showPanelView(new (GrpView as any)(group));
    }

    showEditTag(): void {
        this.showPanelView(new (TagView as any)(this.model));
    }

    showKeyChange(file: any, viewConfig: any): void {
        if (alerts.alertDisplayed) {
            return;
        }
        const views = (this as any).views;
        if (views.keyChange && views.keyChange.model.remote) {
            return;
        }
        this.hideSettings();
        this.hidePanelView();
        views.menu.hide();
        views.listWrap.hide();
        views.list.hide();
        views.listDrag.hide();
        views.details.hide();
        views.keyChange = new (KeyChangeView as any)({
            file,
            expired: viewConfig.expired,
            remote: viewConfig.remote
        });
        views.keyChange.render();
        views.keyChange.on('accept', this.keyChangeAccept.bind(this));
        views.keyChange.on('cancel', this.showEntries.bind(this));
    }

    fileListUpdated(): void {
        if (this.model.files.hasOpenFiles()) {
            this.showEntries();
        } else {
            this.showOpenFile();
            this.selectLastOpenFile();
        }
    }

    showFileSettings(_e: any): void {
        const menuItem = this.model.menu.fileSettingsSection.items[0];
        if (!menuItem) return;
        const views = (this as any).views;
        if (views.settings) {
            if ((views.settings as any).file === (menuItem as any).file) {
                this.showEntries();
            } else {
                this.model.menu.select({ item: menuItem });
            }
        } else {
            this.showSettings(menuItem);
        }
    }

    toggleOpenFile(): void {
        const views = (this as any).views;
        if (views.open) {
            if (this.model.files.hasOpenFiles()) {
                this.showEntries();
            }
        } else {
            this.showOpenFile();
        }
    }

    beforeUnload(_e?: any): boolean | string | undefined {
        const exitEvent: any = {
            preventDefault() {
                this.prevented = true;
            }
        };
        Events.emit('main-window-will-close', exitEvent);
        if (exitEvent.prevented) {
            return false;
        }

        if (this.model.files.hasDirtyFiles()) {
            return loc.appUnsavedWarnBody;
        }
        return undefined;
    }

    windowResize(): void {
        Events.emit('page-geometry', { source: 'window' });
    }

    windowBlur(e: any): void {
        if (e.target === window) {
            Events.emit('page-blur');
        }
    }

    enterFullScreen(): void {
        this.$el.addClass('fullscreen');
    }

    leaveFullScreen(): void {
        this.$el.removeClass('fullscreen');
    }

    escPressed(): void {
        const views = (this as any).views;
        if (views.open && this.model.files.hasOpenFiles()) {
            this.showEntries();
        }
    }

    backspacePressed(e: any): void {
        if (e.target === document.body) {
            e.preventDefault();
        }
    }

    selectAll(): void {
        this.menuSelect({ item: this.model.menu.allItemsSection.items[0] });
    }

    menuSelect(opt: any): void {
        this.model.menu.select(opt);
        const views = (this as any).views;
        if (views.panel && !views.panel.isHidden()) {
            this.showEntries();
        }
    }

    userIdle(): void {
        this.lockWorkspace(true);
    }

    osLocked(): void {
        if (this.model.settings.lockOnOsLock) {
            this.lockWorkspace(true);
        }
    }

    appMinimized(): void {
        if (this.model.settings.lockOnMinimize) {
            this.lockWorkspace(true);
        }
    }

    lockWorkspace(autoInit?: boolean): void {
        if (alerts.alertDisplayed) {
            return;
        }
        if (this.model.files.hasUnsavedFiles()) {
            if (this.model.settings.autoSave) {
                this.saveAndLock();
            } else {
                const message = autoInit ? loc.appCannotLockAutoInit : loc.appCannotLock;
                alerts.alert({
                    icon: 'lock',
                    header: 'Lock',
                    body: message,
                    buttons: [
                        { result: 'save', title: loc.saveChanges },
                        { result: 'discard', title: loc.discardChanges, error: true },
                        { result: '', title: loc.alertCancel }
                    ],
                    checkbox: loc.appAutoSave,
                    success: (result: string, autoSaveChecked: boolean) => {
                        if (result === 'save') {
                            if (autoSaveChecked) {
                                this.model.settings.autoSave = autoSaveChecked;
                            }
                            this.saveAndLock();
                        } else if (result === 'discard') {
                            this.model.closeAllFiles();
                        }
                    }
                });
            }
        } else {
            this.closeAllFilesAndShowFirst();
        }
    }

    saveAndLock(complete?: (ok: boolean) => void, options?: any): void {
        let pendingCallbacks = 0;
        const errorFiles: string[] = [];
        const self = this;
        this.model.files.forEach(function (this: AppView, file: any) {
            if (!file.dirty) {
                return;
            }
            this.model.syncFile(file, null, fileSaved.bind(this, file));
            pendingCallbacks++;
        }, this);
        if (!pendingCallbacks) {
            this.closeAllFilesAndShowFirst();
        }
        function fileSaved(this: AppView, file: any, err: any) {
            if (err) {
                errorFiles.push(file.name);
            }
            if (--pendingCallbacks === 0) {
                if (errorFiles.length && self.model.files.hasDirtyFiles()) {
                    if (!alerts.alertDisplayed) {
                        const buttons: any[] = [alerts.buttons.ok];
                        const errorStr =
                            errorFiles.length > 1
                                ? loc.appSaveErrorBodyMul
                                : loc.appSaveErrorBody;
                        let body = errorStr + ' ' + errorFiles.join(', ') + '.';
                        if (options?.appClosing) {
                            buttons.unshift({
                                result: 'ignore',
                                title: loc.appSaveErrorExitLoseChanges,
                                error: true
                            });
                            body += '\n' + loc.appSaveErrorExitLoseChangesBody;
                        }
                        alerts.error({
                            header: loc.appSaveError,
                            body,
                            buttons,
                            complete: (res: string) => {
                                if (res === 'ignore') {
                                    self.model.closeAllFiles();
                                    if (complete) {
                                        complete(true);
                                    }
                                } else {
                                    if (complete) {
                                        complete(false);
                                    }
                                }
                            }
                        });
                    } else {
                        if (complete) {
                            complete(false);
                        }
                    }
                } else {
                    self.closeAllFilesAndShowFirst();
                    if (complete) {
                        complete(true);
                    }
                }
            }
        }
    }

    closeAllFilesAndShowFirst(): void {
        if (!this.model.files.hasOpenFiles()) {
            return;
        }
        let fileToShow = this.model.files.find(
            (file: any) => !file.demo && !file.created && !file.skipOpenList
        );
        this.model.closeAllFiles();
        if (!fileToShow) {
            fileToShow = this.model.fileInfos[0];
        }
        if (fileToShow) {
            const fileInfo = this.model.fileInfos.getMatch(
                fileToShow.storage,
                fileToShow.name,
                fileToShow.path
            );
            if (fileInfo) {
                (this as any).views.open.showOpenFileInfo(fileInfo);
            }
        }
    }

    selectLastOpenFile(): void {
        const fileToShow = this.model.fileInfos[0];
        if (fileToShow) {
            (this as any).views.open.showOpenFileInfo(fileToShow);
        }
    }

    saveAll(): void {
        this.model.files.forEach(function (this: AppView, file: any) {
            this.model.syncFile(file);
        }, this);
    }

    setupAutoSave(): void {
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
        }
        if (this.model.settings.autoSaveInterval > 0) {
            this.autoSaveTimer = setInterval(
                this.saveAll.bind(this),
                this.model.settings.autoSaveInterval * 1000 * 60
            );
        }
    }

    remoteKeyChanged(e: any): void {
        this.showKeyChange(e.file, { remote: true });
    }

    keyChangePending(e: any): void {
        this.showKeyChange(e.file, { expired: true });
    }

    keyChangeAccept(e: any): void {
        this.showEntries();
        if (e.expired) {
            e.file.setPassword(e.password);
            if (e.keyFileData && e.keyFileName) {
                e.file.setKeyFile(e.keyFileData, e.keyFileName);
            } else {
                e.file.removeKeyFile();
            }
        } else {
            this.model.syncFile(e.file, {
                remoteKey: {
                    password: e.password,
                    keyFileName: e.keyFileName,
                    keyFileData: e.keyFileData
                }
            });
        }
    }

    toggleSettings(page?: string, section?: string): void {
        let menuItem = page ? this.model.menu[page + 'Section'] : null;
        if (menuItem) {
            if (section) {
                menuItem =
                    menuItem.items.find((it: any) => it.section === section) || menuItem.items[0];
            } else {
                menuItem = menuItem.items[0];
            }
        }
        const views = (this as any).views;
        if (views.settings) {
            if (views.settings.page === page || !menuItem) {
                if (this.model.files.hasOpenFiles()) {
                    this.showEntries();
                } else {
                    this.showLastOpenFile();
                    views.open.toggleMore();
                }
            } else {
                this.model.menu.select({ item: menuItem });
            }
        } else {
            this.showSettings();
            if (menuItem) {
                this.model.menu.select({ item: menuItem });
            }
        }
    }

    toggleMenu(): void {
        (this as any).views.menu.switchVisibility();
    }

    toggleDetails(visible: boolean): void {
        this.$el.toggleClass('app--details-visible', visible);
        (this as any).views.menu.switchVisibility(false);
    }

    showOpenIfNotThere(): void {
        if (!(this as any).views.open) {
            this.showLastOpenFile();
        }
    }

    editGroup(group: any): void {
        const views = (this as any).views;
        if (group && !(views.panel instanceof GrpView)) {
            this.showEditGroup(group);
        } else {
            this.showEntries();
        }
    }

    editTag(tag: any): void {
        const views = (this as any).views;
        if (tag && !(views.panel instanceof TagView)) {
            this.showEditTag();
            views.panel.showTag(tag);
        } else {
            this.showEntries();
        }
    }

    editGeneratorPresets(): void {
        const views = (this as any).views;
        if (!(views.panel instanceof GeneratorPresetsView)) {
            if (views.settings) {
                this.showEntries();
            }
            this.showPanelView(new (GeneratorPresetsView as any)(this.model));
        } else {
            this.showEntries();
        }
    }

    isContextMenuAllowed(e: any): boolean {
        return ['input', 'textarea'].indexOf(e.target.tagName.toLowerCase()) < 0;
    }

    contextMenu(e: any): void {
        if (this.isContextMenuAllowed(e)) {
            e.preventDefault();
        }
    }

    showContextMenu(e: any): void {
        if (e.options && this.isContextMenuAllowed(e)) {
            e.stopImmediatePropagation();
            e.preventDefault();
            const views = (this as any).views;
            if (views.contextMenu) {
                views.contextMenu.remove();
            }
            const menu = new (DropdownView as any)(e);
            menu.render({
                position: { left: e.pageX, top: e.pageY },
                options: e.options
            });
            menu.on('cancel', (_evt: any) => this.hideContextMenu());
            menu.on('select', (evt: any) => this.contextMenuSelect(evt));
            views.contextMenu = menu;
        }
    }

    hideContextMenu(): void {
        const views = (this as any).views;
        if (views.contextMenu) {
            views.contextMenu.remove();
            delete views.contextMenu;
        }
    }

    contextMenuSelect(e: any): void {
        this.hideContextMenu();
        Events.emit('context-menu-select', e);
    }

    showSingleInstanceAlert(): void {
        this.hideOpenFile();
        alerts.error({
            header: loc.appTabWarn,
            body: loc.appTabWarnBody,
            esc: false,
            enter: false,
            click: false,
            buttons: []
        });
    }

    dragover(e: any): void {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'none';
    }

    drop(e: any): void {
        e.preventDefault();
    }

    setTheme(): void {
        settingsManager.setTheme(this.model.settings.theme);
    }

    setFontSize(): void {
        settingsManager.setFontSize(this.model.settings.fontSize);
    }

    setLocale(): void {
        settingsManager.setLocale(this.model.settings.locale);
        const views = (this as any).views;
        if (views.settings.isVisible()) {
            this.hideSettings();
            this.showSettings();
        }
        this.$el.find('.app__beta:first').text(loc.appBeta);
    }

    extLinkClick(_e: any): void {
        // Links with target=_blank open in new tab by default in web
    }

    bodyClick(e: any): void {
        idleTracker.regUserAction();
        Events.emit('click', e);
    }

    showImportCsv(file: any): void {
        const reader = new FileReader();
        const logger = new Logger('import-csv');
        logger.info('Reading CSV...');
        reader.onload = (e: ProgressEvent<FileReader>) => {
            logger.info('Parsing CSV...');
            const ts = logger.ts();
            const parser = new CsvParser();
            let data: any;
            try {
                data = parser.parse((e.target as FileReader).result as string);
            } catch (err: any) {
                logger.error('Error parsing CSV', err);
                alerts.error({ header: loc.openFailedRead, body: err.toString() });
                return;
            }
            logger.info(`Parsed CSV: ${data.rows.length} records, ${logger.ts(ts)}`);

            // TODO: refactor this
            this.hideSettings();
            this.hidePanelView();
            this.hideOpenFile();
            this.hideKeyChange();
            const views = (this as any).views;
            views.menu.hide();
            views.listWrap.hide();
            views.list.hide();
            views.listDrag.hide();
            views.details.hide();

            views.importCsv = new (ImportCsvView as any)(data, {
                appModel: this.model,
                fileName: file.name
            });
            views.importCsv.render();
            views.importCsv.on('cancel', () => {
                if (this.model.files.hasOpenFiles()) {
                    this.showEntries();
                } else {
                    this.showOpenFile();
                }
            });
            views.importCsv.on('done', () => {
                this.model.refresh();
                this.showEntries();
            });
        };
        reader.onerror = () => {
            alerts.error({ header: loc.openFailedRead });
        };
        reader.readAsText(file);
    }
}

export { AppView };
