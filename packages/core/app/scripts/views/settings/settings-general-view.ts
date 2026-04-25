/* eslint-disable @typescript-eslint/no-explicit-any */
import { Events } from 'framework/events';
import { View } from 'framework/views/view';
import { Storage } from 'storage';
import { RuntimeInfo } from 'const/runtime-info';
import { SettingsManager } from 'comp/settings/settings-manager';
import { Alerts } from 'comp/ui/alerts';
import { Links } from 'const/links';
import { AppSettingsModel } from 'models/app-settings-model';
import { UpdateModel } from 'models/update-model';
import { SemVer } from 'util/data/semver';
import { Features } from 'util/features';
import { DateFormat } from 'comp/i18n/date-format';
import { Locale } from 'util/locale';
import { SettingsLogsView } from 'views/settings/settings-logs-view';
import { SettingsPrvView } from 'views/settings/settings-prv-view';
import { mapObject, minmax } from 'util/fn';
import { ThemeWatcher } from 'comp/browser/theme-watcher';
import template from 'templates/settings/settings-general.hbs';

const loc = Locale as unknown as Record<string, any>;
const links = Links as unknown as Record<string, string | undefined>;
const settings = AppSettingsModel as unknown as Record<string, any> & {
    set(changes: Record<string, any>): void;
};
const updateModel = UpdateModel as unknown as Record<string, any>;
const features = Features as unknown as {
    isMobile: boolean;
    isStandalone: boolean;
    supportsTitleBarStyles: boolean;
    supportsCustomTitleBarAndDraggableWindow: boolean;
};
const settingsManager = SettingsManager as unknown as {
    activeTheme: string;
    allLocales: Record<string, string>;
    activeLocale: string;
    allThemes: Record<string, string>;
    autoSwitchedThemes: { dark: string; light: string; name: string }[];
    setTheme(theme: string): void;
    darkModeChanged(): void;
};
const themeWatcher = ThemeWatcher as unknown as { dark: boolean };
const alerts = Alerts as unknown as { info(opts: any): void };

interface StorageProviderInfo {
    name: string;
    enabled: boolean;
    hasConfig: boolean;
    loggedIn: boolean;
}

class SettingsGeneralView extends View {
    template = template;

    appModel: any;

