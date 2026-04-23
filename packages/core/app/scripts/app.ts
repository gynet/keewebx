import '../styles/main.scss';
import { Events } from 'framework/events';
import { StartProfiler } from 'comp/app/start-profiler';
import { FileInfoCollection } from 'collections/file-info-collection';
import { ExportApi } from 'comp/app/export-api';
import { BrowserExtensionConnector } from 'comp/extension/browser-extension-connector';
import { FeatureTester } from 'comp/browser/feature-tester';
import { FocusDetector } from 'comp/browser/focus-detector';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { ThemeWatcher } from 'comp/browser/theme-watcher';
import { KeyHandler } from 'comp/browser/key-handler';
import { SettingsManager } from 'comp/settings/settings-manager';
import { Alerts } from 'comp/ui/alerts';
import { Timeouts } from 'const/timeouts';
import { AppModel } from 'models/app-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { RuntimeDataModel } from 'models/runtime-data-model';
import { UpdateModel } from 'models/update-model';
import { Features } from 'util/features';
import { KdbxwebInit } from 'util/kdbxweb/kdbxweb-init';
import { Locale } from 'util/locale';
import { AppView } from 'views/app-view';
import 'hbs-helpers';
import 'hooks/init';
import { applyRegisteredSettings } from 'const/default-app-settings';
import { applyRegisteredFileInfoFields } from 'models/file-info-model';
import { applyRegisteredStorages, Storage } from 'storage';
import { getRegisteredSettings } from 'hooks/data-registry';

applyRegisteredSettings();
const regSettings = Object.fromEntries(getRegisteredSettings());
if (Object.keys(regSettings).length) {
    (AppSettingsModel as unknown as { set(p: Record<string, unknown>, o: { silent: boolean }): void })
        .set(regSettings, { silent: true });
}
applyRegisteredFileInfoFields();
applyRegisteredStorages();

const loc = Locale as Record<string, string | undefined>;

// Build identity — injected by webpack.DefinePlugin at build time. Emit on
// startup so the browser console, Playwright `page.evaluate`, and manual
// smoke tests can all verify the exact commit + time this bundle was built
// from. Also exposed on `window` so E2E live-drift tests can read it
// without needing source maps or bundle scraping.
console.info(
    `KeeWebX build ${__KEEWEBX_BUILD_SHA_SHORT__} (${__KEEWEBX_BUILD_TIME__})`
);
(window as unknown as Record<string, unknown>).__KEEWEBX_BUILD_SHA__ =
    __KEEWEBX_BUILD_SHA__;
(window as unknown as Record<string, unknown>).__KEEWEBX_BUILD_SHA_SHORT__ =
    __KEEWEBX_BUILD_SHA_SHORT__;
(window as unknown as Record<string, unknown>).__KEEWEBX_BUILD_TIME__ =
    __KEEWEBX_BUILD_TIME__;

StartProfiler.milestone('loading modules');

$(() => {
    StartProfiler.milestone('document ready');

    const appModel = new AppModel();
    StartProfiler.milestone('creating app model');

    Promise.resolve()
        .then(loadConfigs)
        .then(initModules)
        .then(loadRemoteConfig)
        .then(ensureCanRun)
        .then(initStorage)
        .then(showApp)
        .then(postInit)
        .catch((e: unknown) => {
            appModel.appLogger.error('Error starting app', e);
        });

    function ensureCanRun(): Promise<void> {
        if (Features.isFrame && !appModel.settings.allowIframes) {
            return Promise.reject(
                'Running in iframe is not allowed (this can be changed in the app config).'
            );
        }
        return FeatureTester.test()
            .catch((e: unknown) => {
                Alerts.error({
                    header: loc.appSettingsError,
                    body: loc.appNotSupportedError,
                    pre: e,
                    buttons: [],
                    esc: false,
                    enter: false,
                    click: false
                });
                throw 'Feature testing failed: ' + e;
            })
            .then(() => {
                StartProfiler.milestone('checking features');
            });
    }

    function loadConfigs(): Promise<void> {
        return Promise.all([
            AppSettingsModel.load(),
            UpdateModel.load(),
            RuntimeDataModel.load(),
            FileInfoCollection.load()
        ]).then(() => {
            StartProfiler.milestone('loading configs');
        });
    }

    function initModules(): void {
        KeyHandler.init();
        KdbxwebInit.init();
        FocusDetector.init();
        ThemeWatcher.init();
        SettingsManager.init();
        (window as Window & { kw?: typeof ExportApi }).kw = ExportApi;
        StartProfiler.milestone('initializing modules');
    }

    function showSettingsLoadError(): void {
        Alerts.error({
            header: loc.appSettingsError,
            body: loc.appSettingsErrorBody,
            buttons: [],
            esc: false,
            enter: false,
            click: false
        });
    }

    function loadRemoteConfig(): Promise<void> {
        return Promise.resolve()
            .then(() => {
                SettingsManager.setBySettings();
                const configParam = getConfigParam();
                if (configParam) {
                    return appModel
                        .loadConfig(configParam)
                        .then(() => {
                            SettingsManager.setBySettings();
                        })
                        .catch((e: unknown) => {
                            if (!appModel.settings.cacheConfigSettings) {
                                showSettingsLoadError();
                                throw e;
                            }
                        });
                }
                return undefined;
            })
            .then(() => {
                StartProfiler.milestone('loading remote config');
            });
    }

    function initStorage(): void {
        for (const prv of Object.values(Storage as unknown as Record<string, any>)) {
            prv.init();
        }
        StartProfiler.milestone('initializing storage');
    }

    function showApp(): Promise<void> {
        return Promise.resolve().then(() => {
            const skipHttpsWarning =
                localStorage.getItem('skipHttpsWarning') || appModel.settings.skipHttpsWarning;
            const protocolIsInsecure = ['https:', 'file:', 'app:'].indexOf(location.protocol) < 0;
            const hostIsInsecure = location.hostname !== 'localhost';
            if (protocolIsInsecure && hostIsInsecure && !skipHttpsWarning) {
                return new Promise<void>((resolve) => {
                    Alerts.error({
                        header: loc.appSecWarn,
                        icon: 'user-secret',
                        esc: false,
                        enter: false,
                        click: false,
                        body: loc.appSecWarnBody1 + '\n\n' + loc.appSecWarnBody2,
                        buttons: [{ result: '', title: loc.appSecWarnBtn ?? '', error: true }],
                        complete: () => {
                            showView();
                            resolve();
                        }
                    });
                });
            } else {
                showView();
                return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            }
        });
    }

    function postInit(): void {
        setTimeout(() => {
            IdleTracker.init();
            BrowserExtensionConnector.init(appModel);
        }, Timeouts.AutoUpdatePluginsAfterStart);
    }

    function showView(): void {
        new AppView(appModel).render();
        StartProfiler.milestone('first view rendering');

        Events.emit('app-ready');
        StartProfiler.milestone('app ready event');

        StartProfiler.report();
    }

    function getConfigParam(): string | undefined {
        const metaConfig = document.head.querySelector(
            'meta[name=kw-config]'
        ) as HTMLMetaElement | null;
        if (metaConfig && metaConfig.content && metaConfig.content[0] !== '(') {
            return metaConfig.content;
        }
        const match = location.search.match(/[?&]config=([^&]+)/i);
        if (match && match[1]) {
            return match[1];
        }
        return undefined;
    }
});
