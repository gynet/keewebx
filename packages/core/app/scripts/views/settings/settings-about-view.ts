/* eslint-disable @typescript-eslint/no-explicit-any */
import { View } from 'framework/views/view';
import { RuntimeInfo } from 'const/runtime-info';
import { Links } from 'const/links';
import { Features } from 'util/features';
import template from 'templates/settings/settings-about.hbs';

const links = Links as unknown as Record<string, string>;
const runtimeInfo = RuntimeInfo as unknown as { version: string };
const features = Features as unknown as { isDesktop: boolean };

class SettingsAboutView extends View {
    template = template;

    render(): this | undefined {
        super.render({
            version: runtimeInfo.version,
            licenseLink: links.License,
            licenseLinkApache: links.LicenseApache,
            licenseLinkCCBY40: links.LicenseLinkCCBY40,
            repoLink: links.Repo,
            donationLink: links.Donation,
            isDesktop: features.isDesktop,
            year: new Date().getFullYear()
        });
        return this;
    }
}

export { SettingsAboutView };