    events: Record<string, string> = {
        'click .settings__general-theme': 'changeTheme',
        'click .settings__general-auto-switch-theme': 'changeAuthSwitchTheme',
        'change .settings__general-locale': 'changeLocale',
        'change .settings__general-font-size': 'changeFontSize',
        'change .settings__general-expand': 'changeExpandGroups',
        'change .settings__general-auto-update': 'changeAutoUpdate',
        'change .settings__general-idle-minutes': 'changeIdleMinutes',
        'change .settings__general-clipboard': 'changeClipboard',
        'change .settings__general-auto-save': 'changeAutoSave',
        'change .settings__general-auto-save-interval': 'changeAutoSaveInterval',
        'change .settings__general-remember-key-files': 'changeRememberKeyFiles',
        'change .settings__general-minimize': 'changeMinimize',
        'change .settings__general-minimize-on-field-copy': 'changeMinimizeOnFieldCopy',
        'change .settings__general-audit-passwords': 'changeAuditPasswords',
        'change .settings__general-audit-password-entropy': 'changeAuditPasswordEntropy',
        'change .settings__general-exclude-pins-from-audit': 'changeExcludePinsFromAudit',
        'change .settings__general-check-passwords-on-hibp': 'changeCheckPasswordsOnHIBP',
        'click .settings__general-toggle-help-hibp': 'clickToggleHelpHIBP',
        'change .settings__general-audit-password-age': 'changeAuditPasswordAge',
        'change .settings__general-lock-on-minimize': 'changeLockOnMinimize',
        'change .settings__general-lock-on-copy': 'changeLockOnCopy',
        'change .settings__general-lock-on-auto-type': 'changeLockOnAutoType',
        'change .settings__general-lock-on-os-lock': 'changeLockOnOsLock',
        'change .settings__general-table-view': 'changeTableView',
        'change .settings__general-colorful-icons': 'changeColorfulIcons',
        'change .settings__general-large-list-icons': 'changeLargeListIcons',
        'change .settings__general-show-favicons': 'changeShowFavicons',
        'change .settings__general-tag-style': 'changeTagStyle',
        'change .settings__general-use-markdown': 'changeUseMarkdown',
        'change .settings__general-use-group-icon-for-entries': 'changeUseGroupIconForEntries',
        'change .settings__general-direct-autotype': 'changeDirectAutotype',
        'change .settings__general-autotype-title-filter': 'changeAutoTypeTitleFilter',
        'change .settings__general-field-label-dblclick-autotype':
            'changeFieldLabelDblClickAutoType',
        'change .settings__general-device-owner-auth': 'changeDeviceOwnerAuth',
        'change .settings__general-device-owner-auth-timeout': 'changeDeviceOwnerAuthTimeout',
        'change .settings__general-titlebar-style': 'changeTitlebarStyle',
        'click .settings__general-update-btn': 'checkUpdate',
        'click .settings__general-restart-btn': 'installUpdateAndRestart',
        'click .settings__general-download-update-btn': 'downloadUpdate',
        'click .settings__general-update-found-btn': 'installFoundUpdate',
        'change .settings__general-disable-offline-storage': 'changeDisableOfflineStorage',
        'change .settings__general-short-lived-storage-token': 'changeShortLivedStorageToken',
        'change .settings__general-save-verify': 'changeSaveVerify',
        'change .settings__general-hires-favicons': 'changeHiresFavicons',
        'change .settings__general-prv-check': 'changeStorageEnabled',
        'click .settings__general-prv-logout': 'logoutFromStorage',
        'click .settings__general-show-advanced': 'showAdvancedSettings',
        'click .settings__general-dev-tools-link': 'openDevTools',
        'click .settings__general-try-beta-link': 'tryBeta',
        'click .settings__general-show-logs-link': 'showLogs',
        'click .settings__general-reload-app-link': 'reloadApp'
    };

    constructor(model: any, options?: any) {
        super(model, options);
        this.listenTo(UpdateModel as any, 'change', this.render);
        this.listenTo(Events, 'theme-applied', this.render);
    }

