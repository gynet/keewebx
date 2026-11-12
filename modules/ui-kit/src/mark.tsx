import { EntryIcon } from './icons';

export { Icon } from './icons';

/** The KeeWebX mark, blue colorway. */
export function Mark({ size }: { size: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
            <path
                fill="#0a6fe8"
                d="M160 0H352C460 0 512 52 512 160V352C512 460 460 512 352 512H160C52 512 0 460 0 352V160C0 52 52 0 160 0Z"
            />
            <g transform="translate(256 256) scale(0.88) translate(-256 -256)">
                <g fill="#16181d" transform="rotate(-40 256 262)">
                    <rect x="234" y="78" width="44" height="140" rx="7" />
                    <rect x="234" y="306" width="44" height="140" rx="7" />
                </g>
                <g fill="none" stroke="#fff" stroke-linecap="round" transform="rotate(40 256 262)">
                    <circle cx="256" cy="122" r="42.5" stroke-width="39" />
                    <path d="M256 192V420" stroke-width="44" />
                    <path d="M256 372H314" stroke-width="42.5" />
                </g>
            </g>
        </svg>
    );
}

const TILE_COLORS = [
    ['blue', '#dce8f5', '#4776a6'],
    ['amber', '#f1e5cf', '#a77d35'],
    ['green', '#dfebe2', '#4b8564'],
    ['violet', '#e8e1f1', '#876aa8'],
    ['slate', '#deebed', '#518794'],
    ['coral', '#f1e0e3', '#af7180']
] as const;

/**
 * Custom images take priority; standard icons retain their vault semantics.
 * The pastel color stays the same for the same title.
 */
export function Tile({
    title,
    icon,
    customIcon,
    large
}: {
    title: string;
    icon?: string | null;
    customIcon?: string | null;
    large?: boolean;
}) {
    const size = large ? ' tile--large' : '';
    // Shared geometry also applies in extension pages with their own stylesheet.
    const geometry = {
        width: large ? 54 : 36,
        height: large ? 54 : 36,
        borderRadius: large ? 10 : 8,
        display: 'flex',
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundImage: 'none',
        boxShadow: 'none'
    };
    if (customIcon) {
        return (
            <span
                class={'tile tile--image' + size}
                aria-hidden="true"
                style={{ ...geometry, backgroundColor: 'var(--kx-sub, var(--sub, #f4f6f9))' }}
            >
                <img
                    src={customIcon}
                    alt=""
                    style={{
                        width: large ? 36 : 24,
                        height: large ? 36 : 24,
                        objectFit: 'contain'
                    }}
                />
            </span>
        );
    }
    let hash = 0;
    for (const ch of title.toLowerCase()) {
        hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    }
    const [color, base, ink] = TILE_COLORS[hash % TILE_COLORS.length];
    return (
        <span
            class={'tile' + size}
            aria-hidden="true"
            style={{
                ...geometry,
                backgroundColor: `var(--kx-tile-${color}-base, ${base})`,
                color: `var(--kx-tile-${color}-ink, ${ink})`,
                filter: 'saturate(1.44)'
            }}
        >
            <EntryIcon name={icon} size={large ? 31 : 21} />
        </span>
    );
}
