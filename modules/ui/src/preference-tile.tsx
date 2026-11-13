import { useState } from 'preact/hooks';
import { Tile } from 'ui-kit/mark';
import { AppSettingsModel as settings } from 'models/app-settings-model';

export function PreferenceTile({ title, icon, customIcon, url, large, list }: {
    title: string; icon?: string | null; customIcon?: string | null; url?: string; large?: boolean; list?: boolean;
}) {
    const [failed, setFailed] = useState('');
    let favicon = '';
    if (settings.showFavicons && !customIcon && url) {
        try {
            const parsed = new URL(url.includes('://') ? url : `https://${url}`);
            if (['http:', 'https:'].includes(parsed.protocol) && parsed.hostname !== 'localhost') {
                favicon = `https://icons.duckduckgo.com/ip3/${parsed.hostname}.ico`;
            }
        } catch { /* Keep the database icon for invalid URLs. */ }
    }
    const size = large || (list && settings.largeListIcons);
    return <span class={`preference-tile${settings.colorfulIcons ? '' : ' preference-tile--muted'}`}>
        {favicon && failed !== favicon ? <span class="tile tile--image" aria-hidden="true" style={{ width: size ? 54 : 36, height: size ? 54 : 36, flexShrink: 0 }}>
            <img src={favicon} alt="" referrerPolicy="no-referrer" width={size ? 36 : 24} height={size ? 36 : 24} onError={() => setFailed(favicon)} />
        </span> : <Tile title={title} icon={icon} customIcon={customIcon} large={size} />}
    </span>;
}
