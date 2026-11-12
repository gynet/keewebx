import { useEffect, useState } from 'preact/hooks';
import { storageKey } from 'comp/settings/storage-namespace';

const defaults = { sidebar: 248, list: 352 };
type Widths = typeof defaults;
export function usePanelLayout() {
    const [preferred, setPreferred] = useState<Widths>(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey('panelWidths')) || '{}');
            return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key,
                typeof saved?.[key] === 'number' && Number.isFinite(saved[key]) ? saved[key] : fallback])) as Widths;
        } catch { return defaults; }
    });
    const [viewport, setViewport] = useState(window.innerWidth);
    useEffect(() => {
        const resized = () => setViewport(window.innerWidth);
        window.addEventListener('resize', resized);
        return () => window.removeEventListener('resize', resized);
    }, []);
    const sidebarMax = Math.max(180, Math.min(420, viewport - 240 - 280 - 12));
    const sidebar = Math.max(180, Math.min(sidebarMax, preferred.sidebar));
    const listMax = Math.max(240, Math.min(680, viewport - sidebar - 280 - 12));
    const list = Math.max(240, Math.min(listMax, preferred.list));
    const set = (key: keyof Widths, value: number) => {
        setPreferred((current) => {
            const next = { ...current, [key]: value };
            try { localStorage.setItem(storageKey('panelWidths'), JSON.stringify(next)); } catch { /* Optional preference. */ }
            return next;
        });
    };
    return { sidebar, list, sidebarMax, listMax, set, reset: (key: keyof Widths) => set(key, defaults[key]) };
}
