/* eslint-disable @typescript-eslint/no-explicit-any */
import * as kdbxweb from 'kdbxweb';
import { View } from 'framework/views/view';
import { Storage } from 'storage';
import { Shortcuts } from 'comp/app/shortcuts';
import { Alerts } from 'comp/ui/alerts';
import { Links } from 'const/links';
import { AppSettingsModel } from 'models/app-settings-model';
import { DateFormat } from 'comp/i18n/date-format';
import { UrlFormat } from 'util/formatting/url-format';
import { PasswordPresenter } from 'util/formatting/password-presenter';
import { Locale } from 'util/locale';
import { FileSaver } from 'util/ui/file-saver';
import { OpenConfigView } from 'views/open-config-view';
import { omit } from 'util/fn';
import { getSettingsFileSections } from 'hooks/ui-extensions';
import template from 'templates/settings/settings-file.hbs';

const loc = Locale as unknown as Record<string, any>;
const links = Links as unknown as Record<string, string | undefined>;
const settings = AppSettingsModel as unknown as Record<string, any>;
const storageProvs = Storage as unknown as Record<string, any>;
const alerts = Alerts as unknown as {
    yesno(opts: any): void;
    alert(opts: any): void;
    error(opts: any): void;
    notImplemented(): void;
    buttons: { ok: any; cancel: any };
};

const DefaultBackupPath = 'Backups/{name}.{date}.bak';
const DefaultBackupSchedule = '1w';

interface YubiKeyInfo {
    serial: number;
    fullName: string;
    vid: number;
    pid: number;
    slots: { number: number; valid: boolean }[];
}

class SettingsFileView extends View {
    template = template;
    yubiKeys: YubiKeyInfo[] = [];
    backupInProgress = false;

    appModel: any;

    events: Record<string, string> = {
        'click .settings__file-button-save-default': 'saveDefault',
        'click .settings__file-button-save-choose': 'toggleChooser',
        'click .settings__file-button-close': 'closeFile',
        'click .settings__file-save-to-file': 'saveToFile',
        'click .settings__file-save-to-xml': 'saveToXml',
        'click .settings__file-save-to-html': 'saveToHtml',
        'click .settings__file-save-to-storage': 'saveToStorage',
        'change #settings__file-key-file': 'keyFileChange',
        'click #settings__file-file-select-link': 'triggerSelectFile',
        'change #settings__file-file-select': 'fileSelected',
        'focus #settings__file-master-pass': 'focusMasterPass',
        'input #settings__file-master-pass': 'changeMasterPass',
        'blur #settings__file-master-pass': 'blurMasterPass',
        'focus #settings__file-confirm-master-pass': 'focusConfirmMasterPass',
        'blur #settings__file-confirm-master-pass': 'blurConfirmMasterPass',
        'input #settings__file-name': 'changeName',
        'input #settings__file-def-user': 'changeDefUser',
        'change #settings__file-backup-enabled': 'changeBackupEnabled',
        'input #settings__file-backup-path': 'changeBackupPath',
        'change #settings__file-backup-storage': 'changeBackupStorage',
        'change #settings__file-backup-schedule': 'changeBackupSchedule',
        'click .settings__file-button-backup': 'backupFile',
        'change #settings__file-trash': 'changeTrash',
        'change #settings__file-hist-type': 'changeHistoryMode',
        'input #settings__file-hist-len': 'changeHistoryLength',
        'input #settings__file-hist-size': 'changeHistorySize',
        'change #settings__file-kdf': 'changeKdf',
        'input #settings__file-key-change-force': 'changeKeyChangeForce',
        'input .settings__input-kdf': 'changeKdfParameter',
        'change #settings__file-yubikey': 'changeYubiKey'
    };

    constructor(model: any, options?: any) {
        super(model, options);
        const watchedProps = ['syncing', 'syncError', 'syncDate'];
        for (const prop of watchedProps) {
            this.listenTo(this.model, 'change:' + prop, () => {
                setTimeout(() => this.render(), 0);
            });
        }

        for (const ext of getSettingsFileSections()) {
            ext.init?.(this);
        }

        this.refreshYubiKeys(false);
    }