    render(): this | undefined {
        const updateReady = updateModel.updateStatus === 'ready';
        const updateFound = updateModel.updateStatus === 'found';
        const updateManual = updateModel.updateManual;
        const storageProviders = this.getStorageProviders();

        super.render({
            themes: this.getAllThemes(),
            autoSwitchTheme: settings.autoSwitchTheme,
            activeTheme: settingsManager.activeTheme,
            locales: settingsManager.allLocales,
            activeLocale: settingsManager.activeLocale,
            fontSize: settings.fontSize,
            expandGroups: settings.expandGroups,
            canClearClipboard: false,
            clipboardSeconds: settings.clipboardSeconds,
            rememberKeyFiles: settings.rememberKeyFiles,
            supportFiles: false,
            autoSave: settings.autoSave,
            autoSaveInterval: settings.autoSaveInterval,
            idleMinutes: settings.idleMinutes,
            minimizeOnClose: settings.minimizeOnClose,
            minimizeOnFieldCopy: settings.minimizeOnFieldCopy,
            devTools: false,
            canAutoUpdate: false,
            canAutoSaveOnClose: false,
            canMinimize: false,
            canDetectMinimize: false,
            canDetectOsSleep: false,
            canAutoType: false,
            auditPasswords: settings.auditPasswords,
            auditPasswordEntropy: settings.auditPasswordEntropy,
            excludePinsFromAudit: settings.excludePinsFromAudit,
            checkPasswordsOnHIBP: settings.checkPasswordsOnHIBP,
            auditPasswordAge: settings.auditPasswordAge,
            hibpLink: (Links as any).HaveIBeenPwned,
            hibpPrivacyLink: (Links as any).HaveIBeenPwnedPrivacy,
            lockOnMinimize: false,
            lockOnCopy: settings.lockOnCopy,
            lockOnAutoType: settings.lockOnAutoType,
            lockOnOsLock: settings.lockOnOsLock,
            tableView: settings.tableView,
            canSetTableView: !features.isMobile,
            autoUpdate: null,
            updateInProgress: false,
            updateInfo: this.getUpdateInfo(),
            updateWaitingReload: updateReady,
            showUpdateBlock: false,
            updateReady,
            updateFound,
            updateManual,
            releaseNotesLink: (Links as any).ReleaseNotes,
            colorfulIcons: settings.colorfulIcons,
            largeListIcons: settings.largeListIcons,
            showFavicons: settings.showFavicons,
            tagStyle: settings.tagStyle || 'cloud',
            useMarkdown: settings.useMarkdown,
            useGroupIconForEntries: settings.useGroupIconForEntries,
            directAutotype: settings.directAutotype,
            autoTypeTitleFilterEnabled: settings.autoTypeTitleFilterEnabled,
            fieldLabelDblClickAutoType: settings.fieldLabelDblClickAutoType,
            supportsTitleBarStyles: features.supportsTitleBarStyles,
            supportsCustomTitleBarAndDraggableWindow:
                features.supportsCustomTitleBarAndDraggableWindow,
            titlebarStyle: settings.titlebarStyle,
            storageProviders,
            showReloadApp: features.isStandalone,
            hasDeviceOwnerAuth: false,
            deviceOwnerAuth: settings.deviceOwnerAuth,
            deviceOwnerAuthTimeout: settings.deviceOwnerAuthTimeoutMinutes,
            disableOfflineStorage: settings.disableOfflineStorage,
            shortLivedStorageToken: settings.shortLivedStorageToken,
            saveVerify: settings.saveVerify,
            hiresFavicons: settings.hiresFavicons
        });
        this.renderProviderViews(storageProviders);
        return this;
    }

    renderProviderViews(storageProviders: StorageProviderInfo[]): void {
        const self = this as any;
        storageProviders.forEach(function (this: SettingsGeneralView, prv: StorageProviderInfo) {
            if (self.views[prv.name]) {
                self.views[prv.name].remove();
            }
            if (prv.hasConfig) {
                const prvView = new (SettingsPrvView as any)(prv, {
                    parent: self.$el.find('.settings__general-' + prv.name)[0]
                });
                self.views[prv.name] = prvView;
                prvView.render();
            }
        }, this);
    }

    getUpdateInfo(): string {
        switch (updateModel.status) {
            case 'checking':
                return (loc.setGenUpdateChecking as string) + '...';
            case 'error': {
                let errMsg = loc.setGenErrorChecking as string;
                if (updateModel.lastError) {
                    errMsg += ': ' + updateModel.lastError;
                }
                if (updateModel.lastSuccessCheckDate) {
                    errMsg +=
                        '. ' +
                        (loc.setGenLastCheckSuccess as string).replace(
                            '{}',
                            DateFormat.dtStr(updateModel.lastSuccessCheckDate)
                        ) +
                        ': ' +
                        (loc.setGenLastCheckVer as string).replace('{}', updateModel.lastVersion);
                }
                return errMsg;
            }
            case 'ok': {
                let msg =
                    (loc.setGenCheckedAt as string) +
                    ' ' +
                    DateFormat.dtStr(updateModel.lastCheckDate) +
                    ': ';
                const cmp = SemVer.compareVersions(
                    (RuntimeInfo as any).version,
                    updateModel.lastVersion
                );
                if (cmp >= 0) {
                    msg += loc.setGenLatestVer as string;
                } else {
                    msg +=
                        (loc.setGenNewVer as string).replace('{}', updateModel.lastVersion) +
                        ' ' +
                        DateFormat.dStr(updateModel.lastVersionReleaseDate);
                }
                switch (updateModel.updateStatus) {
                    case 'downloading':
                        return msg + '. ' + (loc.setGenDownloadingUpdate as string);
                    case 'extracting':
                        return msg + '. ' + (loc.setGenExtractingUpdate as string);
                    case 'error':
                        return msg + '. ' + (loc.setGenCheckErr as string);
                }
                return msg;
            }
            default:
                return loc.setGenNeverChecked as string;
        }
    }

