/* eslint-disable @typescript-eslint/no-explicit-any */
import { View } from 'framework/views/view';
import { RuntimeInfo } from 'const/runtime-info';
import { Links } from 'const/links';
import template from 'templates/settings/settings-help.hbs';

const links = Links as unknown as Record<string, string>;
const runtimeInfo = RuntimeInfo as unknown as {
    version: string;
    commit: string;
    buildDate: string;
};

class SettingsHelpView extends View {
    template = template;

    render(): this | undefined {
        const appInfo =
            'KeeWebX v' +
            runtimeInfo.version +
            ' (' +
            runtimeInfo.commit +
            ', ' +
            runtimeInfo.buildDate +
            ')\n' +
            'Environment: web' +
            '\n' +
            'User-Agent: ' +
            navigator.userAgent;

        super.render({
            issueLink:
                links.Repo +
                '/issues/new?body=' +
                encodeURIComponent('# please describe your issue here\n\n' + appInfo),
            releasesLink: links.Releases,
            appInfo
        });
        return this;
    }
}

export { SettingsHelpView };
