import type { ComponentChildren } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from './i18n';
import './entry-actions.css';

/** Keep action components mounted so their dialogs and operation guards retain state. */
export function EntryActions({ children, label = t('More actions'), title = t('Entry actions'), compact = false }: {
    children: ComponentChildren; label?: string; title?: string; compact?: boolean;
}) {
    const panelId = useId();
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState({ left: 8, top: 0, maxHeight: 320 });
    const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const close = (restoreFocus = false) => {
        setOpen(false);
        if (restoreFocus) trigger.current?.focus();
    };
    useLayoutEffect(() => {
        if (!open) return;
        const place = () => {
            const rect = trigger.current?.getBoundingClientRect();
            if (!rect) return;
            const below = innerHeight - rect.bottom - 18;
            const above = rect.top - 18;
            const height = Math.min(520, panel.current?.scrollHeight ?? 320);
            const upwards = below < height && above > below;
            const maxHeight = Math.max(44, Math.min(520, upwards ? above : below));
            const top = upwards ? Math.max(8, rect.top - 6 - Math.min(height, maxHeight)) : rect.bottom + 6;
            setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - Math.min(300, innerWidth - 32) - 8)),
                top, maxHeight });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
    }, [open]);
    useEffect(() => {
        if (!open) return;
        // Lock temporarily closes retained child dialogs before recovery reopens them.
        // Keep their panel visible while they are mounted, including that closed interval.
        const hasDialog = () => !!document.querySelector('dialog[open]') || !!root.current?.querySelector('dialog');
        const outside = (event: PointerEvent) => {
            if (!hasDialog() && !root.current?.contains(event.target as Node)) close();
        };
        const keydown = (event: KeyboardEvent) => {
            // Effect cleanup may follow the render that already hid this panel.
            if (panel.current?.hidden || hasDialog()) return;
            if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation(); close(true);
            }
        };
        const focus = (event: FocusEvent) => {
            if (!hasDialog() && !root.current?.contains(event.target as Node)) close();
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', keydown, true);
        document.addEventListener('focusin', focus);
        return () => {
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('keydown', keydown, true);
            document.removeEventListener('focusin', focus);
        };
    }, [open]);
    return <div class="entry-more" ref={root}>
        <button type="button" class={compact ? 'round' : 'pill pill--tinted'} ref={trigger} aria-label={label} title={label}
            aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}
            onKeyDown={event => {
                if (event.key === 'ArrowDown') {
                    event.preventDefault(); setOpen(true);
                    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('.entry-more__panel button:not(:disabled)')?.focus());
                }
            }}><span aria-hidden="true">⋯</span>{!compact && <> {t('More')}</>}</button>
        <div ref={panel} id={panelId} class="entry-more__panel" style={position} role="group" aria-label={title} hidden={!open}>
            <div class="entry-more__heading"><span>{title}</span>
                <button type="button" class="icon-btn" aria-label={t('Close actions')} onClick={() => close(true)}>×</button>
            </div>
            {children}
        </div>
    </div>;
}
