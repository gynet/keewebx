import QrCode from 'jsqrcode';
import { Events } from 'framework/events';
import { Shortcuts } from 'comp/app/shortcuts';
import { Alerts } from 'comp/ui/alerts';
import { Otp } from 'util/data/otp';
import { Features } from 'util/features';
import { Locale } from 'util/locale';
import { Logger } from 'util/logger';

const logger = new Logger('otp-qr-reader');

// Minimal structural type for the alert instance returned by Alerts.alert.
interface AlertHandle {
    change?(config: { header?: string; body?: string }): void;
    closeImmediate?(): void;
}

class OtpQrReader {
    alert: AlertHandle | null = null;

    fileInput: HTMLInputElement | null = null;

    constructor() {
        this.pasteEvent = this.pasteEvent.bind(this);
        this.fileSelected = this.fileSelected.bind(this);
    }

    read(): void {
        let screenshotKey = Shortcuts.screenshotToClipboardShortcut();
        if (screenshotKey) {
            screenshotKey = (Locale as unknown as Record<string, string>)[
                'detSetupOtpAlertBodyWith'
            ].replace('{}', screenshotKey);
        }
        const pasteKey = Features.isMobile
            ? ''
            : (Locale as unknown as Record<string, string>)['detSetupOtpAlertBodyWith'].replace(
                  '{}',
                  Shortcuts.actionShortcutSymbol() + 'V'
              );
        this.startListenClipoard();
        const loc = Locale as unknown as Record<string, string>;
        const buttons: Array<{ result: string; title: string; silent?: boolean }> = [
            { result: 'manually', title: loc['detSetupOtpManualButton'], silent: true },
            Alerts.buttons.cancel
        ];
        if (Features.isMobile) {
            buttons.unshift({ result: 'select', title: loc['detSetupOtpScanButton'] });
        }
        const line3 = Features.isMobile
            ? loc['detSetupOtpAlertBody3Mobile']
            : loc['detSetupOtpAlertBody3'].replace('{}', pasteKey || '');
        this.alert = Alerts.alert({
            icon: 'qrcode',
            header: loc['detSetupOtpAlert'],
            body: [
                loc['detSetupOtpAlertBody'],
                loc['detSetupOtpAlertBody1'],
                loc['detSetupOtpAlertBody2'].replace('{}', screenshotKey || ''),
                line3,
                loc['detSetupOtpAlertBody4']
            ].join('\n'),
            esc: '',
            click: '',
            enter: '',
            buttons,
            complete: (res: string) => {
                this.alert = null;
                this.stopListenClipboard();
                if (res === 'select') {
                    this.selectFile();
                } else if (res === 'manually') {
                    this.enterManually();
                }
            }
        }) as AlertHandle | null;
    }

    selectFile(): void {
        if (!this.fileInput) {
            const input = document.createElement('input');
            input.setAttribute('type', 'file');
            input.setAttribute('capture', 'camera');
            input.setAttribute('accept', 'image/*');
            input.setAttribute('class', 'hide-by-pos');
            this.fileInput = input;
            this.fileInput.onchange = this.fileSelected;
        }
        this.fileInput.click();
    }

    fileSelected(): void {
        const file = this.fileInput?.files?.[0];
        if (!file || file.type.indexOf('image') < 0) {
            return;
        }
        this.readFile(file);
    }

    startListenClipoard(): void {
        document.addEventListener('paste', this.pasteEvent);
    }

    stopListenClipboard(): void {
        document.removeEventListener('paste', this.pasteEvent);
    }

    pasteEvent(e: ClipboardEvent): void {
        const items = e.clipboardData ? [...e.clipboardData.items] : [];
        const item = items.find(
            (it) => it.kind === 'file' && it.type.indexOf('image') !== -1
        );
        if (!item) {
            logger.debug('Paste without file');
            return;
        }
        logger.info('Reading pasted image', item.type);
        if (this.alert && this.alert.change) {
            this.alert.change({
                header: (Locale as unknown as Record<string, string>)['detOtpImageReading']
            });
        }
        const file = item.getAsFile();
        if (file) {
            this.readFile(file);
        }
    }

    readFile(file: File): void {
        const reader = new FileReader();
        reader.onload = () => {
            logger.debug('Image data loaded');
            const result = reader.result;
            if (typeof result === 'string') {
                this.readQr(result);
            }
        };
        reader.readAsDataURL(file);
    }

    readQr(imageData: string): void {
        const image = new Image();
        const loc = Locale as unknown as Record<string, string>;
        image.onload = () => {
            logger.debug('Image format loaded');
            try {
                const ts = logger.ts() as number;
                const url = new QrCode(image).decode();
                logger.info('QR code read', logger.ts(ts));
                this.removeAlert();
                try {
                    const otp = Otp.parseUrl(url);
                    Events.emit('qr-read', otp);
                } catch (err) {
                    logger.error('Error parsing QR code', err);
                    Alerts.error({
                        header: loc['detOtpQrWrong'],
                        body: loc['detOtpQrWrongBody'],
                        pre: err instanceof Error ? err.toString() : String(err)
                    });
                }
            } catch (e) {
                logger.error('Error reading QR code', e);
                this.removeAlert();
                Alerts.error({
                    header: loc['detOtpQrError'],
                    body: loc['detOtpQrErrorBody']
                });
            }
        };
        image.onerror = () => {
            logger.debug('Image load error');
            this.removeAlert();
            Alerts.error({
                header: loc['detOtpImageError'],
                body: loc['detOtpImageErrorBody']
            });
        };
        image.src = imageData;
    }

    enterManually(): void {
        Events.emit('qr-enter-manually');
    }

    removeAlert(): void {
        if (this.alert && this.alert.closeImmediate) {
            this.alert.closeImmediate();
        }
    }
}

const instance = new OtpQrReader();

export { instance as OtpQrReader };
