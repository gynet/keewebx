import { FieldViewText } from 'views/fields/field-view-text';
import { escape } from 'util/fn';

const AllowedProtocols = ['http:', 'https:', 'ftp:', 'ftps:', 'mailto:'];

class FieldViewUrl extends FieldViewText {
    displayUrlRegex = /^https:\/\//i;
    cssClass = 'url';

    renderValue(value: string | undefined): string {
        try {
            return value
                ? '<a href="' +
                      escape(this.fixUrl(value)) +
                      '" rel="noreferrer noopener" target="_blank">' +
                      escape(this.displayUrl(value)) +
                      '</a>'
                : '';
        } catch {
            return escape(value ?? '');
        }
    }

    fixUrl(url: string): string {
        const proto = new URL(url, 'ws://x').protocol;
        if (proto === 'ws:') {
            return 'https://' + url;
        }
        if (!AllowedProtocols.includes(proto)) {
            throw new Error('Bad url');
        }
        return url;
    }

    displayUrl(url: string): string {
        return url.replace(this.displayUrlRegex, '');
    }

    getTextValue(): string {
        return this.value;
    }
}

export { FieldViewUrl };
