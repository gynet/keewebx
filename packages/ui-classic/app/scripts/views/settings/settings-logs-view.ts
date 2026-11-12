/* eslint-disable @typescript-eslint/no-explicit-any */
import { View } from 'framework/views/view';
import { StringFormat } from 'util/formatting/string-format';
import { Logger } from 'util/logger';
import template from 'templates/settings/settings-logs-view.hbs';

const logger = Logger as unknown as { getLast(): any[] };

class SettingsLogsView extends View {
    parent = '.settings__general-advanced';
    template = template;
    levelToColor: Record<string, string> = { debug: 'muted', warn: 'yellow', error: 'red' };

    render(): this | undefined {
        const logs = logger.getLast().map((item: any) => ({
            level: item.level,
            color: this.levelToColor[item.level],
            msg:
                '[' +
                StringFormat.padStr(item.level.toUpperCase(), 5) +
                '] ' +
                item.args.map((arg: any) => this.mapArg(arg)).join(' ')
        }));
        super.render({ logs });
        return this;
    }

    mapArg(arg: any): any {
        if (arg === null) {
            return 'null';
        }
        if (arg === undefined) {
            return 'undefined';
        }
        if (arg === '') {
            return '""';
        }
        if (!arg || !arg.toString() || typeof arg !== 'object') {
            return arg ? arg.toString() : arg;
        }
        if (arg instanceof Array) {
            return '[' + arg.map((item: any) => this.mapArg(item)).join(', ') + ']';
        }
        let str = arg.toString();
        if (str === '[object Object]') {
            const cache: any[] = [];
            str = JSON.stringify(arg, (key, value) => {
                if (typeof value === 'object' && value !== null) {
                    if (cache.indexOf(value) !== -1) {
                        return;
                    }
                    cache.push(value);
                }
                return value;
            });
        }
        return str;
    }
}

export { SettingsLogsView };