    render(): this | undefined {
        const storageProviders: any[] = [];
        const fileStorage = this.model.storage;
        let canBackup = false;
        Object.keys(storageProvs).forEach((name) => {
            const prv = storageProvs[name];
            if (!canBackup && prv.backup && prv.enabled) {
                canBackup = true;
            }
            if (!prv.system && prv.enabled) {
                storageProviders.push({
                    name: prv.name,
                    icon: prv.icon,
                    own: name === fileStorage,
                    backup: prv.backup
                });
            }
        });
        storageProviders.sort((x, y) => (x.uipos || Infinity) - (y.uipos || Infinity));
        const backup = this.model.backup;

        const selectedYubiKey = this.model.chalResp
            ? `${this.model.chalResp.serial}:${this.model.chalResp.slot}`
            : '';
        const showYubiKeyBlock = !!this.model.chalResp;
        const yubiKeys: any[] = [];
        if (showYubiKeyBlock) {
            for (const yk of this.yubiKeys) {
                for (const slot of yk.slots.filter((s) => s.valid)) {
                    yubiKeys.push({
                        value: `${yk.serial}:${slot.number}`,
                        fullName: yk.fullName,
                        vid: yk.vid,
                        pid: yk.pid,
                        serial: yk.serial,
                        slot: slot.number
                    });
                }
            }
            if (selectedYubiKey && !yubiKeys.some((yk) => yk.value === selectedYubiKey)) {
                yubiKeys.push({
                    value: selectedYubiKey,
                    fullName: `YubiKey ${this.model.chalResp.serial}`,
                    vid: this.model.chalResp.vid,
                    pid: this.model.chalResp.pid,
                    serial: this.model.chalResp.serial,
                    slot: this.model.chalResp.slot
                });
            }
        }

        const renderData: Record<string, any> = {
            cmd: Shortcuts.actionShortcutSymbol(true),
            supportFiles: false,
            desktopLink: links.Desktop,
            name: this.model.name,
            path: this.model.path,
            storage: this.model.storage,
            syncing: this.model.syncing,
            syncError: this.model.syncError,
            syncDate: DateFormat.dtStr(this.model.syncDate),
            password: PasswordPresenter.present(this.model.passwordLength),
            defaultUser: this.model.defaultUser,
            recycleBinEnabled: this.model.recycleBinEnabled,
            backupEnabled: backup && backup.enabled,
            backupStorage: backup && backup.storage,
            backupPath:
                (backup && backup.path) || DefaultBackupPath.replace('{name}', this.model.name),
            backupSchedule: backup ? backup.schedule : DefaultBackupSchedule,
            historyMaxItems: this.model.historyMaxItems,
            historyMaxSize: Math.round(this.model.historyMaxSize / 1024 / 1024),
            kdfName: this.model.kdfName,
            keyChangeForce: this.model.keyChangeForce > 0 ? this.model.keyChangeForce : null,
            kdfParameters: this.kdfParametersToUi(this.model.kdfParameters),
            storageProviders,
            canBackup,
            canSaveTo: settings.canSaveTo,
            canExportXml: settings.canExportXml,
            canExportHtml: settings.canExportHtml,
            showYubiKeyBlock,
            selectedYubiKey,
            yubiKeys
        };

        let extensionsHtml = '';
        for (const ext of getSettingsFileSections()) {
            const extData = ext.renderData?.(this.model, this.appModel);
            if (extData) Object.assign(renderData, extData);
            extensionsHtml += ext.renderHtml?.(renderData) ?? '';
        }
        renderData.extensionsHtml = extensionsHtml;

        super.render(renderData);
        if (!this.model.created) {
            this.$el.find('.settings__file-master-pass-warning').toggle(this.model.passwordChanged);
            this.$el
                .find('#settings__file-master-pass-warning-text')
                .text(loc.setFilePassChanged);
        }
        this.renderKeyFileSelect();
        for (const ext of getSettingsFileSections()) {
            ext.afterRender?.(this);
        }
        return this;
    }

