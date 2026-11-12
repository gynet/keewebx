import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';

export function SwipeVaultRow({ children }: { children: ComponentChildren }) {
    const [revealed, setRevealed] = useState(false);
    const gesture = useRef<{ x: number; y: number; horizontal: boolean } | null>(null);
    const suppressClick = useRef(false);
    return <div class="vault-row-wrap" data-revealed={revealed}
        onPointerDown={(event) => {
            suppressClick.current = false;
            if (event.pointerType === 'mouse' || !event.isPrimary) return;
            gesture.current = { x: event.clientX, y: event.clientY, horizontal: false };
        }}
        onPointerMove={(event) => {
            const start = gesture.current;
            if (!start) return;
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            if (!start.horizontal && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
                gesture.current = null;
                return;
            }
            if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy)) {
                start.horizontal = true;
                suppressClick.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
            }
        }}
        onPointerUp={(event) => {
            const start = gesture.current;
            gesture.current = null;
            if (start?.horizontal && Math.abs(event.clientX - start.x) > 40) {
                setRevealed(event.clientX < start.x);
            }
        }}
        onPointerCancel={() => { gesture.current = null; suppressClick.current = false; }}
        onClickCapture={(event) => {
            if (suppressClick.current) {
                event.preventDefault(); event.stopPropagation(); suppressClick.current = false;
            }
        }}
        onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { setRevealed(true); event.preventDefault(); }
            if (event.key === 'Escape' || event.key === 'ArrowRight') setRevealed(false);
        }}>
        {children}
    </div>;
}
