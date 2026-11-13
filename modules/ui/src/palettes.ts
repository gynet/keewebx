export const palettes = {
    dark: { name: 'Dark', mode: 'dark', colors: ['#17191f', '#f1f3f7', '#a0a8b6', '#85b3f1', '#0b1220', '#ff7b72'] },
    light: { name: 'Light', mode: 'light', colors: ['#ffffff', '#111a2b', '#5d6a7e', '#3373cb', '#ffffff', '#b32626'] },
    sd: { name: 'Solarized dark', mode: 'dark', colors: ['#002b36', '#c4d1d2', '#a0aeae', '#b5c44b', '#002b36', '#ff8d82'] },
    sl: { name: 'Solarized light', mode: 'light', colors: ['#fdf6e3', '#324b50', '#4d6469', '#506600', '#ffffff', '#a72426'] },
    fb: { name: 'Flat blue', mode: 'dark', colors: ['#282c34', '#d7dae0', '#abb2bf', '#8ab2ff', '#101927', '#ff8a80'] },
    bl: { name: 'Light blue', mode: 'light', colors: ['#f3f7ff', '#162b4d', '#496283', '#225dbe', '#ffffff', '#b32626'] },
    db: { name: 'Dark brown', mode: 'dark', colors: ['#342f2e', '#ffeae9', '#d6b8b5', '#83d6a2', '#14281b', '#ff9990'] },
    lb: { name: 'Light brown', mode: 'light', colors: ['#faf4ef', '#3d2924', '#725c51', '#75502e', '#ffffff', '#ab2828'] },
    te: { name: 'Terminal', mode: 'dark', colors: ['#151b17', '#d9f7e2', '#9ec5ab', '#64dc90', '#102718', '#ff9690'] },
    lt: { name: 'Light terminal', mode: 'light', colors: ['#f1faf3', '#173b24', '#486651', '#236c3b', '#ffffff', '#a72426'] },
    dc: { name: 'Dark high contrast', mode: 'dark', colors: ['#000000', '#ffffff', '#dddddd', '#ffff00', '#000000', '#ffaaaa'] },
    hc: { name: 'Light high contrast', mode: 'light', colors: ['#ffffff', '#000000', '#333333', '#000080', '#ffffff', '#990000'] }
} as const;
export type PaletteId = keyof typeof palettes;
export const palettePairs = {
    default: { name: 'Default', dark: 'dark', light: 'light' },
    solarized: { name: 'Solarized', dark: 'sd', light: 'sl' },
    blue: { name: 'Blue', dark: 'fb', light: 'bl' },
    brown: { name: 'Brown', dark: 'db', light: 'lb' },
    terminal: { name: 'Terminal', dark: 'te', light: 'lt' },
    contrast: { name: 'High contrast', dark: 'dc', light: 'hc' }
} as const;
export type PalettePair = keyof typeof palettePairs;
export type PaletteChoice = PaletteId | 'system';
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
export const paletteChoice = (value: string | null): PaletteChoice => value && own(palettes, value) ? value as PaletteId : 'system';
export const palettePair = (value: string | null): PalettePair => value && own(palettePairs, value) ? value as PalettePair : 'default';
function mix(a: string, b: string, amount: number): string {
    return '#' + [1, 3, 5].map(index => Math.round(parseInt(a.slice(index, index + 2), 16) * (1 - amount) + parseInt(b.slice(index, index + 2), 16) * amount).toString(16).padStart(2, '0')).join('');
}
export function paletteTokens(id: PaletteId): Record<string, string> {
    const [bg, text, muted, accent, accentText, error] = palettes[id].colors;
    const contrast = id === 'dc' || id === 'hc';
    return { bg, text, muted, acc: accent, 'acc-text': accentText, error,
        side: mix(bg, text, 0.025), sub: mix(bg, text, 0.045), line: mix(bg, text, contrast ? 0.5 : 0.18),
        sel: mix(bg, accent, contrast ? 0.08 : 0.13), ok: accent, warn: text };
}

export function createPaletteController(key: string, pairKey: string) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const read = (name: string) => { try { return localStorage.getItem(name); } catch { return null; } };
    let choice = paletteChoice(read(key));
    let pair = palettePair(read(pairKey));
    const listeners = new Set<() => void>();
    const state = () => {
        const id = choice === 'system' ? palettePairs[pair][media.matches ? 'dark' : 'light'] : choice;
        return { choice, pair, palette: id, resolved: palettes[id].mode };
    };
    const apply = () => {
        const current = state();
        document.documentElement.dataset.kxTheme = current.resolved;
        document.documentElement.dataset.kxPalette = current.palette;
        for (const [name, color] of Object.entries(paletteTokens(current.palette))) document.documentElement.style.setProperty(`--kx-${name}`, color);
        for (const listener of listeners) listener();
    };
    const persist = (name: string, value: string) => { try { localStorage.setItem(name, value); } catch { /* Session preference remains usable. */ } };
    const set = (value: PaletteChoice) => { choice = paletteChoice(value); persist(key, choice); apply(); };
    apply();
    media.addEventListener('change', () => { if (choice === 'system') apply(); });
    window.addEventListener('storage', event => {
        if (event.key === key || event.key === pairKey || event.key === null) { choice = paletteChoice(read(key)); pair = palettePair(read(pairKey)); apply(); }
    });
    return { state, set,
        setPair(value: PalettePair) { pair = palettePair(value); persist(pairKey, pair); apply(); },
        toggle() {
            const current = state();
            const active = Object.values(palettePairs).find(value => value.dark === current.palette || value.light === current.palette)!;
            set(active[current.resolved === 'dark' ? 'light' : 'dark']);
        },
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
    };
}