    kdfParametersToUi(kdfParameters: any): any {
        return kdfParameters
            ? { ...kdfParameters, memory: Math.round(kdfParameters.memory / 1024) }
            : null;
    }

    renderKeyFileSelect(): void {
        const keyFileName = this.model.keyFileName;
        const oldKeyFileName = this.model.oldKeyFileName;
        const keyFileChanged = this.model.keyFileChanged;
        const sel = this.$el.find('#settings__file-key-file');
        sel.empty();
        if (keyFileName && keyFileChanged) {
            const text =
                keyFileName !== 'Generated'
                    ? loc.setFileUseKeyFile + ' ' + keyFileName
                    : loc.setFileUseGenKeyFile;
            $('<option/>').val('ex').text(text).appendTo(sel);
        }
        if (oldKeyFileName) {
            const useText = keyFileChanged
                ? loc.setFileUseOldKeyFile
                : loc.setFileUseKeyFile + ' ' + oldKeyFileName;
            $('<option/>').val('old').text(useText).appendTo(sel);
        }
        $('<option/>').val('gen').text(loc.setFileGenKeyFile).appendTo(sel);
        $('<option/>').val('none').text(loc.setFileDontUseKeyFile).appendTo(sel);
        if (keyFileName && keyFileChanged) {
            sel.val('ex');
        } else if (!keyFileName) {
            sel.val('none');
        } else if (oldKeyFileName && keyFileName === oldKeyFileName && !keyFileChanged) {
            sel.val('old');
        }
    }

    validatePassword(continueCallback: () => void): boolean {
        if (!this.model.passwordLength) {
            alerts.yesno({
                header: loc.setFileEmptyPass,
                body: loc.setFileEmptyPassBody,
                success: () => {
                    continueCallback();
                },
                cancel: () => {
                    this.$el.find('#settings__file-master-pass').focus();
                }
            });
            return false;
        }
        return true;
    }

    save(arg?: any): void {
        if (!arg) {
            arg = {};
        }
        arg.startedByUser = true;
        if (!arg.skipValidation) {
            const isValid = this.validatePassword(() => {
                arg.skipValidation = true;
                this.save(arg);
            });
            if (!isValid) {
                return;
            }
        }

        this.appModel.syncFile(this.model, arg);
    }

    saveDefault(): void {
        this.save();
    }

    toggleChooser(): void {
        this.$el.find('.settings__file-save-choose').toggleClass('hide');
    }

    saveToFile(skipValidation?: boolean | unknown): void {
        if (skipValidation !== true && !this.validatePassword(this.saveToFile.bind(this, true))) {
            return;
        }
        const fileName = this.model.name + '.kdbx';
        this.model.getData((data: ArrayBuffer | Uint8Array | null) => {
            if (!data) {
                return;
            }
            // DOM BlobPart wants Uint8Array<ArrayBuffer> (not the
            // broader ArrayBufferLike the call-site returns); normalise
            // through a fresh ArrayBuffer so the Blob constructor is
            // happy under strict TS.
            let blobInput: ArrayBuffer;
            if (data instanceof Uint8Array) {
                blobInput = new ArrayBuffer(data.byteLength);
                new Uint8Array(blobInput).set(data);
            } else {
                blobInput = data;
            }
            const blob = new Blob([blobInput], { type: 'application/octet-stream' });
            FileSaver.saveAs(blob, fileName);
        });
    }

    saveToXml(): void {
        alerts.yesno({
            header: loc.setFileExportRaw,
            body: loc.setFileExportRawBody,
            success: () => {
                this.model.getXml((xml: string) => {
                    const blob = new Blob([xml], { type: 'text/xml' });
                    FileSaver.saveAs(blob, this.model.name + '.xml');
                });
            }
        });
    }

    saveToHtml(): void {
        alerts.yesno({
            header: loc.setFileExportRaw,
            body: loc.setFileExportRawBody,
            success: () => {
                this.model.getHtml((html: string) => {
                    const blob = new Blob([html], { type: 'text/html' });
                    FileSaver.saveAs(blob, this.model.name + '.html');
                });
            }
        });
    }