    getStorageProviders(): StorageProviderInfo[] {
        const storageProviders: any[] = [];
        const storageMap = Storage as unknown as Record<string, any>;
        Object.keys(storageMap).forEach((name) => {
            const prv = storageMap[name];
            if (!prv.system) {
                storageProviders.push(prv);
            }
        });
        storageProviders.sort(
            (x: any, y: any) => (x.uipos || Infinity) - (y.uipos || Infinity)
        );
        return storageProviders.map((sp: any) => ({
            name: sp.name,
            enabled: sp.enabled,
            hasConfig: !!sp.getSettingsConfig,
            loggedIn: sp.loggedIn
        }));
    }

    getAllThemes(): Record<string, string> {
        const { autoSwitchTheme } = settings;
        if (autoSwitchTheme) {
            const themes: Record<string, string> = {};
            const ignoredThemes: Record<string, boolean> = {};
            for (const config of settingsManager.autoSwitchedThemes) {
                ignoredThemes[config.dark] = true;
                ignoredThemes[config.light] = true;
                const activeTheme = themeWatcher.dark ? config.dark : config.light;
                themes[activeTheme] = loc[config.name] as string;
            }
            for (const [th, name] of Object.entries(settingsManager.allThemes)) {
                if (!ignoredThemes[th]) {
                    themes[th] = loc[name as string] as string;
                }
            }
            return themes;
        } else {
            return mapObject(
                settingsManager.allThemes,
                (theme: string) => loc[theme] as string
            ) as Record<string, string>;
        }
    }

    changeTheme(e: any): void {
        const theme = e.target.closest('.settings__general-theme').dataset.theme;
        const changedInSettings = settings.theme !== theme;
        if (changedInSettings) {
            settings.theme = theme;
        } else {
            settingsManager.setTheme(theme);
        }
    }

    changeAuthSwitchTheme(e: any): void {
        const autoSwitchTheme = e.target.checked;
        settings.autoSwitchTheme = autoSwitchTheme;
        settingsManager.darkModeChanged();
        this.render();
    }

    changeLocale(e: any): void {
        settings.locale = e.target.value;
    }

    changeFontSize(e: any): void {
        const fontSize = +e.target.value;
        settings.fontSize = fontSize;
    }

    changeTitlebarStyle(e: any): void {
        const titlebarStyle = e.target.value;
        settings.titlebarStyle = titlebarStyle;
    }

    changeClipboard(e: any): void {
        const clipboardSeconds = +e.target.value;
        settings.clipboardSeconds = clipboardSeconds;
    }

    changeIdleMinutes(e: any): void {
        const idleMinutes = +e.target.value;
        settings.idleMinutes = idleMinutes;
    }

    changeAutoUpdate(): void {
        // No-op: auto-update removed in web-only fork
    }

    checkUpdate(): void {
        // No-op: auto-update removed in web-only fork
    }

    changeAutoSave(e: any): void {
        const autoSave = e.target.checked || false;
        settings.autoSave = autoSave;
    }

    changeAutoSaveInterval(e: any): void {
        const autoSaveInterval = e.target.value | 0;
        settings.autoSaveInterval = autoSaveInterval;
    }

    changeRememberKeyFiles(e: any): void {
        const rememberKeyFiles = e.target.value || false;
        settings.rememberKeyFiles = rememberKeyFiles;
        this.appModel.clearStoredKeyFiles();
    }

