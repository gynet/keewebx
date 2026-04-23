/* eslint-disable @typescript-eslint/no-explicit-any */
import * as kdbxweb from 'kdbxweb';
import { View } from 'framework/views/view';
import { Events } from 'framework/events';
import { Storage } from 'storage';
import { FocusDetector } from 'comp/browser/focus-detector';
import { KeyHandler } from 'comp/browser/key-handler';
import { SecureInput } from 'comp/browser/secure-input';
import { Alerts } from 'comp/ui/alerts';
import { Keys } from 'const/keys';
import { Comparators } from 'util/data/comparators';
import { Features } from 'util/features';
import { UrlFormat } from 'util/formatting/url-format';
import { Locale } from 'util/locale';
import { Logger } from 'util/logger';
import { InputFx } from 'util/ui/input-fx';
import { OpenConfigView } from 'views/open-config-view';
import { StorageFileListView } from 'views/storage-file-list-view';
import { omit } from 'util/fn';
import { GeneratorView } from 'views/generator-view';
import { CorsDiagnosticView } from 'views/cors-diagnostic-view';
import { isPasskeyPrfSupported } from 'comp/passkey/passkey-prf';
import {
    enablePasskeyForFile,
    PasskeyPrfNotSupportedError,
    unlockFileWithPasskey
} from 'comp/passkey/passkey-unlock';
import {
    probePasskeyCapability,
    PasskeyCapability
} from 'comp/passkey/passkey-capability';
import template from 'templates/open.hbs';

const logger = new Logger('open-view');

const loc = Locale as unknown as Record<string, any>;
const storageProvs = Storage as unknown as Record<string, any>;
const features = Features as unknown as { isMobile: boolean };
const alerts = Alerts as unknown as {
    alert(opts: any): void;
    error(opts: any): void;
    yesno(opts: any): void;
    notImplemented(): void;
    alertDisplayed: boolean;
};

interface OpenParams {
    id: string | null;
    name: string;
    storage: string | null;
    path: string | null;
    keyFileName: string | null;
    keyFileData: ArrayBuffer | Uint8Array | null;
    keyFilePath: string | null;
    fileData: ArrayBuffer | Uint8Array | null;
    rev: string | null;
    opts: any;
    fileXml?: string | null;
    password?: any;
    encryptedPassword?: any;
}

class OpenView extends View {
    parent = '.app__body';
    modal = 'open';

    template = template;

    events: Record<string, string> = {
        'change .open__file-ctrl': 'fileSelected',
        'click .open__icon-open': 'openFile',
        'click .open__icon-new': 'createNew',
        'click .open__icon-demo': 'createDemo',
        'click .open__icon-more': 'toggleMore',
        'click .open__icon-storage': 'openStorage',
        'click .open__icon-settings': 'openSettings',
        'click .open__pass-input[readonly]': 'openFile',
        'input .open__pass-input': 'inputInput',
        'keydown .open__pass-input': 'inputKeydown',
        'keyup .open__pass-input': 'inputKeyup',
        'keypress .open__pass-input': 'inputKeypress',
        'click .open__pass-enter-btn': 'openDbClick',
        'click .open__settings-key-file': 'openKeyFile',
        'click .open__last-item': 'openLast',
        'change .open__passkey-enable-check': 'passkeyEnableToggled',
        'click .open__passkey-clear': 'passkeyCleared',
        'click .open__icon-generate': 'toggleGenerator',
        'click .open__message-cancel-btn': 'openMessageCancelClick',
        dragover: 'dragover',
        dragleave: 'dragleave',
        drop: 'drop'
    };

    params: OpenParams = {
        id: null,
        name: '',
        storage: null,
        path: null,
        keyFileName: null,
        keyFileData: null,
        keyFilePath: null,
        fileData: null,
        rev: null,
        opts: null
    };
    passwordInput: any = null;
    busy = false;
    currentSelectedIndex = -1;
    encryptedPassword: any = null;
    inputEl: any;
    reading?: string;
    dragTimeout?: ReturnType<typeof setTimeout>;
    storageWaitId: number | null = null;

    // Passkey quick unlock state (#9). `passkeyAvailable` is cached at
    // construction time because probing is cheap but doing it on every
    // keystroke would churn for no reason. The three `passkey*` fields
    // mirror what `showOpenFileInfo` pulled off FileInfoModel — null
    // means "no credential registered, show enable-passkey checkbox
    // instead". `enablePasskeyRequested` is the user's intent to turn
    // passkey unlock on as part of the current open click; consumed
    // and cleared in `openDbComplete` after wrapping the password.
    passkeyAvailable = isPasskeyPrfSupported();
    passkeyCredentialId: string | null = null;
    passkeyPrfSalt: string | null = null;
    passkeyWrappedKey: string | null = null;
    enablePasskeyRequested = false;

    // Deep PRF capability probe result (#9 follow-up). Null until the
    // async `probePasskeyCapability()` resolves. While null, the view
    // hides the enable-passkey checkbox to avoid a flash of "this works"
    // followed by "oh wait, your OS does not support PRF". See
    // `displayOpenPasskey()` for the three-state render logic.
    passkeyCapability: PasskeyCapability | null = null;

    constructor(model: any) {
        super(model);
        (window as any).$ = $;
        this.resetParams();
        this.passwordInput = new (SecureInput as any)();
        this.onKey(Keys.DOM_VK_Z, this.undoKeyPress, KeyHandler.SHORTCUT_ACTION, 'open');
        this.onKey(Keys.DOM_VK_TAB, this.tabKeyPress, null, 'open');
        this.onKey(Keys.DOM_VK_ENTER, this.enterKeyPress, null, 'open');
        this.onKey(Keys.DOM_VK_RETURN, this.enterKeyPress, null, 'open');
        this.onKey(Keys.DOM_VK_DOWN, this.moveOpenFileSelectionDown, null, 'open');
        this.onKey(Keys.DOM_VK_UP, this.moveOpenFileSelectionUp, null, 'open');
        this.listenTo(Events, 'main-window-focus', this.windowFocused.bind(this));
        this.listenTo(Events, 'usb-devices-changed', this.usbDevicesChanged.bind(this));
        this.listenTo(Events, 'unlock-message-changed', this.unlockMessageChanged.bind(this));
        this.once('remove', () => {
            this.passwordInput.reset();
        });
        this.listenTo(Events, 'user-idle', this.userIdle);

        // Kick off the deep PRF capability probe. Fire-and-forget: the
        // probe never throws (the module catches all failures and maps
        // them to `prf: 'unknown'`). When it resolves we cache the
        // result and re-run `displayOpenPasskey()` to flip the checkbox
        // + diagnostic line into their final visibility state. This is
        // the fix for the #9 post-ship report where users on macOS 14
        // Sonoma walked all the way through Touch ID registration only
        // to hit PasskeyPrfNotSupportedError at the very end.
        if (this.passkeyAvailable) {
            void probePasskeyCapability()
                .then((cap) => {
                    this.passkeyCapability = cap;
                    if ((this as any).el) {
                        this.displayOpenPasskey();
                    }
                })
                .catch((err) => {
                    logger.error('Passkey capability probe failed', err);
                    this.passkeyCapability = {
                        prf: 'unknown',
                        reason: 'Capability probe failed.',
                        recommendation: 'Try registering a passkey — it may still work.',
                        platform: { os: 'unknown', browser: 'unknown' }
                    };
                    if ((this as any).el) {
                        this.displayOpenPasskey();
                    }
                });
        }
    }