    saveToStorage(e: any): void {
        if (this.model.syncing || this.model.demo) {
            return;
        }
        const storageName = $(e.target).closest('.settings__file-save-to-storage').data('storage');
        const storage = storageProvs[storageName];
        if (!storage) {
            return;
        }
        if (this.model.storage === storageName) {
            this.save();
        } else {
            if (!storage.list) {
                if (storage.getOpenConfig) {
                    const config = {
                        id: storage.name,
                        name: loc[storage.name] || storage.name,
                        icon: storage.icon,
                        buttons: false,
                        ...storage.getOpenConfig()
                    };
                    const openConfigView = new (OpenConfigView as any)(config);
                    alerts.alert({
                        header: '',
                        body: '',
                        icon: storage.icon || 'file-alt',
                        buttons: [alerts.buttons.ok, alerts.buttons.cancel],
                        esc: '',
                        opaque: true,
                        view: openConfigView,
                        success: () => {
                            const storageConfig = openConfigView.getData();
                            if (!storageConfig) {
                                return;
                            }
                            const opts = omit(storageConfig, ['path', 'storage']);
                            if (opts && Object.keys(opts).length) {
                                this.model.opts = opts;
                            }
                            this.save({ storage: storageName, path: storageConfig.path, opts });
                        }
                    });
                } else {
                    alerts.notImplemented();
                }
                return;
            }
            this.model.syncing = true;
            storage.list('', (err: any, files: any[]) => {
                this.model.syncing = false;
                if (err) {
                    return;
                }
                const expName = this.model.name.toLowerCase();
                const existingFile = [...files].find(
                    (file) =>
                        !file.dir && UrlFormat.getDataFileName(file.name).toLowerCase() === expName
                );
                if (existingFile) {
                    alerts.yesno({
                        header: loc.setFileAlreadyExists,
                        body: loc.setFileAlreadyExistsBody.replace('{}', this.model.name),
                        success: () => {
                            this.model.syncing = true;
                            storage.remove(existingFile.path, (err: any) => {
                                this.model.syncing = false;
                                if (!err) {
                                    this.save({ storage: storageName });
                                }
                            });
                        }
                    });
                } else {
                    this.save({ storage: storageName });
                }
            });
        }
    }

    closeFile(): void {
        if (this.model.modified) {
            alerts.yesno({
                header: loc.setFileUnsaved,
                body: loc.setFileUnsavedBody,
                buttons: [
                    { result: 'close', title: loc.setFileCloseNoSave, error: true },
                    { result: '', title: loc.setFileDontClose }
                ],
                success: (result: string) => {
                    if (result === 'close') {
                        this.closeFileNoCheck();
                    }
                }
            });
        } else {
            this.closeFileNoCheck();
        }
    }

    closeFileNoCheck(): void {
        this.appModel.closeFile(this.model);
    }

    keyFileChange(e: any): void {
        switch (e.target.value) {
            case 'old':
                this.selectOldKeyFile();
                break;
            case 'gen':
                this.generateKeyFile();
                break;
            case 'none':
                this.clearKeyFile();
                break;
        }
    }

    selectOldKeyFile(): void {
        this.model.resetKeyFile();
        this.renderKeyFileSelect();
    }

    generateKeyFile(): void {
        this.model.generateAndSetKeyFile().then((keyFile: Uint8Array) => {
            // generateAndSetKeyFile returns Uint8Array (kdbxweb typing);
            // copy into a fresh ArrayBuffer so Blob accepts it under
            // strict TS (BlobPart wants Uint8Array<ArrayBuffer>).
            const arrayBuf = new ArrayBuffer(keyFile.byteLength);
            new Uint8Array(arrayBuf).set(keyFile);
            const blob = new Blob([arrayBuf], { type: 'application/octet-stream' });
            FileSaver.saveAs(blob, this.model.name + '.key');
            this.renderKeyFileSelect();
        });
    }

    clearKeyFile(): void {
        this.model.removeKeyFile();
        this.renderKeyFileSelect();
    }

    triggerSelectFile(): void {
        this.$el.find('#settings__file-file-select').click();
    }

