import { View } from 'framework/views/view';
import { Events } from 'framework/events';
import template from 'templates/details/details-issues.hbs';
import { Alerts } from 'comp/ui/alerts';
import { Timeouts } from 'const/timeouts';
import { Locale } from 'util/locale';
import { passwordStrength, PasswordStrengthLevel } from 'util/data/password-strength';
import { AppSettingsModel } from 'models/app-settings-model';
import { Links } from 'const/links';
import { checkIfPasswordIsExposedOnline } from 'comp/app/online-password-checker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loc = Locale as unknown as Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const alerts = Alerts as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settings = AppSettingsModel as unknown as any;

class DetailsIssuesView extends View {
    parent = '.details__issues-container';

    template = template;

    events: Record<string, string> = {
        'click .details__issues-close-btn': 'closeIssuesClick'
    };

    passwordIssue: string | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(model: any) {
        super(model);
        this.listenTo(AppSettingsModel, 'change', this.settingsChanged);
        if (settings.auditPasswords) {
            this.checkPasswordIssues();
        }
    }

    render(options?: { fadeIn?: boolean }): this | undefined {
        if (!settings.auditPasswords) {
            super.render();
            return this;
        }
        super.render({
            hibpLink: Links.HaveIBeenPwned,
            passwordIssue: this.passwordIssue,
            fadeIn: options?.fadeIn
        });
        return this;
    }

    settingsChanged(): void {
        if (settings.auditPasswords) {
            this.checkPasswordIssues();
        }
        this.render();
    }

    passwordChanged(): void {
        const oldPasswordIssue = this.passwordIssue;
        this.checkPasswordIssues();
        if (oldPasswordIssue !== this.passwordIssue) {
            const fadeIn = !oldPasswordIssue;
            if (this.passwordIssue) {
                this.render({ fadeIn });
            } else {
                this.el.classList.add('fade-out');
                setTimeout(() => this.render(), Timeouts.FastAnimation);
            }
        }
    }

    checkPasswordIssues(): void {
        if (!this.model.canCheckPasswordIssues()) {
            this.passwordIssue = null;
            return;
        }
        const { password } = this.model;
        if (!password || !password.isProtected || !password.byteLength) {
            this.passwordIssue = null;
            return;
        }
        const auditEntropy = settings.auditPasswordEntropy;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const strength: any = passwordStrength(password);
        if (
            settings.excludePinsFromAudit &&
            strength.onlyDigits &&
            strength.length <= 6
        ) {
            this.passwordIssue = null;
        } else if (auditEntropy && strength.level < PasswordStrengthLevel.Low) {
            this.passwordIssue = 'poor';
        } else if (auditEntropy && strength.level < PasswordStrengthLevel.Good) {
            this.passwordIssue = 'weak';
        } else if (settings.auditPasswordAge && this.isOld()) {
            this.passwordIssue = 'old';
        } else {
            this.passwordIssue = null;
            this.checkOnHIBP();
        }
    }

    isOld(): boolean {
        if (!this.model.updated) {
            return false;
        }
        const dt = new Date(this.model.updated);
        dt.setFullYear(dt.getFullYear() + settings.auditPasswordAge);
        return dt.getTime() < Date.now();
    }

    checkOnHIBP(): void {
        if (!settings.checkPasswordsOnHIBP) {
            return;
        }
        const isExposed = checkIfPasswordIsExposedOnline(this.model.password) as
            | boolean
            | Promise<boolean | undefined>;
        if (typeof isExposed === 'boolean') {
            this.passwordIssue = isExposed ? 'pwned' : null;
        } else {
            const iconEl = this.el?.querySelector('.details__issues-icon');
            iconEl?.classList.add('details__issues-icon--loading');
            isExposed.then((exposed) => {
                if (exposed) {
                    this.passwordIssue = 'pwned';
                } else if (exposed === false) {
                    if (this.passwordIssue === 'pwned') {
                        this.passwordIssue = null;
                    }
                } else {
                    this.passwordIssue = iconEl ? 'error' : null;
                }
                this.render();
            });
        }
    }

    closeIssuesClick(): void {
        alerts.alert({
            header: loc.detIssueCloseAlertHeader,
            body: loc.detIssueCloseAlertBody,
            icon: 'exclamation-triangle',
            buttons: [
                { result: 'entry', title: loc.detIssueCloseAlertEntry, silent: true },
                {
                    result: 'settings',
                    title: loc.detIssueCloseAlertSettings,
                    silent: true
                },
                alerts.buttons.cancel
            ],
            esc: '',
            click: '',
            success: (result: string) => {
                switch (result) {
                    case 'entry':
                        this.disableAuditForEntry();
                        break;
                    case 'settings':
                        this.openAuditSettings();
                        break;
                }
            }
        });
    }

    disableAuditForEntry(): void {
        this.model.setIgnorePasswordIssues();
        this.checkPasswordIssues();
        this.render();
    }

    openAuditSettings(): void {
        Events.emit('toggle-settings', 'general', 'audit');
    }
}

export { DetailsIssuesView };
