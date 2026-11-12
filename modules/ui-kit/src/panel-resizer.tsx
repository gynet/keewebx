import { useRef } from 'preact/hooks';

/** Accessible splitter; layout and persistence remain the caller's responsibility. */
export function PanelResizer({ label, value, min, max, onChange, onReset }: {
    label: string; value: number; min: number; max: number;
    onChange: (value: number) => void; onReset: () => void;
}) {
    const drag = useRef<{ x: number; value: number } | null>(null);
    const change = (next: number) => onChange(Math.round(Math.max(min, Math.min(max, next))));
    return <div class="panel-resizer" role="separator" tabIndex={0} aria-label={label}
        aria-orientation="vertical" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}
        onDblClick={onReset}
        onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            drag.current = { x: event.clientX, value };
            event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
            if (drag.current) change(drag.current.value + event.clientX - drag.current.x);
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                change(event.key === 'Home' ? min : event.key === 'End' ? max : value + (event.key === 'ArrowLeft' ? -10 : 10));
            }
        }} />;
}
