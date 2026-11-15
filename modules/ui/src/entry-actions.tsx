import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from './i18n';
import './entry-actions.css';

/** Keep action components mounted so their dialogs and operation guards retain state. */
export function EntryActions({ children }: { children: ComponentChildren }) {
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState({ left: 8, top: 0, maxHeight: 320 });
    const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
    const close = (restoreFocus = false) => {
        setOpen(false);
        if (restoreFocus) trigger.current?.focus();
    };
    useLayoutEffect(() => {
        if (!open) return;
        const place = () => {
            const rect = trigger.current?.getBoundingClientRect();
            if (!rect) return;
            const top = rect.bottom + 6;
            setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - Math.min(300, innerWidth - 32) - 8)),
                top, maxHeight: Math.max(44, Math.min(520, innerHeight - top - 12)) });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
    }, [open]);
    useEffect(() => {
        if (!open) return;
        const hasDialog = () => !!document.querySelector('dialog[open]');
        const outside = (event: PointerEvent) => {
            if (!hasDialog() && !root.current?.contains(event.target as Node)) close();
        };
        const keydown = (event: KeyboardEvent) => {
            if (hasDialog()) return;
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
        <button type="button" class="pill pill--tinted" ref={trigger} aria-label={t('More actions')}
            aria-expanded={open} aria-controls="entry-more-actions" onClick={() => setOpen(!open)}
            onKeyDown={event => {
                if (event.key === 'ArrowDown') {
                    event.preventDefault(); setOpen(true);
                    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('.entry-more__panel button:not(:disabled)')?.focus());
                }
            }}><span aria-hidden="true">⋯</span> {t('More')}</button>
        <div id="entry-more-actions" class="entry-more__panel" style={position} role="group" aria-label={t('Entry actions')} hidden={!open}>
            <div class="entry-more__heading"><span>{t('Entry actions')}</span>
                <button type="button" class="icon-btn" aria-label={t('Close actions')} onClick={() => close(true)}>×</button>
            </div>
            {children}
        </div>
    </div>;
}