    fileSelected(e: any): void {
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = (ev: ProgressEvent<FileReader>) => {
            const res = (ev.target as FileReader).result;
            this.model.setKeyFile(res, file.name);
            this.renderKeyFileSelect();
        };
        reader.readAsArrayBuffer(file);
    }

    focusMasterPass(e: any): void {
        e.target.value = '';
        e.target.setAttribute('type', 'text');
        this.model.passwordChanged = false;
    }

    changeMasterPass(e: any): void {
        if (!e.target.value) {
            this.model.resetPassword();
            this.$el.find('.settings__file-master-pass-warning').hide();
        } else {
            this.$el.find('#settings__file-confirm-master-pass-group').show();
            this.$el
                .find('#settings__file-master-pass-warning-text')
                .text(loc.setFilePassChange);
            if (!this.model.created) {
                this.$el.find('.settings__file-master-pass-warning').show();
            }
        }
    }

    blurMasterPass(e: any): void {
        if (!e.target.value) {
            this.model.resetPassword();
            this.resetConfirmMasterPass();
            e.target.value = PasswordPresenter.present(this.model.passwordLength);
            this.$el.find('.settings__file-master-pass-warning').hide();
        }
        e.target.setAttribute('type', 'password');
    }

    resetConfirmMasterPass(): void {
        this.$el.find('#settings__file-confirm-master-pass').val('');
        this.$el.find('#settings__file-confirm-master-pass-group').hide();
        this.$el.find('#settings__file-master-pass-warning-text').text(loc.setFilePassChange);
    }

    focusConfirmMasterPass(e: any): void {
        e.target.value = '';
        e.target.setAttribute('type', 'text');
    }

    blurConfirmMasterPass(e: any): void {
        e.target.setAttribute('type', 'password');
        const masterPassword = this.$el.find('#settings__file-master-pass').val();
        const confirmPassword = e.target.value;
        if (masterPassword === confirmPassword) {
            this.$el
                .find('#settings__file-master-pass-warning-text')
                .text(loc.setFilePassChanged);
            this.$el.find('.settings__file-confirm-master-pass-warning').hide();
            this.model.setPassword(kdbxweb.ProtectedValue.fromString(confirmPassword));
        } else {
            this.$el
                .find('#settings__file-master-pass-warning-text')
                .text(loc.setFilePassChange);
            this.$el.find('.settings__file-confirm-master-pass-warning').show();
            this.model.resetPassword();
        }
    }

    changeName(e: any): void {
        const value = $.trim(e.target.value);
        if (!value) {
            return;
        }
        this.model.setName(value);
    }

    changeDefUser(e: any): void {
        const value = $.trim(e.target.value);
        this.model.setDefaultUser(value);
    }

    changeBackupEnabled(e: any): void {
        const enabled = e.target.checked;
        let backup = this.model.backup;
        if (!backup) {
            backup = { enabled, schedule: DefaultBackupSchedule };
            const defaultPath = DefaultBackupPath.replace('{name}', this.model.name);
            backup.storage = 'webdav';
            backup.path = defaultPath;
            // } else if (this.model.storage === 'webdav') {
            //     backup.storage = 'webdav';
            //     backup.path = this.model.path + '.{date}.bak';
            // } else if (this.model.storage) {
            //     backup.storage = this.model.storage;
            //     backup.path = DefaultBackupPath.replace('{name}', this.model.name);
            // } else {
            //     Object.keys(Storage).forEach(name => {
            //         var prv = Storage[name];
            //         if (!backup.storage && !prv.system && prv.enabled) {
            //             backup.storage = name;
            //         }
            //     });
            //     if (!backup.storage) {
            //         e.target.checked = false;
            //         return;
            //     }
            //     backup.path = DefaultBackupPath.replace('{name}', this.model.name);
            // }
            this.$el.find('#settings__file-backup-storage').val(backup.storage);
            this.$el.find('#settings__file-backup-path').val(backup.path);
        }
        this.$el.find('.settings__file-backups').toggleClass('hide', !enabled);
        backup.enabled = enabled;
        this.setBackup(backup);
    }

    changeBackupPath(e: any): void {
        const backup = this.model.backup;
        backup.path = e.target.value.trim();
        this.setBackup(backup);
    }