    changeMinimize(e: any): void {
        const minimizeOnClose = e.target.checked || false;
        settings.minimizeOnClose = minimizeOnClose;
    }

    changeMinimizeOnFieldCopy(e: any): void {
        const minimizeOnFieldCopy = e.target.checked || false;
        settings.minimizeOnFieldCopy = minimizeOnFieldCopy;
    }

    changeAuditPasswords(e: any): void {
        const auditPasswords = e.target.checked || false;
        settings.auditPasswords = auditPasswords;
    }

    changeAuditPasswordEntropy(e: any): void {
        const auditPasswordEntropy = e.target.checked || false;
        settings.auditPasswordEntropy = auditPasswordEntropy;
    }

    changeExcludePinsFromAudit(e: any): void {
        const excludePinsFromAudit = e.target.checked || false;
        settings.excludePinsFromAudit = excludePinsFromAudit;
    }

    changeCheckPasswordsOnHIBP(e: any): void {
        if (e.target.closest('a')) {
            return;
        }
        const checkPasswordsOnHIBP = e.target.checked || false;
        settings.checkPasswordsOnHIBP = checkPasswordsOnHIBP;
    }

    clickToggleHelpHIBP(): void {
        this.el.querySelector('.settings__general-help-hibp')?.classList.toggle('hide');
    }

    changeAuditPasswordAge(e: any): void {
        const auditPasswordAge = e.target.value | 0;
        settings.auditPasswordAge = auditPasswordAge;
    }

    changeLockOnMinimize(e: any): void {
        const lockOnMinimize = e.target.checked || false;
        settings.lockOnMinimize = lockOnMinimize;
    }

    changeLockOnCopy(e: any): void {
        const lockOnCopy = e.target.checked || false;
        settings.lockOnCopy = lockOnCopy;
    }

    changeLockOnAutoType(e: any): void {
        const lockOnAutoType = e.target.checked || false;
        settings.lockOnAutoType = lockOnAutoType;
    }

    changeLockOnOsLock(e: any): void {
        const lockOnOsLock = e.target.checked || false;
        settings.lockOnOsLock = lockOnOsLock;
    }

    changeTableView(e: any): void {
        const tableView = e.target.checked || false;
        settings.tableView = tableView;
        Events.emit('refresh');
    }

    changeColorfulIcons(e: any): void {
        const colorfulIcons = e.target.checked || false;
        settings.colorfulIcons = colorfulIcons;
        Events.emit('refresh');
    }

    changeLargeListIcons(e: any): void {
        settings.largeListIcons = e.target.checked || false;
        Events.emit('refresh');
    }

    changeShowFavicons(e: any): void {
        settings.showFavicons = e.target.checked || false;
        Events.emit('refresh');
    }

    changeTagStyle(e: any): void {
        settings.tagStyle = e.target.value;
        Events.emit('tags-style-changed');
    }

    changeUseMarkdown(e: any): void {
        const useMarkdown = e.target.checked || false;
        settings.useMarkdown = useMarkdown;
        Events.emit('refresh');
    }

    changeUseGroupIconForEntries(e: any): void {
        const useGroupIconForEntries = e.target.checked || false;
        settings.useGroupIconForEntries = useGroupIconForEntries;
    }

    changeDirectAutotype(e: any): void {
        const directAutotype = e.target.checked || false;
        settings.directAutotype = directAutotype;
    }

    changeAutoTypeTitleFilter(e: any): void {
        const autoTypeTitleFilterEnabled = e.target.checked || false;
        settings.autoTypeTitleFilterEnabled = autoTypeTitleFilterEnabled;
    }

    changeFieldLabelDblClickAutoType(e: any): void {
        const fieldLabelDblClickAutoType = e.target.checked || false;
        settings.fieldLabelDblClickAutoType = fieldLabelDblClickAutoType;
        Events.emit('refresh');
    }

