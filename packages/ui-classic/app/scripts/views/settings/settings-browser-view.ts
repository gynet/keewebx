/* eslint-disable @typescript-eslint/no-explicit-any */
import { Events } from 'framework/events';
import { View } from 'framework/views/view';
import template from 'templates/settings/settings-browser.hbs';
import { Features } from 'util/features';
import { Links } from 'const/links';
import { AppSettingsModel } from 'models/app-settings-model';
import { RuntimeDataModel } from 'models/runtime-data-model';
import { Locale } from 'util/locale';
import {
    BrowserExtensionConnector,
    SupportedBrowsers,
    SupportedExtensions
} from 'comp/extension/browser-extension-connector';
import { Alerts } from 'comp/ui/alerts';
import { DateFormat } from 'comp/i18n/date-format';

const loc = Locale as unknown as Record<string, any>;
const links = Links as unknown as Record<string, string | undefined>;
const features = Features as unknown as {
    isDesktop: boolean;
    browserIcon: string;
    extensionBrowserFamily: string;
};
const settings = AppSettingsModel as unknown as Record<string, any>;
const runtimeData = RuntimeDataModel as unknown as Record<string, any>;
const alerts = Alerts as unknown as { yesno(opts: any): void };
const browserExt = BrowserExtensionConnector as unknown as {
    sessions: any[];
    isEnabled(): boolean;
    enable(browser: string, extension: string, enabled: boolean): void;
    setClientPermissions(clientId: string, perms: any): void;
    getClientPermissions(clientId: string): any;
    terminateConnection(connectionId: string): void;
};

class SettingsBrowserView extends View {
    template = template;

    appModel: any;

    events: Record<string, string> = {
        'change .check-enable-for-browser': 'changeEnableForBrowser',
        'change .settings__browser-focus-if-locked': 'changeFocusIfLocked',
        'change .settings__browser-focus-if-empty': 'changeFocusIfEmpty',
        'change .settings__browser-session-ask-get': 'changeSessionAskGet',
        'change .settings__browser-session-ask-save': 'changeSessionAskSave',
        'change .settings__browser-session-file-check': 'changeSessionFileAccess',
        'click .settings__browser-btn-terminate-session': 'terminateSession'
    };

    constructor(model: any, options?: any) {
        super(model, options);

        this.listenTo(Events, 'browser-extension-sessions-changed', this.render);
    }

    render(): this | undefined {
        const data: any = {
            desktop: features.isDesktop,
            icon: features.browserIcon,
            focusIfLocked: settings.extensionFocusIfLocked,
            focusIfEmpty: settings.extensionFocusIfEmpty,
            sessions: browserExt.sessions.map((session) => {
                const fileAccess = this.getSessionFileAccess(session);
                return {
                    ...session,
                    fileAccess,
                    noFileAccess: fileAccess && !fileAccess.some((f: any) => f.checked),
                    showAskSave: session.permissions?.askSave !== undefined,
                    connectedDate: DateFormat.dtStr(session.connectedDate)
                };
            })
        };
        if (features.isDesktop) {
            data.extensionNames = ['KeeWeb Connect', 'KeePassXC-Browser'];
            data.settingsPerBrowser = this.getSettingsPerBrowser();
            data.anyBrowserIsEnabled = browserExt.isEnabled();
        } else {
            const extensionBrowserFamily = features.extensionBrowserFamily;
            data.extensionBrowserFamily = features.extensionBrowserFamily;
            data.extensionDownloadLink = links[`KWCFor${extensionBrowserFamily}`];
        }
        super.render(data);
        return this;
    }

    getSettingsPerBrowser(): any[] {
        return SupportedBrowsers.map((browser: string) => {
            const browserName =
                browser === 'Other' ? (loc.setBrowserOtherBrowsers as string) : browser;
            const extensions = SupportedExtensions.map((ext: any) => {
                ext = {
                    ...ext,
                    supported: true,
                    enabled: !!settings[`extensionEnabled${ext.alias}${browser}`],
                    installUrl: links[`${ext.alias}For${browser}`]
                };
                if (ext.alias === 'KPXC') {
                    ext.manualUrl = links.ExtensionHelpForKPXC;
                }
                if (!ext.installUrl) {
                    if (browser === 'Other') {
                        ext.helpUrl = links.ExtensionHelpForOtherBrowsers;
                    } else {
                        ext.supported = false;
                    }
                }
                return ext;
            });
            return { browser, browserName, extensions };
        });
    }

