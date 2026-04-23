import { Locale } from 'util/locale';
import { ModalView } from 'views/modal-view';

interface AlertButton {
    result: string;
    title: string;
    // Optional styling flag — the modal template renders buttons with
    // `error: true` as the destructive/red variant. Read by the hbs
    // template, not this module.
    error?: boolean;
}

interface AlertConfig {
    header?: string;
    body?: string;
    icon?: string;
    buttons?: AlertButton[];
    // `esc` / `click` / `enter` hold the button result string to fire
    // when the user presses that key, OR `false` to disable that close
    // path entirely. Both shapes are used across legacy KeeWeb callers.
    esc?: string | false;
    click?: string | false;
    enter?: string | false;
    success?: (res: string, check?: boolean) => void;
    cancel?: () => void;
    complete?: (res: string, check?: boolean) => void;
    skipIfAlertDisplayed?: boolean;
    [key: string]: unknown;
}

const Alerts = {
    alertDisplayed: false,

    buttons: {
        ok: {
            result: 'yes',
            get title(): string {
                return Locale.alertOk;
            }
        },
        yes: {
            result: 'yes',
            get title(): string {
                return Locale.alertYes;
            }
        },
        allow: {
            result: 'yes',
            get title(): string {
                return Locale.alertAllow;
            }
        },
        no: {
            result: '',
            get title(): string {
                return Locale.alertNo;
            }
        },
        cancel: {
            result: '',
            get title(): string {
                return Locale.alertCancel;
            }
        },
        deny: {
            result: '',
            get title(): string {
                return Locale.alertDeny;
            }
        }
    },

    alert(config: AlertConfig): ModalView | null {
        if (config.skipIfAlertDisplayed && Alerts.alertDisplayed) {
            return null;
        }
        Alerts.alertDisplayed = true;
        const view = new ModalView(config);
        view.render();
        view.once('result', (...args: unknown[]) => {
            const res = args[0] as string;
            const check = args[1] as boolean;
            if (res && config.success) {
                config.success(res, check);
            }
            if (!res && config.cancel) {
                config.cancel();
            }
            if (config.complete) {
                config.complete(res, check);
            }
        });
        view.on('will-close', () => {
            Alerts.alertDisplayed = false;
        });
        return view;
    },

    notImplemented(): void {
        this.alert({
            header: Locale.notImplemented,
            body: '',
            icon: 'exclamation-triangle',
            buttons: [this.buttons.ok],
            esc: '',
            click: '',
            enter: ''
        });
    },

    info(config: AlertConfig): void {
        this.alert({
            header: '',
            body: '',
            icon: 'info',
            buttons: [this.buttons.ok],
            esc: '',
            click: '',
            enter: '',
            ...config
        });
    },

    error(config: AlertConfig): void {
        this.alert({
            header: '',
            body: '',
            icon: 'exclamation-circle',
            buttons: [this.buttons.ok],
            esc: '',
            click: '',
            enter: '',
            ...config
        });
    },

    yesno(config: AlertConfig): void {
        this.alert({
            header: '',
            body: '',
            icon: 'question',
            buttons: [this.buttons.yes, this.buttons.no],
            esc: '',
            click: '',
            enter: 'yes',
            ...config
        });
    }
};

export { Alerts };
export type { AlertConfig, AlertButton };