    changeDeviceOwnerAuth(e: any): void {
        const deviceOwnerAuth = e.target.value || null;

        let deviceOwnerAuthTimeoutMinutes = (settings.deviceOwnerAuthTimeoutMinutes as number) | 0;
        if (deviceOwnerAuth) {
            const timeouts: Record<string, [number, number]> = {
                memory: [30, 10080],
                file: [30, 525600]
            };
            const [tMin, tMax] = timeouts[deviceOwnerAuth] || [0, 0];
            deviceOwnerAuthTimeoutMinutes = minmax(deviceOwnerAuthTimeoutMinutes, tMin, tMax);
        }

        settings.set({ deviceOwnerAuth, deviceOwnerAuthTimeoutMinutes });
        this.render();

        this.appModel.checkEncryptedPasswordsStorage();
    }

    changeDeviceOwnerAuthTimeout(e: any): void {
        const deviceOwnerAuthTimeout = e.target.value | 0;
        settings.deviceOwnerAuthTimeoutMinutes = deviceOwnerAuthTimeout;
    }

    installUpdateAndRestart(): void {
        window.location.reload();
    }

    downloadUpdate(): void {
        window.open((Links as any).Desktop);
    }

    installFoundUpdate(): void {
        // No-op: auto-update removed in web-only fork
    }

    changeExpandGroups(e: any): void {
        const expand = e.target.checked;
        settings.expandGroups = expand;
        Events.emit('refresh');
    }

    changeDisableOfflineStorage(e: any): void {
        const disableOfflineStorage = e.target.checked;
        settings.disableOfflineStorage = disableOfflineStorage;
        if (disableOfflineStorage) {
            this.appModel.deleteAllCachedFiles();
        }
    }

    changeShortLivedStorageToken(e: any): void {
        const shortLivedStorageToken = e.target.checked;
        settings.shortLivedStorageToken = shortLivedStorageToken;
        if (shortLivedStorageToken) {
            for (const storage of Object.values(Storage as unknown as Record<string, any>)) {
                (storage as any).deleteStoredToken();
            }
        }
    }

    changeSaveVerify(e: any): void {
        settings.saveVerify = !!e.target.checked;
    }

    changeHiresFavicons(e: any): void {
        settings.hiresFavicons = !!e.target.checked;
    }

    changeStorageEnabled(e: any): void {
        const storageMap = Storage as unknown as Record<string, any>;
        const storage = storageMap[$(e.target).data('storage')];
        if (storage) {
            storage.setEnabled(e.target.checked);
            settings[storage.name] = storage.enabled;
            this.$el
                .find('.settings__general-' + storage.name)
                .toggleClass('hide', !e.target.checked);
        }
    }

    logoutFromStorage(e: any): void {
        const storageMap = Storage as unknown as Record<string, any>;
        const storage = storageMap[$(e.target).data('storage')];
        if (storage) {
            storage.logout();
            $(e.target).remove();
        }
    }

    showAdvancedSettings(): void {
        this.$el
            .find('.settings__general-show-advanced, .settings__general-advanced')
            .toggleClass('hide');
        this.scrollToBottom();
    }

    openDevTools(): void {
        // Dev tools are only available through browser developer tools
    }

    tryBeta(): void {
        if (this.appModel.files.hasUnsavedFiles()) {
            alerts.info({
                header: loc.setGenTryBetaWarning,
                body: loc.setGenTryBetaWarningBody
            });
        } else {
            location.href = links.BetaWebApp as string;
        }
    }

    showLogs(): void {
        const views = (this as any).views;
        if (views.logView) {
            views.logView.remove();
        }
        views.logView = new (SettingsLogsView as any)();
        views.logView.render();
        this.scrollToBottom();
    }

    reloadApp(): void {
        location.reload();
    }

    scrollToBottom(): void {
        this.$el.closest('.scroller').scrollTop(this.$el.height());
    }
}

export { SettingsGeneralView };
