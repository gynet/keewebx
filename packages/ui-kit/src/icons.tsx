import { ENTRY_ICON_ASSETS, UI_ICON_ASSETS } from './icon-assets';
import { entryIconName, uiIconName } from './icon-map';

// Only the statically imported package assets enter the inline SVG renderer.
// Phosphor's assets share a 256 × 256 viewBox and inherit currentColor.
function contents(svg: string): string {
    return svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'));
}

const entryMarkup = Object.fromEntries(
    Object.entries(ENTRY_ICON_ASSETS).map(([name, svg]) => [name, contents(svg)])
);
const uiMarkup = Object.fromEntries(
    Object.entries(UI_ICON_ASSETS).map(([name, svg]) => [name, contents(svg)])
);

function Glyph({ markup, size }: { markup: string; size: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 256 256"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
            style={{ display: 'block', flexShrink: 0 }}
            dangerouslySetInnerHTML={{ __html: markup }}
        />
    );
}

export function EntryIcon({ name, size = 21 }: { name?: string | null; size?: number }) {
    return <Glyph markup={entryMarkup[entryIconName(name)]} size={size} />;
}

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
    const toolbarName = uiIconName(name);
    const markup = toolbarName ? uiMarkup[toolbarName] : entryMarkup[entryIconName(name)];
    return <Glyph markup={markup} size={size} />;
}
