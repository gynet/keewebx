import { View } from 'framework/views/view';
import { ENTRY_ICONS } from 'const/icon-registry';
import { AppSettingsModel } from 'models/app-settings-model';
import { Logger } from 'util/logger';
import template from 'templates/icon-select.hbs';

const logger = new Logger('icon-select-view');

interface IconImageData {
    width: number;
    height: number;
    data: string;
}

type SpecialSlot = 'select' | 'download';

class IconSelectView extends View {
    template = template;

    events: Record<string, string> = {
        'click .icon-select__icon': 'iconClick',
        'click .icon-select__icon-download': 'downloadIcon',
        'click .icon-select__icon-select': 'selectIcon',
        'change .icon-select__file-input': 'iconSelected'
    };

    special: Record<SpecialSlot, IconImageData | null> = {
        select: null,
        download: null
    };

    downloadingFavicon = false;

    render(): this | undefined {
        const customIcons = this.model.file.getCustomIcons();
        const hasCustomIcons = Object.keys(customIcons).length > 0;
        super.render({
            sel: this.model.iconId,
            icons: ENTRY_ICONS,
            canDownloadFavicon: !!this.model.url,
            customIcons,
            hasCustomIcons
        });
        return this;
    }

    iconClick(e: Event): void {
        const target = $(e.target as Element).closest('.icon-select__icon');
        const iconId = target[0].getAttribute('data-val');
        if (iconId === 'special') {
            const slot = target.data('special') as SpecialSlot;
            const iconData = this.special[slot];
            if (iconData) {
                const id = this.model.file.addCustomIcon(iconData.data);
                this.emit('select', { id, custom: true });
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        } else if (iconId) {
            const isCustomIcon = target.hasClass('icon-select__icon-custom');
            this.emit('select', { id: iconId, custom: isCustomIcon });
        }
    }

    downloadIcon(): void {
        if (this.downloadingFavicon) {
            return;
        }
        this.downloadingFavicon = true;
        this.$el.find('.icon-select__icon-download>i').addClass('spin');
        this.$el
            .find('.icon-select__icon-download')
            .addClass('icon-select__icon--progress')
            .removeClass('icon-select__icon--download-error');
        const url = this.getIconUrl(true);
        const img = document.createElement('img');
        img.crossOrigin = 'Anonymous';
        img.src = url ?? '';
        img.onload = () => {
            this.setSpecialImage(img, 'download');
            this.$el.find('.icon-select__icon-download img').remove();
            this.$el.find('.icon-select__icon-download>i').removeClass('spin');
            this.$el
                .find('.icon-select__icon-download')
                .removeClass('icon-select__icon--progress')
                .addClass('icon-select__icon--custom-selected')
                .append(img);
            this.downloadingFavicon = false;

            const downloadData = this.special.download;
            if (downloadData) {
                const id = this.model.file.addCustomIcon(downloadData.data);
                this.emit('select', { id, custom: true });
            }
        };
        img.onerror = (e) => {
            logger.error('Favicon download error: ' + url, e);
            this.$el.find('.icon-select__icon-download>i').removeClass('spin');
            this.$el
                .find('.icon-select__icon-download')
                .removeClass('icon-select__icon--custom-selected icon-select__icon--progress')
                .addClass('icon-select__icon--download-error');
            this.downloadingFavicon = false;
        };
    }

    getIconUrl(useService?: boolean): string | null {
        if (!this.model.url) {
            return null;
        }
        let url: string = this.model.url.replace(
            /([^/:]\/.*)?$/,
            (match: string) => (match && match[0]) + '/favicon.ico'
        );
        if (url.indexOf('://') < 0) {
            url = 'http://' + url;
        }
        if (useService) {
            // Favicon proxy. The browser cannot read cross-origin image
            // bytes without CORS; this endpoint fetches + re-emits with
            // Access-Control-Allow-Origin so we can embed the result as
            // a custom KDBX icon. `?min=N` doubles as a quality
            // threshold — sites without a declared icon ≥N px return
            // 404 and the client falls back to the KDBX default.
            const host = url.replace(/^.*:\/+/, '').replace(/\/.*/, '');
            const settings = AppSettingsModel as unknown as { faviconSize?: number };
            const target = settings.faviconSize ?? 32;
            const query = target > 32 ? `?min=${target}` : '';
            return 'https://keewebx.app/api/favicon/' + host + query;
        }
        return url;
    }

    selectIcon(e: Event): void {
        const btn = (e.target as Element).closest('.icon-select__icon-select');
        if (btn && btn.classList.contains('icon-select__icon--custom-selected')) {
            return;
        }

        this.$el.find('.icon-select__file-input').click();
    }

    iconSelected(e: Event): void {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = document.createElement('img');
                img.onload = () => {
                    this.setSpecialImage(img, 'select');
                    this.$el.find('.icon-select__icon-select img').remove();
                    this.$el
                        .find('.icon-select__icon-select')
                        .addClass('icon-select__icon--custom-selected')
                        .append(img);
                };
                img.src = ev.target?.result as string;
            };
            reader.readAsDataURL(file);
        } else {
            this.$el.find('.icon-select__icon-select img').remove();
            this.$el
                .find('.icon-select__icon-select')
                .removeClass('icon-select__icon--custom-selected');
        }
    }

    setSpecialImage(img: HTMLImageElement, name: SpecialSlot): void {
        // Cap stored canvas at the user-chosen target. Resize down when
        // the source is larger (typical now that hi-res is supported);
        // never upscale (would just blur).
        const settings = AppSettingsModel as unknown as { faviconSize?: number };
        const target = [32, 64, 128].includes(settings.faviconSize ?? 32)
            ? (settings.faviconSize as number)
            : 32;
        const size = Math.min(img.width, target);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = size;
        canvas.height = size;
        ctx?.drawImage(img, 0, 0, size, size);
        const data = canvas.toDataURL().replace(/^.*,/, '');
        this.special[name] = { width: img.width, height: img.height, data };
    }
}

export { IconSelectView };
