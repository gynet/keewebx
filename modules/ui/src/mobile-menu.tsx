import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { storageKey } from 'comp/settings/storage-namespace';
import { t } from './i18n';

export function MobileMenu({ children }: { children: ComponentChildren }) {
    const [side, setSide] = useState(() => {
        try { return localStorage.getItem(storageKey('menuSide')) === 'left' ? 'left' : 'right'; }
        catch { return 'right'; }
    });
    const start = useRef<number | null>(null);
    const [offset, setOffset] = useState(0);
    const dock = (next: string) => {
        setSide(next);
        setOffset(0);
        try { localStorage.setItem(storageKey('menuSide'), next); } catch { /* Storage is optional. */ }
    };
    return <div class="phone-bar" data-side={side} style={{ transform: `translateX(${offset}px)` }}>
        <button class="round phone-bar__handle" aria-label={t('Move menu')} title={t('Drag left or right. Arrow keys also move the menu.')}
            onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault(); dock(event.key === 'ArrowLeft' ? 'left' : 'right');
                }
            }}
            onPointerDown={(event) => {
                start.current = event.clientX;
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
                if (start.current !== null) setOffset(event.clientX - start.current);
            }}
            onPointerUp={(event) => {
                if (start.current === null) return;
                const moved = Math.abs(event.clientX - start.current) > 8;
                start.current = null;
                dock(moved ? (event.clientX < window.innerWidth / 2 ? 'left' : 'right') : side);
            }}
            onPointerCancel={() => { start.current = null; setOffset(0); }}
            onLostPointerCapture={() => { start.current = null; setOffset(0); }}>
            <svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true" fill="currentColor">
                {[5, 10, 15].map((y) => <g key={y}><circle cx="5" cy={y} r="1.5" /><circle cx="11" cy={y} r="1.5" /></g>)}
            </svg>
        </button>
        {children}
    </div>;
}