    getSessionFileAccess(session: any): any[] | undefined {
        if (!session.permissions) {
            return undefined;
        }

        const files = this.appModel.files.map((file: any) => ({
            id: file.id,
            name: file.name,
            checked: session.permissions.files.includes(file.id) || session.permissions.allFiles
        }));

        for (const fileId of session.permissions.files) {
            if (!this.appModel.files.get(fileId)) {
                const fileInfo = this.appModel.fileInfos.get(fileId);
                if (fileInfo) {
                    files.push({ id: fileId, name: fileInfo.name, checked: true });
                }
            }
        }

        files.push({
            id: 'all',
            name: files.length
                ? (loc.extensionConnectAllOtherFiles as string)
                : (loc.extensionConnectAllFiles as string),
            checked: session.permissions.allFiles
        });

        return files;
    }

    changeEnableForBrowser(e: any): void {
        const enabled = e.target.checked;
        const browser = e.target.dataset.browser;
        const extension = e.target.dataset.extension;

        if (enabled && extension === 'KPXC' && !runtimeData.kpxcExtensionWarningShown) {
            e.target.checked = false;

            alerts.yesno({
                icon: 'exclamation-triangle',
                header: (loc.setBrowserExtensionKPXCWarnHeader as string).replace('{}', 'KeePassXC'),
                body:
                    (loc.setBrowserExtensionKPXCWarnBody1 as string).replace(/{}/g, 'KeePassXC') +
                    '\n' +
                    (loc.setBrowserExtensionKPXCWarnBody2 as string),
                success: () => {
                    runtimeData.kpxcExtensionWarningShown = true;
                    this.enableForBrowser(enabled, browser, extension);
                }
            });
        } else {
            this.enableForBrowser(enabled, browser, extension);
        }
    }

    enableForBrowser(enabled: boolean, browser: string, extension: string): void {
        const setting = `extensionEnabled${extension}${browser}`;
        if (setting) {
            settings[setting] = enabled;
        } else {
            delete settings[setting];
        }

        browserExt.enable(browser, extension, enabled);

        this.render();
    }

    changeFocusIfLocked(e: any): void {
        settings.extensionFocusIfLocked = e.target.checked;
        this.render();
    }

    changeFocusIfEmpty(e: any): void {
        settings.extensionFocusIfEmpty = e.target.checked;
        this.render();
    }

    changeSessionAskGet(e: any): void {
        const clientId = e.target.dataset.clientId;
        const askGet = e.target.value;

        browserExt.setClientPermissions(clientId, { askGet });
    }

    changeSessionAskSave(e: any): void {
        const clientId = e.target.dataset.clientId;
        const askSave = e.target.value;

        browserExt.setClientPermissions(clientId, { askSave });
    }

    changeSessionFileAccess(e: any): void {
        const clientId = e.target.dataset.clientId;
        const fileId = e.target.dataset.fileId;
        const enabled = e.target.checked;

        if (fileId === 'all') {
            const allFiles = enabled;
            const permChanges: { allFiles: boolean; files?: string[] } = { allFiles };
            if (allFiles) {
                permChanges.files = this.appModel.files.map((f: any) => f.id);
            }
            browserExt.setClientPermissions(clientId, permChanges);
        } else {
            const permissions = browserExt.getClientPermissions(clientId);
            let files;
            if (enabled) {
                files = permissions.files.concat(fileId);
            } else {
                files = permissions.files.filter((f: string) => f !== fileId);
            }
            const permChanges: { files: string[]; allFiles?: boolean } = { files };
            if (!enabled) {
                permChanges.allFiles = false;
            }
            browserExt.setClientPermissions(clientId, permChanges);
        }
        this.render();
    }

    terminateSession(e: any): void {
        const connectionId = e.target.dataset.connectionId;
        browserExt.terminateConnection(connectionId);
    }
}

export { SettingsBrowserView };