    changeBackupStorage(e: any): void {
        const backup = this.model.backup;
        backup.storage = e.target.value;
        this.setBackup(backup);
    }

    changeBackupSchedule(e: any): void {
        const backup = this.model.backup;
        backup.schedule = e.target.value;
        this.setBackup(backup);
    }

    setBackup(backup: any): void {
        this.model.backup = backup;
        this.appModel.setFileBackup(this.model.id, backup);
    }

    backupFile(): void {
        if (this.backupInProgress) {
            return;
        }
        const backupButton = this.$el.find('.settings__file-button-backup');
        backupButton.text(loc.setFileBackupNowWorking);
        this.model.getData((data: ArrayBuffer | Uint8Array | null) => {
            if (!data) {
                this.backupInProgress = false;
                backupButton.text(loc.setFileBackupNow);
                return;
            }
            this.appModel.backupFile(this.model, data, (err: any) => {
                this.backupInProgress = false;
                backupButton.text(loc.setFileBackupNow);
                if (err) {
                    let title = '';
                    let description = '';
                    if (err.isDir) {
                        title = loc.setFileBackupErrorIsDir;
                        description = loc.setFileBackupErrorIsDirDescription;
                    } else {
                        title = loc.setFileBackupError;
                        description = loc.setFileBackupErrorDescription;
                    }
                    alerts.error({
                        title,
                        body: description,
                        pre: err.toString()
                    });
                }
            });
        });
    }

    changeTrash(e: any): void {
        this.model.setRecycleBinEnabled(e.target.checked);
    }

    changeHistoryLength(e: any): void {
        if (!e.target.validity.valid) {
            return;
        }
        const value = +e.target.value;
        if (isNaN(value)) {
            e.target.value = this.model.historyMaxItems;
            return;
        }
        this.model.setHistoryMaxItems(value);
    }

    changeHistoryMode(e: any): void {
        let value = +e.target.value;
        if (value > 0) {
            value = 10;
        }
        this.model.setHistoryMaxItems(value);
        this.render();
    }

    changeHistorySize(e: any): void {
        if (!e.target.validity.valid) {
            return;
        }
        const value = +e.target.value;
        if (isNaN(value)) {
            e.target.value = this.model.historyMaxSize / 1024 / 1024;
            return;
        }
        this.model.setHistoryMaxSize(value * 1024 * 1024);
    }

    changeKdf(e: any): void {
        this.model.setKdf(e.target.value);
        this.render();
    }

    changeKeyChangeForce(e: any): void {
        if (!e.target.validity.valid) {
            return;
        }
        let value = Math.round(e.target.value);
        if (isNaN(value) || value <= 0) {
            value = -1;
        }
        this.model.setKeyChange(true, value);
    }

    changeKdfParameter(e: any): void {
        if (!e.target.validity.valid) {
            return;
        }
        const field = $(e.target).data('field');
        const mul = $(e.target).data('mul') || 1;
        const value = e.target.value * mul;
        if (isNaN(value)) {
            e.target.value = Math.round(this.model.kdfParameters[field] / mul);
            return;
        }
        if (value > 0) {
            this.model.setKdfParameter(field, value);
        }
    }

    refreshYubiKeys(_force?: boolean): void {
        // No-op: YubiKey support removed in web-only fork
    }

    changeYubiKey(e: any): void {
        let chalResp = null;
        const value = e.target.value;
        if (value === 'refresh') {
            this.render();
            this.refreshYubiKeys(true);
            return;
        }
        if (value) {
            const option = e.target.selectedOptions[0];
            const vid = +option.dataset.vid;
            const pid = +option.dataset.pid;
            const serial = +option.dataset.serial;
            const slot = +option.dataset.slot;
            chalResp = { vid, pid, serial, slot };
        }
        alerts.yesno({
            header: loc.setFileYubiKeyHeader,
            body: loc.setFileYubiKeyBody,
            success: () => {
                this.model.setChallengeResponse(chalResp);
            },
            cancel: () => {
                this.render();
            }
        });
    }
}

export { SettingsFileView };
