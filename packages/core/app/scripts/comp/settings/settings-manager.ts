/**
 * SettingsManager — applies AppSettings to the live DOM: theme class on
 * <body>, root fontSize, locale hot-swap, dark-mode auto-switching.
 *
 * History: this file was stubbed in commit `a436c401` when the Electron
 * `Launcher` module was stripped. The stub exposed only 1 locale and 2
 * themes and every setter was a no-op, leaving the settings UI silently
 * dead — users could click the theme picker but nothing changed,
 * fontSize slider was inert, locale dropdown only showed English even
 * though `de-DE.json` and `fr-FR.json` ship in the bundle. Restored
 * from upstream KeeWeb (commit 2cafd5a9), adapted for TypeScript strict
 * and simplified to web-only (the only branch removed is the Electron
 * `ipcRenderer.invoke('setLocale', ...)` call at the bottom of
 * `setLocale`, which pushed a locale dictionary into the desktop menu
 * bar that doesn't exist in web mode).
 *
 * The 12 themes (`dark`, `light`, `sd`, `sl`, `fb`, `bl`, `db`, `lb`,
 * `te`, `lt`, `dc`, `hc`) and their auto-switched-pair configuration
 * match the SCSS in `packages/core/app/styles/themes/_all-themes.scss`
 * exactly, so removing one from this table would break the generated
 * CSS classes referenced by `setTheme` below.
 */

import { Events } from 'framework/events';
import { Features } from 'util/features';
import { Locale } from 'util/locale';
import { ThemeWatcher } from 'comp/browser/theme-watcher';
import { AppSettingsModel } from 'models/app-settings-model';
import { Logger } from 'util/logger';

const logger = new Logger('settings-manager');

// Loose typing: these singletons are proxy-backed Model instances and
// the surrounding app code accesses them with broad `as unknown as`
// casts. Mirroring that pattern here keeps the file consistent with
// app.ts, app-view.ts, and settings-general-view.ts.
const features = Features as unknown as { isMobile: boolean };
const appSettings = AppSettingsModel as unknown as {
    theme: string | null;
    fontSize: number | null;
    locale: string | null;
    autoSwitchTheme: boolean;
};
const themeWatcher = ThemeWatcher as unknown as { dark: boolean };
const events = Events as unknown as {
    on(name: string, handler: (...args: unknown[]) => void): void;
    emit(name: string, ...args: unknown[]): void;
};

interface AutoSwitchedTheme {
    name: string;
    dark: string;
    light: string;
}

const SettingsManager = {
    neutralLocale: null as Record<string, string> | null,
    activeLocale: 'en-US' as string,
    activeTheme: null as string | null,

    allLocales: {
        'en-US': 'English',
        'de-DE': 'Deutsch',
        'fr-FR': 'Français'
    } as Record<string, string>,

    // Keys are theme IDs (-> `th-<id>` CSS class); values are Locale
    // keys (-> translated display names rendered by
    // settings-general-view).
    allThemes: {
        dark: 'setGenThemeDark',
        light: 'setGenThemeLight',
        sd: 'setGenThemeSd',
        sl: 'setGenThemeSl',
        fb: 'setGenThemeFb',
        bl: 'setGenThemeBl',
        db: 'setGenThemeDb',
        lb: 'setGenThemeLb',
        te: 'setGenThemeTe',
        lt: 'setGenThemeLt',
        dc: 'setGenThemeDc',
        hc: 'setGenThemeHc'
    } as Record<string, string>,

    autoSwitchedThemes: [
        { name: 'setGenThemeDefault', dark: 'dark', light: 'light' },
        { name: 'setGenThemeSol', dark: 'sd', light: 'sl' },
        { name: 'setGenThemeBlue', dark: 'fb', light: 'bl' },
        { name: 'setGenThemeBrown', dark: 'db', light: 'lb' },
        { name: 'setGenThemeTerminal', dark: 'te', light: 'lt' },
        { name: 'setGenThemeHighContrast', dark: 'dc', light: 'hc' }
    ] as AutoSwitchedTheme[],

    customLocales: {} as Record<string, Record<string, string>>,

    init(): void {
        events.on('dark-mode-changed', () => this.darkModeChanged());
    },

    setBySettings(): void {
        this.setTheme(appSettings.theme);
        this.setFontSize(appSettings.fontSize ?? 0);
        const locale = appSettings.locale;
        try {
            if (locale) {
                this.setLocale(locale);
            } else {
                this.setLocale(this.getBrowserLocale());
            }
        } catch {
            /* swallow — bad locale string must not brick app boot */
        }
    },

    getDefaultTheme(): string {
        return 'dark';
    },

    setTheme(theme: string | null | undefined): void {
        if (!theme) {
            if (this.activeTheme) {
                return;
            }
            theme = this.getDefaultTheme();
        }
        for (const cls of Array.from(document.body.classList)) {
            if (/^th-/.test(cls)) {
                document.body.classList.remove(cls);
            }
        }
        if (appSettings.autoSwitchTheme) {
            theme = this.selectDarkOrLightTheme(theme);
        }
        document.body.classList.add(this.getThemeClass(theme));
        const metaThemeColor = document.head.querySelector<HTMLMetaElement>(
            'meta[name=theme-color]'
        );
        if (metaThemeColor) {
            metaThemeColor.content = window.getComputedStyle(document.body).backgroundColor;
        }
        this.activeTheme = theme;
        logger.debug('Theme changed', theme);
        events.emit('theme-applied');
    },

    getThemeClass(theme: string): string {
        return 'th-' + theme;
    },

    selectDarkOrLightTheme(theme: string): string {
        for (const config of this.autoSwitchedThemes) {
            if (config.light === theme || config.dark === theme) {
                return themeWatcher.dark ? config.dark : config.light;
            }
        }
        return theme;
    },

    darkModeChanged(): void {
        if (appSettings.autoSwitchTheme) {
            for (const config of this.autoSwitchedThemes) {
                if (config.light === this.activeTheme || config.dark === this.activeTheme) {
                    const newTheme = themeWatcher.dark ? config.dark : config.light;
                    logger.debug('Setting theme triggered by system settings change', newTheme);
                    this.setTheme(newTheme);
                    break;
                }
            }
        }
    },

    setFontSize(fontSize: number | null | undefined): void {
        const defaultFontSize = features.isMobile ? 14 : 12;
        document.documentElement.style.fontSize =
            defaultFontSize + (fontSize || 0) * 2 + 'px';
    },

    setLocale(loc: string | null | undefined): void {
        if (!loc || loc === this.activeLocale) {
            return;
        }
        let localeValues: Record<string, string> | undefined;
        if (loc !== 'en-US') {
            if (this.customLocales[loc]) {
                localeValues = this.customLocales[loc];
            } else {
                // Webpack resolves this as a JSON import at build time.
                // Path is relative to this file:
                // app/scripts/comp/settings/ -> ../../locales/<loc>.json
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                localeValues = require('../../locales/' + loc + '.json');
            }
        }
        if (!this.neutralLocale) {
            this.neutralLocale = { ...(Locale as unknown as Record<string, string>) };
        }
        Object.assign(
            Locale as unknown as Record<string, string>,
            this.neutralLocale,
            localeValues ?? {}
        );
        this.activeLocale = loc;
        events.emit('set-locale', loc);
    },

    getBrowserLocale(): string {
        const language =
            (navigator.languages && navigator.languages[0]) || navigator.language;
        if (language && language.startsWith('en')) {
            return 'en-US';
        }
        return language;
    }
};

export { SettingsManager };
