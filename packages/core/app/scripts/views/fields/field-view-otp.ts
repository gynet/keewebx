/* eslint-disable @typescript-eslint/no-explicit-any */
import { Timeouts } from 'const/timeouts';
import { FieldViewText } from 'views/fields/field-view-text';
import { Locale } from 'util/locale';
import { StringFormat } from 'util/formatting/string-format';

const loc = Locale as unknown as Record<string, any>;
const timeouts = Timeouts as unknown as { OtpFadeDuration: number };

const MinOpacity = 0.1;

class FieldViewOtp extends FieldViewText {
    otpTimeout: any = null;
    otpTickInterval: any = null;
    otpValue: string | null = null;
    otpGenerator: any = null;
    otpTimeLeft = 0;
    otpValidUntil = 0;
    fieldOpacity: number | null = null;
    otpState: string | null = null;

    constructor(model: any, options?: any) {
        super(model, options);
        this.once('remove', () => this.stopOtpUpdater());
        if (model.readonly) {
            this.readonly = true;
        }
    }

    renderValue(value: any): string {
        if (!value) {
            this.resetOtp();
            return '';
        }
        if (value !== this.otpGenerator) {
            this.resetOtp();
            this.otpGenerator = value;
            this.requestOtpUpdate();
        }
        if (this.otpValue) {
            return this.otpValue;
        }
        switch (this.otpState) {
            case 'awaiting-command':
                return loc.detOtpClickToTouch as string;
            case 'awaiting-touch':
                return (loc.detOtpTouch as string).replace('{}', this.model.deviceShortName);
            case 'error':
                return StringFormat.capFirst(loc.error as string);
            case 'generating':
                return loc.detOtpGenerating as string;
            default:
                return '';
        }
    }

    getEditValue(value: any): string {
        return value && value.url;
    }

    getTextValue(): string {
        return this.otpValue ?? '';
    }

    render(): this | undefined {
        super.render();
        this.fieldOpacity = null;
        this.otpTick();
        return this;
    }

    resetOtp(): void {
        this.otpGenerator = null;
        this.otpValue = null;
        this.otpTimeLeft = 0;
        this.otpValidUntil = 0;
        this.otpState = null;
        if (this.otpTimeout) {
            clearTimeout(this.otpTimeout);
            this.otpTimeout = null;
        }
        if (this.otpTickInterval) {
            clearInterval(this.otpTickInterval);
            this.otpTickInterval = null;
        }
    }

    requestOtpUpdate(): void {
        if (this.value) {
            if (this.model.needsTouch) {
                this.otpState = 'awaiting-command';
            } else {
                this.otpState = 'generating';
                this.value.next(this.otpUpdated.bind(this));
            }
        }
    }

    otpUpdated(err: any, pass: string | undefined, timeLeft: number | undefined): void {
        if (this.removed) {
            return;
        }
        if (err) {
            this.otpState = 'error';
            this.render();
            return;
        }
        if (!this.value || !pass) {
            this.resetOtp();
            return;
        }
        this.otpValue = pass;
        this.otpTimeLeft = timeLeft || 0;
        this.otpValidUntil = Date.now() + (timeLeft ?? 0);
        if (!this.editing) {
            this.render();
        }
        if (this.otpValue && timeLeft) {
            this.otpTimeout = setTimeout(() => {
                this.requestOtpUpdate();
                if (this.otpTickInterval) {
                    clearInterval(this.otpTickInterval);
                    this.otpTickInterval = null;
                }
                if (this.model.needsTouch) {
                    this.fieldOpacity = null;
                    this.otpValue = null;
                    this.otpValidUntil = 0;
                    this.otpTimeLeft = 0;
                    this.valueEl.css('opacity', 1);
                }
                this.render();
            }, timeLeft);
            if (!this.otpTickInterval) {
                this.otpTickInterval = setInterval(this.otpTick.bind(this), 300);
            }
        }
    }

    otpTick(): void {
        if (!this.value || !this.otpValidUntil) {
            return;
        }
        let opacity;
        const timeLeft = this.otpValidUntil - Date.now();
        if (timeLeft >= timeouts.OtpFadeDuration || this.editing) {
            opacity = 1;
        } else if (timeLeft <= 0) {
            opacity = MinOpacity;
        } else {
            opacity = Math.max(MinOpacity, Math.pow(timeLeft / timeouts.OtpFadeDuration, 2));
        }
        if (this.fieldOpacity === opacity) {
            return;
        }
        this.fieldOpacity = opacity;
        this.valueEl.css('opacity', opacity);
    }

    copyValue(): void {
        this.refreshOtp((err: any) => {
            if (!err) {
                super.copyValue();
            }
        });
    }

    refreshOtp(callback: (err?: any) => void): void {
        if (this.model.needsTouch) {
            if (this.otpValue) {
                callback();
            } else {
                this.requestTouch(callback);
            }
        } else {
            callback();
        }
    }

    requestTouch(callback: (err?: any) => void): void {
        this.otpState = 'awaiting-touch';
        this.value.next((err: any, code: string | undefined, timeLeft: number | undefined) => {
            this.otpUpdated(err, code, timeLeft);
            callback(err);
        });
        this.render();
    }

    stopOtpUpdater(): void {
        if (this.otpState === 'awaiting-touch') {
            if (this.value && this.value.cancel) {
                this.value.cancel();
            }
        }
        this.resetOtp();
    }
}

export { FieldViewOtp };
