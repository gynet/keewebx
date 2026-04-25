import { Model } from 'framework/model';
import { SettingsStore } from 'comp/settings/settings-store';
import { DefaultAppSettings, type AppSettings } from 'const/default-app-settings';

class AppSettingsModel extends Model {
    declare theme: AppSettings['theme'];
    declare autoSwitchTheme: AppSettings['autoSwitchTheme'];
    declare locale: AppSettings['locale'];
    declare expandGroups: AppSettings['expandGroups'];
    declare listViewWidth: AppSettings['listViewWidth'];
    declare menuViewWidth: AppSettings['menuViewWidth'];
    declare tagsViewHeight: AppSettings['tagsViewHeight'];
    declare autoUpdate: AppSettings['autoUpdate'];
    declare clipboardSeconds: AppSettings['clipboardSeconds'];
    declare autoSave: AppSettings['autoSave'];
    declare autoSaveInterval: AppSettings['autoSaveInterval'];
    declare rememberKeyFiles: AppSettings['rememberKeyFiles'];
    declare idleMinutes: AppSettings['idleMinutes'];
    declare minimizeOnClose: AppSettings['minimizeOnClose'];
    declare minimizeOnFieldCopy: AppSettings['minimizeOnFieldCopy'];
    declare tableView: AppSettings['tableView'];
    declare colorfulIcons: AppSettings['colorfulIcons'];
    declare tagStyle: AppSettings['tagStyle'];
    declare useMarkdown: AppSettings['useMarkdown'];
    declare directAutotype: AppSettings['directAutotype'];
    declare autoTypeTitleFilterEnabled: AppSettings['autoTypeTitleFilterEnabled'];
    declare titlebarStyle: AppSettings['titlebarStyle'];
    declare lockOnMinimize: AppSettings['lockOnMinimize'];
    declare lockOnCopy: AppSettings['lockOnCopy'];
    declare lockOnAutoType: AppSettings['lockOnAutoType'];
    declare lockOnOsLock: AppSettings['lockOnOsLock'];
    declare helpTipCopyShown: AppSettings['helpTipCopyShown'];
    declare templateHelpShown: AppSettings['templateHelpShown'];
    declare skipOpenLocalWarn: AppSettings['skipOpenLocalWarn'];
    declare hideEmptyFields: AppSettings['hideEmptyFields'];
    declare skipHttpsWarning: AppSettings['skipHttpsWarning'];
    declare demoOpened: AppSettings['demoOpened'];
    declare fontSize: AppSettings['fontSize'];
    declare tableViewColumns: AppSettings['tableViewColumns'];
    declare generatorPresets: AppSettings['generatorPresets'];
    declare generatorHidePassword: AppSettings['generatorHidePassword'];
    declare cacheConfigSettings: AppSettings['cacheConfigSettings'];
    declare allowIframes: AppSettings['allowIframes'];
    declare useGroupIconForEntries: AppSettings['useGroupIconForEntries'];
    declare largeListIcons: AppSettings['largeListIcons'];
    declare showFavicons: AppSettings['showFavicons'];
    declare enableUsb: AppSettings['enableUsb'];
    declare fieldLabelDblClickAutoType: AppSettings['fieldLabelDblClickAutoType'];
    declare auditPasswords: AppSettings['auditPasswords'];
    declare auditPasswordEntropy: AppSettings['auditPasswordEntropy'];
    declare excludePinsFromAudit: AppSettings['excludePinsFromAudit'];
    declare checkPasswordsOnHIBP: AppSettings['checkPasswordsOnHIBP'];
    declare auditPasswordAge: AppSettings['auditPasswordAge'];
    declare deviceOwnerAuth: AppSettings['deviceOwnerAuth'];
    declare deviceOwnerAuthTimeoutMinutes: AppSettings['deviceOwnerAuthTimeoutMinutes'];
    declare disableOfflineStorage: AppSettings['disableOfflineStorage'];
    declare shortLivedStorageToken: AppSettings['shortLivedStorageToken'];
    declare extensionFocusIfLocked: AppSettings['extensionFocusIfLocked'];
    declare extensionFocusIfEmpty: AppSettings['extensionFocusIfEmpty'];
    declare canOpen: AppSettings['canOpen'];
    declare canOpenDemo: AppSettings['canOpenDemo'];
    declare canOpenSettings: AppSettings['canOpenSettings'];
    declare canCreate: AppSettings['canCreate'];
    declare canImportXml: AppSettings['canImportXml'];
    declare canImportCsv: AppSettings['canImportCsv'];
    declare canRemoveLatest: AppSettings['canRemoveLatest'];
    declare canExportXml: AppSettings['canExportXml'];
    declare canExportHtml: AppSettings['canExportHtml'];
    declare canSaveTo: AppSettings['canSaveTo'];
    declare canOpenStorage: AppSettings['canOpenStorage'];
    declare canOpenGenerator: AppSettings['canOpenGenerator'];
    declare webdav: AppSettings['webdav'];
    declare webdavSaveMethod: AppSettings['webdavSaveMethod'];
    declare webdavStatReload: AppSettings['webdavStatReload'];
    declare saveVerify: AppSettings['saveVerify'];
    declare hiresFavicons: AppSettings['hiresFavicons'];

    constructor() {
        super();
        this.on('change', () => this.save());
    }

    load(): Promise<void> {
        return SettingsStore.load('app-settings').then((data) => {
            if (data && typeof data === 'object') {
                const record = data as Record<string, unknown>;
                this.upgrade(record);
                this.set(record, { silent: true });
            }
        });
    }

    upgrade(data: Record<string, unknown>): void {
        if (data.rememberKeyFiles === true) {
            data.rememberKeyFiles = 'data';
        }
        if (data.locale === 'en') {
            data.locale = 'en-US';
        }
        if (data.theme === 'macdark') {
            data.theme = 'dark';
        }
        if (data.theme === 'wh') {
            data.theme = 'light';
        }
    }

    save(): void {
        const values: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(this)) {
            if (DefaultAppSettings[key] !== value) {
                values[key] = value;
            }
        }
        SettingsStore.save('app-settings', values);
    }
}

AppSettingsModel.defineModelProperties(
    DefaultAppSettings as unknown as Record<string, unknown>,
    { extensions: true }
);

const instance = new AppSettingsModel();

export { instance as AppSettingsModel };
