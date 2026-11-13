import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { storageKey } from 'comp/settings/storage-namespace';
import { t } from './i18n';

export function MobileMenu({ children }: { children: ComponentChildren }) {
    const bar = useRef<HTMLDivElement>(null);
    const [reservedHeight, setReservedHeight] = useState(72);
    useLayoutEffect(() => {
        const element = bar.current!;
        const measure = () => setReservedHeight(Math.max(72, element.getBoundingClientRect().height + 12));
        const observer = new ResizeObserver(measure);
        observer.observe(element); measure();
        return () => observer.disconnect();
    }, []);
    const [side, setSide] = useState(() => {
        try { return localStorage.getItem(storageKey('menuSide')) === 'left' ? 'left' : 'right'; }
        catch { return 'right'; }
    });
    const start = useRef<{ x: number; y: number; bottom: number } | null>(null);
    const [bottom, setBottom] = useState(() => {
        try { const value = Number(localStorage.getItem(storageKey('menuBottom')) ?? 24); return Number.isFinite(value) ? value : 24; }
        catch { return 24; }
    });
    const dragged = useRef(false);
    const [collapsed, setCollapsed] = useState(false);
    const [offset, setOffset] = useState(0);
    const [offsetY, setOffsetY] = useState(0);
    const moveHeight = (value: number) => {
        const next = Math.max(12, Math.min(window.innerHeight - reservedHeight, value));
        setBottom(next);
        try { localStorage.setItem(storageKey('menuBottom'), String(next)); } catch { /* Optional preference. */ }
    };
    const dock = (next: string) => {
        setSide(next);
        setOffset(0);
        setOffsetY(0);
        try { localStorage.setItem(storageKey('menuSide'), next); } catch { /* Storage is optional. */ }
    };
    return <div ref={bar} class="phone-bar" data-side={side} data-collapsed={collapsed} style={{
        bottom: `clamp(12px, ${bottom}px, calc(100dvh - ${reservedHeight}px))`,
        transform: offset || offsetY ? `translate(${offset}px, ${offsetY}px)` : undefined
    }}>
        <button class="round phone-bar__handle" aria-label={t(collapsed ? 'Show menu' : 'Move menu')} aria-expanded={!collapsed}
            title={t('Click to hide or show. Drag to move. Arrow keys also move the menu.')}
            onClick={() => { if (dragged.current) { dragged.current = false; return; } setCollapsed(!collapsed); }}
            onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault(); dock(event.key === 'ArrowLeft' ? 'left' : 'right');
                }
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    event.preventDefault(); moveHeight(bottom + (event.key === 'ArrowUp' ? 24 : -24));
                }
            }}
            onPointerDown={(event) => {
                const rect = event.currentTarget.parentElement!.getBoundingClientRect();
                start.current = { x: event.clientX, y: event.clientY, bottom: window.innerHeight - rect.bottom };
                dragged.current = false;
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
                if (start.current) { setOffset(event.clientX - start.current.x); setOffsetY(event.clientY - start.current.y); }
            }}
            onPointerUp={(event) => {
                if (start.current === null) return;
                const moved = Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 8;
                if (moved) moveHeight(start.current.bottom + start.current.y - event.clientY);
                dragged.current = moved;
                start.current = null;
                dock(moved ? (event.clientX < window.innerWidth / 2 ? 'left' : 'right') : side);
            }}
            onPointerCancel={() => { start.current = null; setOffset(0); setOffsetY(0); }}
            onLostPointerCapture={() => { start.current = null; setOffset(0); setOffsetY(0); }}>
            <svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true" fill="currentColor">
                {[5, 10, 15].map((y) => <g key={y}><circle cx="5" cy={y} r="1.5" /><circle cx="11" cy={y} r="1.5" /></g>)}
            </svg>
        </button>
        {!collapsed && children}
    </div>;
}
