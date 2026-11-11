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

// Muted so the list stays calm; the entry's own icon sits on top.
const TILE_COLORS = ['#4d535c', '#a0625a', '#a07a52', '#5a7598', '#58876f', '#7a6c9c', '#4f8590', '#94657c'];

/**
 * The entry's own icon when it has one, otherwise a letter tile whose color
 * stays the same for the same title.
 */
export function Tile({ title, icon, customIcon }: { title: string; icon?: string | null; customIcon?: string | null }) {
    if (customIcon) {
        return (
            <span class="tile tile--image">
                <img src={customIcon} alt="" />
            </span>
        );
    }
    let hash = 0;
    for (const ch of title.toLowerCase()) {
        hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    }
    const letter = (title.trim()[0] || '?').toUpperCase();
    return (
        <span class="tile" style={{ backgroundColor: TILE_COLORS[hash % TILE_COLORS.length] }}>
            {icon ? <i class={`fa fa-${icon}`} /> : letter}
        </span>
    );
}

const PATHS: Record<string, string> = {
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
    lock: 'M7 11V7.5a5 5 0 0 1 10 0V11M6.5 11h11a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-7A1.5 1.5 0 0 1 6.5 11z',
    back: 'M15 18l-6-6 6-6',
    file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
    cloud: 'M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 9.5 4.25 4.25 0 0 0 7 18z',
    plus: 'M12 5v14M5 12h14',
    expand: 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7',
    panel: 'M4 5h16v14H4zM15 5v14'
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <path d={PATHS[name]} />
        </svg>
    );
}