    render(): this | undefined {
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
        }
        const storageProviders: any[] = [];
        if (this.model.settings.canOpenStorage) {
            Object.keys(storageProvs).forEach((name) => {
                const prv = storageProvs[name];
                if (!prv.system && prv.enabled) {
                    storageProviders.push(prv);
                }
            });
        }
        storageProviders.sort((x, y) => (x.uipos || Infinity) - (y.uipos || Infinity));
        const showMore =
            storageProviders.length ||
            this.model.settings.canOpenSettings ||
            this.model.settings.canOpenGenerator;
        const showLogo =
            !showMore &&
            !this.model.settings.canOpen &&
            !this.model.settings.canCreate &&
            !(this.model.settings.canOpenDemo && !this.model.settings.demoOpened);
        super.render({
            lastOpenFiles: this.getLastOpenFiles(),
            canOpenKeyFromDropbox: false,
            demoOpened: this.model.settings.demoOpened,
            storageProviders,
            unlockMessageRes: this.model.unlockMessageRes,
            canOpen: this.model.settings.canOpen,
            canOpenDemo: this.model.settings.canOpenDemo,
            canOpenSettings: this.model.settings.canOpenSettings,
            canOpenGenerator: this.model.settings.canOpenGenerator,
            canCreate: this.model.settings.canCreate,
            canRemoveLatest: this.model.settings.canRemoveLatest,
            canOpenYubiKey: false,
            canUseChalRespYubiKey: false,
            passkeyAvailable: this.passkeyAvailable,
            showMore,
            showLogo
        });
        this.inputEl = this.$el.find('.open__pass-input');
        this.passwordInput.setElement(this.inputEl);
        return this;
    }

    resetParams(): void {
        this.params = {
            id: null,
            name: '',
            storage: null,
            path: null,
            keyFileName: null,
            keyFileData: null,
            keyFilePath: null,
            fileData: null,
            rev: null,
            opts: null
        };
        // Also clear passkey state so the next file selection starts
        // from a clean slate — stale credential IDs from a previously
        // selected file would make the button offer the wrong unlock.
        this.passkeyCredentialId = null;
        this.passkeyPrfSalt = null;
        this.passkeyWrappedKey = null;
        this.enablePasskeyRequested = false;
    }

    windowFocused(): void {
        this.inputEl.focus();
        this.checkIfEncryptedPasswordDateIsValid();
    }

    focusInput(focusOnMobile?: boolean): void {
        if ((FocusDetector as any).hasFocus() && (focusOnMobile || !features.isMobile)) {
            this.inputEl.focus();
        }
    }

    getLastOpenFiles(): any[] {
        return this.model.fileInfos.map((fileInfo: any) => {
            let icon = 'file-alt';
            const storage = storageProvs[fileInfo.storage];
            if (storage && storage.icon) {
                icon = storage.icon;
            }
            return {
                id: fileInfo.id,
                name: fileInfo.name,
                path: this.getDisplayedPath(fileInfo),
                icon
            };
        });
    }

    getDisplayedPath(fileInfo: any): string | null {
        const storage = fileInfo.storage;
        if (storage === 'file' || storage === 'webdav') {
            return fileInfo.path;
        }
        return null;
    }

    showLocalFileAlert(): void {
        if (this.model.settings.skipOpenLocalWarn) {
            return;
        }
        alerts.alert({
            header: loc.openLocalFile,
            body: loc.openLocalFileBody,
            icon: 'file-alt',
            buttons: [
                { result: 'skip', title: loc.openLocalFileDontShow, error: true },
                { result: 'ok', title: loc.alertOk }
            ],
            click: '',
            esc: '',
            enter: '',
            success: (res: string) => {
                this.focusInput();
                if (res === 'skip') {
                    this.model.settings.skipOpenLocalWarn = true;
                }
            }
        });
    }

    fileSelected(e: any): void {
        const file = e.target.files[0];
        if (file) {
            if (this.model.settings.canImportCsv && /\.csv$/.test(file.name)) {
                Events.emit('import-csv-requested', file);
            } else if (this.model.settings.canImportXml && /\.xml$/.test(file.name)) {
                this.setFile(file, null, this.showLocalFileAlert.bind(this));
            } else {
                this.processFile(file, (success: boolean) => {
                    if (success && !file.path && this.reading === 'fileData') {
                        this.showLocalFileAlert();
                    }
                });
            }
        }
    }

    processFile(file: any, complete?: (success: boolean) => void): void {
        const reader = new FileReader();
        reader.onload = (e: ProgressEvent<FileReader>) => {
            let success = false;
            const result = (e.target as FileReader).result;
            switch (this.reading) {
                case 'fileData': {
                    const format = this.getOpenFileFormat(result);
                    switch (format) {
                        case 'kdbx':
                            this.params.id = null;
                            this.params.fileData = result as ArrayBuffer;
                            this.params.name = file.name.replace(/(.+)\.\w+$/i, '$1');
                            this.params.path = file.path || null;
                            this.params.storage = file.path ? 'file' : null;
                            this.params.rev = null;
                            if (!this.params.keyFileData) {
                                this.params.keyFileName = null;
                            }
                            this.encryptedPassword = null;
                            this.displayOpenFile();
                            this.displayOpenKeyFile();
                            this.displayOpenDeviceOwnerAuth();
                            this.displayOpenPasskey();
                            success = true;
                            break;
                        case 'xml':
                            this.params.id = null;
                            this.params.fileXml = kdbxweb.ByteUtils.bytesToString(
                                result as ArrayBuffer
                            );
                            this.params.name = file.name.replace(/\.\w+$/i, '');
                            this.params.path = null;
                            this.params.storage = null;
                            this.params.rev = null;
                            this.encryptedPassword = null;
                            this.importDbWithXml();
                            this.displayOpenDeviceOwnerAuth();
                            success = true;
                            break;
                        case 'kdb':
                            alerts.error({
                                header: loc.openWrongFile,
                                body: loc.openKdbFileBody
                            });
                            break;
                        default:
                            alerts.error({
                                header: loc.openWrongFile,
                                body: loc.openWrongFileBody
                            });
                            break;
                    }
                    break;
                }
                case 'keyFileData':
                    this.params.keyFileData = result as ArrayBuffer;
                    this.params.keyFileName = file.name;
                    if (this.model.settings.rememberKeyFiles === 'path') {
                        this.params.keyFilePath = file.path;
                    }
                    this.displayOpenKeyFile();
                    success = true;
                    break;
            }
            if (complete) {
                complete(success);
            }
        };
        reader.onerror = () => {
            alerts.error({ header: loc.openFailedRead });
            if (complete) {
                complete(false);
            }
        };
        if (this.reading === 'fileXml') {
            reader.readAsText(file);
        } else {
            reader.readAsArrayBuffer(file);
        }
    }

    getOpenFileFormat(fileData: any): 'kdbx' | 'kdb' | 'xml' | undefined {
        if (fileData.byteLength < 8) {
            return undefined;
        }
        const fileSig = new Uint32Array(fileData, 0, 2);
        if (fileSig[0] === (kdbxweb.Consts.Signatures as any).FileMagic) {
            if (fileSig[1] === (kdbxweb.Consts.Signatures as any).Sig2Kdb) {
                return 'kdb';
            } else if (fileSig[1] === (kdbxweb.Consts.Signatures as any).Sig2Kdbx) {
                return 'kdbx';
            } else {
                return undefined;
            }
        } else if (this.model.settings.canImportXml) {
            try {
                const str = kdbxweb.ByteUtils.bytesToString(fileSig as any).trim();
                if (str.startsWith('<?xml')) {
                    return 'xml';
                }
            } catch (e) {
                /* ignore */
            }
            return undefined;
        } else {
            return undefined;
        }
    }

    displayOpenFile(): void {
        this.$el.addClass('open--file');
        this.$el.find('.open__settings-key-file').removeClass('hide');
        this.inputEl[0].removeAttribute('readonly');
        this.inputEl[0].setAttribute('placeholder', loc.openPassFor + ' ' + this.params.name);
        this.focusInput();
    }

    displayOpenKeyFile(): void {
        this.$el.toggleClass('open--key-file', !!this.params.keyFileName);
        this.$el
            .find('.open__settings-key-file-name')
            .text(this.params.keyFileName || this.params.keyFilePath || loc.openKeyFile);
        this.focusInput();
    }

    displayOpenPasskey(): void {
        // Called from render() (template hook) and again whenever the
        // password input contents change or a new file is selected from
        // the last-opened list. Toggles both:
        //
        //   1. The `.open__pass-enter-btn--passkey` BEM modifier, which
        //      swaps the enter-arrow icon for a fingerprint icon on the
        //      unlock button when the selected file has a registered
        //      passkey AND the user hasn't started typing a password.
        //
        //   2. The visibility of the "Enable passkey for this file"
        //      checkbox below the password field, shown only when the
        //      file does NOT yet have a passkey AND the browser PRF
        //      probe passed. The checkbox lets the user turn on quick
        //      unlock at the next open without visiting settings.
        const el = (this as any).el;
        if (!el) return;

        const hasFile = !!this.params.name && (!!this.params.id || !!this.params.fileData);
        const passEmpty = !this.passwordInput.length;
        const hasRegisteredPasskey =
            !!this.passkeyCredentialId &&
            !!this.passkeyPrfSalt &&
            !!this.passkeyWrappedKey;

        // Button modifier: light up the passkey icon only when there's
        // a credential to use AND the password field is empty (so the
        // user can't accidentally blow away their typing). If they have
        // started typing, fall back to the normal enter-arrow path.
        const canUsePasskey = this.passkeyAvailable && hasRegisteredPasskey && passEmpty;
        const enterBtn = el.querySelector('.open__pass-enter-btn') as HTMLElement | null;
        if (enterBtn) {
            enterBtn.classList.toggle('open__pass-enter-btn--passkey', canUsePasskey);
        }

        // Checkbox row: offer enable-at-open when the browser supports
        // PRF, a file is being opened, and it doesn't yet have a passkey.
        //
        // Three-state gate from the deep capability probe:
        //
        //   - capability === null (probe still resolving, or view
        //     constructed before probe kicked off): HIDE checkbox to
        //     avoid a UI flash.
        //   - capability.prf === 'unsupported': HIDE checkbox and
        //     render the diagnostic line below with OS-specific
        //     upgrade guidance. The user walks away knowing WHY
        //     before they have a chance to click anything.
        //   - capability.prf === 'supported': SHOW checkbox normally.
        //   - capability.prf === 'unknown': SHOW checkbox (so users
        //     with hardware keys can still opt in) and render the
        //     diagnostic line as a soft warning.
        const probeResolved = this.passkeyCapability !== null;
        const prfState = this.passkeyCapability?.prf ?? null;
        const showEnableRow =
            this.passkeyAvailable &&
            hasFile &&
            !hasRegisteredPasskey &&
            probeResolved;
        logger.debug('displayOpenPasskey', {
            passkeyAvailable: this.passkeyAvailable,
            hasFile,
            hasRegisteredPasskey,
            probeResolved,
            prfState,
            showEnableRow,
            paramsName: this.params.name,
            paramsId: this.params.id,
            paramsFileData: !!this.params.fileData,
            capability: this.passkeyCapability
        });
        const prfDisabled = prfState === 'unsupported';

        const enableRow = el.querySelector('.open__passkey-enable') as HTMLElement | null;
        if (enableRow) {
            enableRow.classList.toggle('hide', !showEnableRow);
            enableRow.classList.toggle('open__passkey-enable--disabled', prfDisabled);
            const checkbox = enableRow.querySelector(
                '.open__passkey-enable-check'
            ) as HTMLInputElement | null;
            if (checkbox) {
                if (prfDisabled) {
                    checkbox.setAttribute('disabled', 'disabled');
                } else {
                    checkbox.removeAttribute('disabled');
                }
            }
            const label = enableRow.querySelector(
                '.open__passkey-enable-label'
            ) as HTMLElement | null;
            if (showEnableRow && this.passkeyCapability &&
                (prfState === 'unsupported' || prfState === 'unknown')) {
                const msg = this.formatPasskeyDiagMessage(this.passkeyCapability);
                const tip = msg.recommendation
                    ? msg.reason + '\n' + msg.recommendation
                    : msg.reason;
                enableRow.setAttribute('title', tip);
                if (label) label.setAttribute('title', tip);
            } else {
                enableRow.removeAttribute('title');
                if (label) label.removeAttribute('title');
            }
        }

        // "Remove passkey" link: shown when file HAS a registered passkey
        const clearRow = el.querySelector('.open__passkey-clear') as HTMLElement | null;
        if (clearRow) {
            const showClear = this.passkeyAvailable && hasFile && hasRegisteredPasskey;
            clearRow.classList.toggle('hide', !showClear);
        }
    }

    /**
     * Resolve a capability probe result into a localized reason +
     * recommendation pair. Prefers locale keys when the probe supplied
     * them (so non-English UIs get the right copy), with an English
     * fallback from the probe itself for anything not yet translated.
     */
    formatPasskeyDiagMessage(cap: PasskeyCapability): {
        reason: string;
        recommendation?: string;
    } {
        let reason = cap.reason;
        if (cap.reasonKey && typeof loc[cap.reasonKey] === 'string') {
            const template = loc[cap.reasonKey] as string;
            const ver = cap.platform.osVersion ?? '';
            reason = template.replace('{0}', ver);
        }
        let recommendation: string | undefined = cap.recommendation;
        if (cap.recommendationKey && typeof loc[cap.recommendationKey] === 'string') {
            recommendation = loc[cap.recommendationKey] as string;
        }
        return { reason, recommendation };
    }

    displayOpenDeviceOwnerAuth(): void {
        const available = !!this.encryptedPassword;
        const passEmpty = !this.passwordInput.length;
        const canUseEncryptedPassword = available && passEmpty;
        (this as any).el
            .querySelector('.open__pass-enter-btn')
            .classList.toggle('open__pass-enter-btn--touch-id', canUseEncryptedPassword);
    }

    setFile(file: any, keyFile: any, fileReadyCallback?: (() => void) | null): void {
        this.reading = 'fileData';
        this.processFile(file, (success: boolean) => {
            if (success && keyFile) {
                this.reading = 'keyFileData';
                this.processFile(keyFile);
            }
            if (success && typeof fileReadyCallback === 'function') {
                fileReadyCallback();
            }
        });
    }

    openFile(): void {
        if (this.model.settings.canOpen === false) {
            return;
        }
        if (!this.busy) {
            this.closeConfig();
            this.openAny('fileData');
        }
    }

    openKeyFile(_e?: any): void {
        if (!this.busy && this.params.name) {
            if (this.params.keyFileName) {
                this.params.keyFileData = null;
                this.params.keyFilePath = null;
                this.params.keyFileName = '';
                this.$el.removeClass('open--key-file');
                this.$el.find('.open__settings-key-file-name').text(loc.openKeyFile);
            } else {
                this.openAny('keyFileData');
            }
        }
    }

    openAny(reading: string, ext?: string): void {
        this.reading = reading;
        (this.params as any)[reading] = null;

        const fileInput = this.$el
            .find('.open__file-ctrl')
            .attr('accept', ext || '')
            .val(null as any);

        fileInput.click();
    }

    openLast(e: any): void {
        if (this.busy) {
            return;
        }
        const id = $(e.target).closest('.open__last-item').data('id').toString();
        if ($(e.target).is('.open__last-item-icon-del')) {
            const fileInfo = this.model.fileInfos.get(id);
            if (!fileInfo.storage || fileInfo.modified) {
                alerts.yesno({
                    header: loc.openRemoveLastQuestion,
                    body: fileInfo.modified
                        ? loc.openRemoveLastQuestionModBody
                        : loc.openRemoveLastQuestionBody,
                    buttons: [
                        { result: 'yes', title: loc.alertYes },
                        { result: '', title: loc.alertNo }
                    ],
                    success: () => {
                        this.removeFile(id);
                    }
                });
                return;
            }
            this.removeFile(id);
            return;
        }

        const fileInfo = this.model.fileInfos.get(id);
        this.showOpenFileInfo(fileInfo, true);
    }

    removeFile(id: string): void {
        this.model.removeFileInfo(id);
        this.$el.find('.open__last-item[data-id="' + id + '"]').remove();
        this.resetParams();
        this.render();
    }

    inputKeydown(e: any): void {
        const code = e.keyCode || e.which;
        if (code === Keys.DOM_VK_RETURN) {
            this.openDb();
        } else if (code === Keys.DOM_VK_CAPS_LOCK) {
            this.toggleCapsLockWarning(false);
        }
    }

    inputKeyup(e: any): void {
        const code = e.keyCode || e.which;
        if (code === Keys.DOM_VK_CAPS_LOCK) {
            this.toggleCapsLockWarning(false);
        }
    }

    inputKeypress(e: any): void {
        const charCode = e.keyCode || e.which;
        const ch = String.fromCharCode(charCode);
        const lower = ch.toLowerCase();
        const upper = ch.toUpperCase();
        if (lower !== upper && !e.shiftKey) {
            this.toggleCapsLockWarning(ch !== lower);
        }
    }

    inputInput(): void {
        this.displayOpenDeviceOwnerAuth();
        this.displayOpenPasskey();
    }

    toggleCapsLockWarning(on: boolean): void {
        this.$el.find('.open__pass-warning').toggleClass('invisible', !on);
    }

    dragover(e: any): void {
        if (this.model.settings.canOpen === false) {
            return;
        }
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
        if (!this.$el.hasClass('open--drag')) {
            this.$el.addClass('open--drag');
        }
    }

    dragleave(): void {
        if (this.model.settings.canOpen === false) {
            return;
        }
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
        }
        this.dragTimeout = setTimeout(() => {
            this.$el.removeClass('open--drag');
        }, 100);
    }

    drop(e: any): void {
        if (this.model.settings.canOpen === false) {
            return;
        }
        e.preventDefault();
        if (this.busy) {
            return;
        }
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
        }
        this.closeConfig();
        this.$el.removeClass('open--drag');
        const files: any[] = [...(e.target.files || e.dataTransfer.files)];
        const dataFile = files.find((file) => /\.kdbx$/i.test(file.name));
        const keyFile = files.find((file) => /\.keyx?$/i.test(file.name));
        if (dataFile) {
            this.setFile(
                dataFile,
                keyFile,
                dataFile.path ? null : this.showLocalFileAlert.bind(this)
            );
            return;
        }
        if (this.model.settings.canImportXml) {
            const xmlFile = files.find((file) => /\.xml$/i.test(file.name));
            if (xmlFile) {
                this.setFile(xmlFile, null, this.showLocalFileAlert.bind(this));
                return;
            }
        }
        if (this.model.settings.canImportCsv) {
            const csvFile = files.find((file) => /\.csv$/i.test(file.name));
            if (csvFile) {
                Events.emit('import-csv-requested', csvFile);
            }
        }
    }

    undoKeyPress(e: any): void {
        e.preventDefault();
    }

    tabKeyPress(): void {
        this.$el.addClass('open--show-focus');
    }

    enterKeyPress(e: any): void {
        const el = this.$el.find('[tabindex]:focus');
        if (el.length) {
            el.trigger('click', e);
        }
    }

    showOpenFileInfo(fileInfo: any, fileWasClicked?: boolean): void {
        if (this.busy || !fileInfo) {
            return;
        }
        this.params.id = fileInfo.id;
        this.params.storage = fileInfo.storage;
        this.params.path = fileInfo.path;
        this.params.name = fileInfo.name;
        this.params.fileData = null;
        this.params.rev = null;
        this.params.keyFileName = fileInfo.keyFileName;
        this.params.keyFilePath = fileInfo.keyFilePath;
        this.params.keyFileData = null;
        this.params.opts = fileInfo.opts;
        this.setEncryptedPassword(fileInfo);

        // Pull passkey descriptor off FileInfoModel. Presence of all
        // three fields gates the passkey button; any one missing means
        // the credential is incomplete (e.g. the user cleared storage
        // manually) and we show the enable flow instead.
        this.passkeyCredentialId = fileInfo.passkeyCredentialId || null;
        this.passkeyPrfSalt = fileInfo.passkeyPrfSalt || null;
        this.passkeyWrappedKey = fileInfo.passkeyWrappedKey || null;
        this.enablePasskeyRequested = false;

        this.displayOpenFile();
        this.displayOpenKeyFile();
        this.displayOpenDeviceOwnerAuth();
        this.displayOpenPasskey();

        // Reset the enable-passkey checkbox to unchecked any time we
        // switch to a new file — the user must re-tick it explicitly.
        const checkboxEl = (this as any).el?.querySelector(
            '.open__passkey-enable-check'
        ) as HTMLInputElement | null;
        if (checkboxEl) {
            checkboxEl.checked = false;
        }

        if (fileWasClicked) {
            this.focusInput(true);
        }
    }

    showOpenLocalFile(path: string, keyFilePath?: string): void {
        if (this.busy) {
            return;
        }
        this.params.id = null;
        this.params.storage = 'file';
        this.params.path = path;
        this.params.name = path.match(/[^/\\]*$/)?.[0] || path;
        this.params.rev = null;
        this.params.fileData = null;
        this.encryptedPassword = null;
        // A freshly-imported local file has no persisted FileInfo yet,
        // so there's no passkey state to surface — make sure we don't
        // accidentally show a button from a previously selected entry.
        this.passkeyCredentialId = null;
        this.passkeyPrfSalt = null;
        this.passkeyWrappedKey = null;
        this.enablePasskeyRequested = false;
        this.displayOpenFile();
        this.displayOpenDeviceOwnerAuth();
        this.displayOpenPasskey();
        if (keyFilePath) {
            this.params.keyFileName = keyFilePath.match(/[^/\\]*$/)?.[0] || keyFilePath;
            this.params.keyFilePath = keyFilePath;
            this.params.keyFileData = null;
            this.displayOpenKeyFile();
        }
    }

    createDemo(): void {
        if (!this.busy) {
            this.closeConfig();
            if (!this.model.createDemoFile()) {
                this.emit('close');
            }
            if (!this.model.settings.demoOpened) {
                this.model.settings.demoOpened = true;
            }
        }
    }

    createNew(): void {
        if (!this.busy) {
            this.model.createNewFile();
        }
    }

    /**
     * Click dispatcher for `.open__pass-enter-btn`. The same DOM node
     * drives three unlock flows depending on BEM state:
     *
     *   - `--passkey`   → run the passkey get() ceremony, unwrap the
     *                     master password, then follow the normal
     *                     `openDb()` path with the unwrapped value.
     *   - `--touch-id`  → legacy Touch ID flow (dead stub in web-only
     *                     mode, kept for UI parity — calls `openDb()`).
     *   - default       → typed-password open.
     *
     * Kept as a thin switch so the click handler stays readable.
     */
    openDbClick(): void {
        const btn = (this as any).el?.querySelector(
            '.open__pass-enter-btn'
        ) as HTMLElement | null;
        if (btn && btn.classList.contains('open__pass-enter-btn--passkey')) {
            this.openDbWithPasskey();
            return;
        }
        this.openDb();
    }

    openDb(): void {
        if (this.params.id && this.model.files.get(this.params.id)) {
            this.emit('close');
            return;
        }
        if (this.busy || !this.params.name) {
            return;
        }
        this.$el.toggleClass('open--opening', true);
        this.inputEl.attr('disabled', 'disabled');
        this.busy = true;
        this.params.password = this.passwordInput.value;
        this.params.encryptedPassword = null;

        // Capture the typed plaintext BEFORE openFile consumes the
        // ProtectedValue. We need the raw string for the enable-passkey
        // flow that runs after a successful open. Stash it on `this`
        // so `openDbComplete` can pick it up; clear unconditionally in
        // openDbComplete to avoid lingering cleartext.
        if (this.enablePasskeyRequested) {
            try {
                this.capturedPasswordForEnable = (
                    this.params.password as any
                )?.getText?.() as string | undefined;
            } catch (e) {
                logger.info('Could not capture plaintext for passkey enable', e);
                this.capturedPasswordForEnable = undefined;
            }
        }

        (this as any).afterPaint(() => {
            this.model.openFile(this.params, (err: any) => this.openDbComplete(err));
        });
    }

    capturedPasswordForEnable: string | undefined = undefined;

    /**
     * Unlock a file whose FileInfo already carries a registered passkey
     * credential. Runs the WebAuthn get() ceremony, HKDF-derives the
     * wrap key, AES-256-GCM unwraps the stored master password, then
     * hands the resulting ProtectedValue to the normal open flow.
     *
     * On user cancel / UV failure / GCM tag mismatch / credential gone,
     * falls back to the password input path — matches Touch ID UX. A
     * `NotAllowedError` specifically means the user declined UV, which
     * is expected, not a bug, so we downgrade the log level.
     */
    async openDbWithPasskey(): Promise<void> {
        if (
            !this.params.id ||
            !this.passkeyCredentialId ||
            !this.passkeyPrfSalt ||
            !this.passkeyWrappedKey
        ) {
            return;
        }
        if (this.busy || !this.params.name) {
            return;
        }

        const fileId = this.params.id;
        this.$el.toggleClass('open--opening', true);
        this.inputEl.attr('disabled', 'disabled');
        this.busy = true;

        let protectedPassword: any;
        try {
            const unlockResult = await unlockFileWithPasskey(fileId, {
                credentialId: this.passkeyCredentialId,
                prfSalt: this.passkeyPrfSalt,
                wrappedKey: this.passkeyWrappedKey
            });
            protectedPassword = unlockResult.password;
            if (unlockResult.migratedWrappedKey) {
                const fileInfo = this.model.fileInfos.get(fileId);
                if (fileInfo) {
                    fileInfo.passkeyWrappedKey = unlockResult.migratedWrappedKey;
                    this.model.fileInfos.save();
                    logger.info('Migrated passkey wrapped key to AAD format');
                }
            }
        } catch (e: any) {
            if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
                logger.info('Passkey UV cancelled, falling back to password', e.name);
            } else if (
                e instanceof PasskeyPrfNotSupportedError ||
                (e && e.name === 'PasskeyPrfNotSupportedError')
            ) {
                // The authenticator (or a hooking extension) refused
                // to return a PRF result. The credential persisted
                // on FileInfo cannot be unwrapped on this device any
                // more — leaving it in place would lock the user
                // into a permanently-broken passkey button on every
                // future open. Auto-clear the four passkey fields
                // and tell the user to re-enroll. Same FileInfo row,
                // same file id — only the passkey descriptor is
                // wiped. Next reopen will show the enable checkbox
                // again instead of the broken passkey icon.
                logger.error('Passkey unlock: PRF refused, auto-clearing broken credential', e);
                const fileInfo = this.model.fileInfos.get(fileId);
                if (fileInfo) {
                    fileInfo.set({
                        passkeyCredentialId: null,
                        passkeyPrfSalt: null,
                        passkeyWrappedKey: null,
                        passkeyCreatedDate: null
                    });
                    this.model.fileInfos.save();
                }
                this.passkeyCredentialId = null;
                this.passkeyPrfSalt = null;
                this.passkeyWrappedKey = null;
                alerts.error({
                    header: loc.openError,
                    body:
                        loc.openPasskeyBrokenCleared ||
                        'Your previous passkey registration was removed because it cannot decrypt — please re-enable passkey unlock with a compatible authenticator.'
                });
                this.busy = false;
                this.$el.toggleClass('open--opening', false);
                this.inputEl.removeAttr('disabled');
                this.displayOpenPasskey();
                this.focusInput(true);
                return;
            } else {
                logger.error('Passkey unlock failed, falling back to password', e);
            }
            this.busy = false;
            this.$el.toggleClass('open--opening', false);
            this.inputEl.removeAttr('disabled');
            this.focusInput(true);
            return;
        }

        this.params.password = protectedPassword;
        this.params.encryptedPassword = null;
        // Do not re-enable passkey on a passkey-unlocked open — the
        // credential is already registered and the checkbox path is
        // explicitly for first-time enablement.
        this.enablePasskeyRequested = false;
        this.capturedPasswordForEnable = undefined;

        (this as any).afterPaint(() => {
            this.model.openFile(this.params, (err: any) => this.openDbComplete(err));
        });
    }

    passkeyEnableToggled(e: any): void {
        const target = e?.target as HTMLInputElement | undefined;
        this.enablePasskeyRequested = !!target?.checked;
    }

    passkeyCleared(): void {
        if (!this.params.id) return;
        const fileInfo = this.model.fileInfos.get(this.params.id);
        if (fileInfo) {
            fileInfo.set({
                passkeyCredentialId: null,
                passkeyPrfSalt: null,
                passkeyWrappedKey: null,
                passkeyCreatedDate: null
            });
            this.model.fileInfos.save();
        }
        this.passkeyCredentialId = null;
        this.passkeyPrfSalt = null;
        this.passkeyWrappedKey = null;
        this.displayOpenPasskey();
        logger.info('Passkey registration cleared for file', this.params.name);
    }

    openDbComplete(err: any): void {
        this.busy = false;
        this.$el.toggleClass('open--opening', false);
        const showInputError = err && !err.userCanceled;
        this.inputEl.removeAttr('disabled').toggleClass('input--error', !!showInputError);
        if (err) {
            // Always clear any captured plaintext password on failure —
            // even if the user requested enable, we should not hold it
            // past the open attempt. The next retry will recapture.
            this.capturedPasswordForEnable = undefined;
            logger.error('Error opening file', err);
            this.focusInput(true);
            this.inputEl[0].selectionStart = 0;
            this.inputEl[0].selectionEnd = this.inputEl.val().length;
            if (err.code === 'InvalidKey') {
                (InputFx as any).shake(this.inputEl);
            } else if (err.userCanceled) {
                // nothing to do
            } else {
                if (err.notFound) {
                    err = loc.openErrorFileNotFound;
                }
                let alertBody = loc.openErrorDescription;
                if (err.maybeTouchIdChanged) {
                    alertBody += '\n' + loc.openErrorDescriptionMaybeTouchIdChanged;
                }
                alerts.error({
                    header: loc.openError,
                    body: alertBody,
                    pre: this.errorToString(err)
                });
            }
            return;
        }

        // Successful open path. Run the enable-passkey flow BEFORE we
        // emit 'close' so the user sees any registration error or
        // success toast in the open modal context, not in an already-
        // transitioning view.
        const capturedPw = this.capturedPasswordForEnable;
        this.capturedPasswordForEnable = undefined;
        if (this.enablePasskeyRequested && capturedPw && this.params.id) {
            // Deliberately fire-and-forget: we don't want to block the
            // UI transition on the WebAuthn UV ceremony, and the flow
            // only needs to persist to FileInfoCollection which is a
            // synchronous write-through to SettingsStore.
            const fileId = this.params.id;
            const fileName = this.params.name;
            this.registerPasskeyForFile(fileId, fileName, capturedPw);
        }
        this.emit('close');
    }

    /**
     * Async tail of the enable-at-open flow. Registers a fresh passkey,
     * wraps the plaintext master password under the PRF-derived AES
     * key, and persists the four base64 fields to FileInfoModel via
     * FileInfoCollection.save().
     *
     * Runs after the open has completed so the user has already seen
     * their database unlock — the passkey prompt that pops afterwards
     * is clearly "this is registration, not unlock" from UX context.
     */
    async registerPasskeyForFile(
        fileId: string,
        fileName: string,
        masterPasswordText: string
    ): Promise<void> {
        try {
            const result = await enablePasskeyForFile(
                fileId,
                fileName,
                masterPasswordText
            );
            const fileInfo = this.model.fileInfos.get(fileId);
            if (!fileInfo) {
                logger.info(
                    'FileInfo gone after open, not persisting passkey registration'
                );
                return;
            }
            fileInfo.set({
                passkeyCredentialId: result.credentialIdBase64,
                passkeyPrfSalt: result.prfSaltBase64,
                passkeyWrappedKey: result.wrappedKeyBase64,
                passkeyCreatedDate: result.createdDate
            });
            this.model.fileInfos.save();
            logger.info('Passkey quick unlock enabled for file', fileName);
        } catch (e: any) {
            if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
                logger.info('Passkey registration cancelled by user', e.name);
                return;
            }
            // Specific PRF-not-supported branch — the authenticator
            // (or a Bitwarden / 1Password / Proton Pass extension that
            // hooked navigator.credentials.create) signed the
            // credential but did not enable PRF. The persisted
            // FileInfo state is untouched at this point because
            // `enablePasskeyForFile` throws BEFORE we reach the
            // `fileInfo.set(...)` call below — verified in passkey-prf
            // round-5 strict check. Surface the actionable copy.
            if (e instanceof PasskeyPrfNotSupportedError ||
                (e && e.name === 'PasskeyPrfNotSupportedError')) {
                logger.error('Passkey registration: authenticator did not enable PRF', e);
                let body: string;
                if (this.passkeyCapability &&
                    this.passkeyCapability.prf !== 'supported') {
                    const msg = this.formatPasskeyDiagMessage(this.passkeyCapability);
                    body = msg.reason;
                    if (msg.recommendation) {
                        body = `${body} ${msg.recommendation}`;
                    }
                } else {
                    body = e instanceof Error && e.message
                        ? e.message
                        : (loc.openPasskeyPrfUnsupported ||
                           'This authenticator does not support the PRF extension needed for passkey unlock.');
                }
                alerts.error({
                    header: loc.openError,
                    body
                });
                return;
            }
            logger.error('Passkey registration failed', e);
            alerts.error({
                header: loc.openError,
                body: loc.openPasskeyRegisterError || 'Passkey registration failed',
                pre: this.errorToString(e)
            });
        }
    }

    importDbWithXml(): void {
        if (this.busy || !this.params.name) {
            return;
        }
        this.$el.toggleClass('open--opening', true);
        this.inputEl.attr('disabled', 'disabled');
        this.busy = true;
        (this as any).afterPaint(() =>
            this.model.importFileWithXml(this.params, (err: any) => {
                if (err) {
                    this.params.name = '';
                    this.params.fileXml = null;
                }
                this.openDbComplete(err);
            })
        );
    }

    toggleMore(): void {
        if (this.busy) {
            return;
        }
        this.closeConfig();
        this.$el.find('.open__icons--lower').toggleClass('hide');
    }

    openSettings(): void {
        Events.emit('toggle-settings');
    }

    openStorage(e: any): void {
        if (this.busy) {
            return;
        }
        const storage = storageProvs[$(e.target).closest('.open__icon').data('storage')];
        if (!storage) {
            return;
        }
        if (storage.needShowOpenConfig && storage.needShowOpenConfig()) {
            this.showConfig(storage);
        } else if (storage.list) {
            this.listStorage(storage);
        } else {
            alerts.notImplemented();
        }
    }

    listStorage(storage: any, config?: any): void {
        if (this.busy) {
            return;
        }
        this.closeConfig();
        const icon = this.$el.find('.open__icon-storage[data-storage=' + storage.name + ']');
        this.busy = true;
        icon.toggleClass('flip3d', true);
        storage.list(config && config.dir, (err: any, files: any[]) => {
            icon.toggleClass('flip3d', false);
            this.busy = false;
            if (err || !files) {
                if (typeof err === 'object' && err && err.cors) {
                    this._showCorsDiagnostic(err.serverUrl || '', undefined);
                    return;
                }
                err = err ? err.toString() : '';
                if (err === 'browser-auth-started') {
                    return;
                }
                if (err.lastIndexOf('OAuth', 0) !== 0 && !alerts.alertDisplayed) {
                    alerts.error({
                        header: loc.openError,
                        body: loc.openListErrorBody,
                        pre: err.toString()
                    });
                }
                return;
            }
            if (!files.length) {
                alerts.error({
                    header: loc.openNothingFound,
                    body: loc.openNothingFoundBody
                });
                return;
            }

            const fileNameComparator = Comparators.stringComparator('path', true);
            files.sort((x: any, y: any) => {
                if (x.dir !== y.dir) {
                    return (y.dir ? 1 : 0) - (x.dir ? 1 : 0);
                }
                return fileNameComparator(x, y);
            });
            if (config && config.dir) {
                files.unshift({
                    path: config.prevDir,
                    name: '..',
                    dir: true
                });
            }
            const listView = new (StorageFileListView as any)({ files });
            listView.on('selected', (file: any) => {
                if (file.dir) {
                    this.listStorage(storage, {
                        dir: file.path,
                        prevDir: (config && config.dir) || ''
                    });
                } else {
                    this.openStorageFile(storage, file);
                }
            });
            alerts.alert({
                header: loc.openSelectFile,
                body: loc.openSelectFileBody,
                icon: storage.icon || 'file-alt',
                buttons: [{ result: '', title: loc.alertCancel }],
                esc: '',
                click: '',
                view: listView
            });
        });
    }

    openStorageFile(storage: any, file: any): void {
        if (this.busy) {
            return;
        }
        this.params.id = null;
        this.params.storage = storage.name;
        this.params.path = file.path;
        this.params.name = UrlFormat.getDataFileName(file.name);
        this.params.rev = file.rev;
        this.params.fileData = null;
        this.encryptedPassword = null;
        this.displayOpenFile();
        this.displayOpenDeviceOwnerAuth();
    }

    showConfig(storage: any): void {
        if (this.busy) {
            return;
        }
        const views = (this as any).views;
        if (views.openConfig) {
            views.openConfig.remove();
        }
        const config = {
            id: storage.name,
            name: loc[storage.name] || storage.name,
            icon: storage.icon,
            buttons: true,
            ...storage.getOpenConfig()
        };
        views.openConfig = new (OpenConfigView as any)(config, {
            parent: '.open__config-wrap'
        });
        views.openConfig.on('cancel', this.closeConfig.bind(this));
        views.openConfig.on('apply', this.applyConfig.bind(this));
        views.openConfig.render();
        this.$el.find('.open__pass-area').addClass('hide');
        this.$el.find('.open__icons--lower').addClass('hide');
    }

    closeConfig(): void {
        if (this.busy) {
            this.storageWaitId = null;
            this.busy = false;
        }
        const views = (this as any).views;
        if (views.openConfig) {
            views.openConfig.remove();
            delete views.openConfig;
        }
        this.$el.find('.open__pass-area').removeClass('hide');
        this.$el.find('.open__config').addClass('hide');
        this.focusInput();
    }

    applyConfig(config: any): void {
        if (this.busy || !config) {
            return;
        }
        this.busy = true;
        const views = (this as any).views;
        views.openConfig.setDisabled(true);
        const storage = storageProvs[config.storage];
        this.storageWaitId = Math.random();
        const path = config.path;
        const opts = omit(config, ['path', 'storage']);
        const req = {
            waitId: this.storageWaitId,
            storage: config.storage,
            path,
            opts
        };
        if (storage.applyConfig) {
            storage.applyConfig(opts, this.storageApplyConfigComplete.bind(this, req));
        } else {
            storage.stat(path, opts, this.storageStatComplete.bind(this, req));
        }
    }

    storageApplyConfigComplete(req: any, err: any): void {
        if (this.storageWaitId !== req.waitId) {
            return;
        }
        this.storageWaitId = null;
        this.busy = false;
        const views = (this as any).views;
        if (err) {
            if (typeof err === 'object' && err && err.cors) {
                views.openConfig.setDisabled(false);
                this._showCorsDiagnostic(err.serverUrl || req.path, req);
                return;
            }
            views.openConfig.setDisabled(false);
            views.openConfig.setError(err);
        } else {
            this.closeConfig();
        }
    }

    storageStatComplete(req: any, err: any, stat: any): void {
        if (this.storageWaitId !== req.waitId) {
            return;
        }
        this.storageWaitId = null;
        this.busy = false;
        const views = (this as any).views;
        if (err) {
            if (typeof err === 'object' && err && err.cors) {
                views.openConfig.setDisabled(false);
                this._showCorsDiagnostic(err.serverUrl || req.path, req);
                return;
            }
            views.openConfig.setDisabled(false);
            views.openConfig.setError(err);
        } else {
            this.closeConfig();
            this.params.id = null;
            this.params.storage = req.storage;
            this.params.path = req.path;
            this.params.opts = req.opts;
            this.params.name = UrlFormat.getDataFileName(req.path);
            this.params.rev = stat.rev;
            this.params.fileData = null;
            this.encryptedPassword = null;
            this.displayOpenFile();
            this.displayOpenDeviceOwnerAuth();
        }
    }

    _showCorsDiagnostic(serverUrl: string, req?: any): void {
        const views = (this as any).views;
        // Remove any existing CORS diagnostic view
        if (views.corsDiag) {
            views.corsDiag.remove();
            delete views.corsDiag;
        }
        const diagView = new CorsDiagnosticView({
            serverUrl,
            origin: window.location.origin
        });
        diagView.render();
        diagView.on('test-again', () => {
            // Re-run the stat request with the same params
            if (req) {
                diagView.closeModal();
                const storage = storageProvs[req.storage];
                if (storage) {
                    this.busy = true;
                    this.storageWaitId = Math.random();
                    const retryReq = { ...req, waitId: this.storageWaitId };
                    const configViews = (this as any).views;
                    if (configViews.openConfig) {
                        configViews.openConfig.setDisabled(true);
                    }
                    storage.stat(
                        req.path,
                        req.opts,
                        this.storageStatComplete.bind(this, retryReq)
                    );
                }
            }
        });
        diagView.on('closed', () => {
            delete views.corsDiag;
        });
        views.corsDiag = diagView;
    }

    moveOpenFileSelection(steps: number): void {
        const lastOpenFiles = this.getLastOpenFiles();
        if (
            this.currentSelectedIndex + steps >= 0 &&
            this.currentSelectedIndex + steps <= lastOpenFiles.length - 1
        ) {
            this.currentSelectedIndex = this.currentSelectedIndex + steps;
        }

        const lastOpenFile = lastOpenFiles[this.currentSelectedIndex];
        if (!lastOpenFile) {
            return;
        }
        const fileInfo = this.model.fileInfos.get(lastOpenFiles[this.currentSelectedIndex].id);
        this.showOpenFileInfo(fileInfo);
    }

    moveOpenFileSelectionDown(): void {
        this.moveOpenFileSelection(1);
    }

    moveOpenFileSelectionUp(): void {
        this.moveOpenFileSelection(-1);
    }

    toggleGenerator(e: any): void {
        e.stopPropagation();
        const views = (this as any).views;
        if (views.gen) {
            views.gen.remove();
            return;
        }
        const el = this.$el.find('.open__icon-generate');
        const rect = el[0].getBoundingClientRect();
        const pos: any = {
            left: rect.left,
            top: rect.top
        };
        if (features.isMobile) {
            pos.left = '50vw';
            pos.top = '50vh';
            pos.transform = 'translate(-50%, -50%)';
        }
        const generator = new (GeneratorView as any)({
            copy: true,
            noTemplateEditor: true,
            pos
        });
        generator.render();
        generator.once('remove', () => {
            delete views.gen;
        });
        views.gen = generator;
    }

    userIdle(): void {
        this.inputEl.val('');
        this.passwordInput.reset();
        this.passwordInput.setElement(this.inputEl);
    }

    usbDevicesChanged(): void {
        // No-op: YubiKey/USB support removed in web-only fork
    }

    errorToString(err: any): string | undefined {
        const str = err.toString();
        if (str !== {}.toString()) {
            return str;
        }
        if (err.ykError && err.code) {
            return loc.yubiKeyErrorWithCode.replace('{}', err.code);
        }
        return undefined;
    }

    setEncryptedPassword(fileInfo: any): void {
        this.encryptedPassword = null;
        if (!fileInfo.id) {
            return;
        }
        switch (this.model.settings.deviceOwnerAuth) {
            case 'memory':
                this.encryptedPassword = this.model.getMemoryPassword(fileInfo.id);
                break;
            case 'file':
                this.encryptedPassword = {
                    value: fileInfo.encryptedPassword,
                    date: fileInfo.encryptedPasswordDate
                };
                break;
        }
        this.checkIfEncryptedPasswordDateIsValid();
    }

    checkIfEncryptedPasswordDateIsValid(): void {
        if (this.encryptedPassword) {
            const maxDate = new Date(this.encryptedPassword.date);
            maxDate.setMinutes(
                maxDate.getMinutes() + this.model.settings.deviceOwnerAuthTimeoutMinutes
            );
            if (maxDate < new Date()) {
                this.encryptedPassword = null;
            }
        }
    }

    unlockMessageChanged(unlockMessageRes: string): void {
        const messageEl = (this as any).el.querySelector('.open__message');
        messageEl.classList.toggle('hide', !unlockMessageRes);

        if (unlockMessageRes) {
            const contentEl = (this as any).el.querySelector('.open__message-content');
            contentEl.innerText = loc[unlockMessageRes];
        }
    }

    openMessageCancelClick(): void {
        this.model.rejectPendingFileUnlockPromise('User canceled');
    }
}

export { OpenView };
