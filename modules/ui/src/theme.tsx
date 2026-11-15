import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from 'ui-kit/mark';
import { storageKey } from 'comp/settings/storage-namespace';
import { createPaletteController, palettes, palettePairs, type PaletteChoice, type PalettePair } from './palettes';
import { t } from './i18n';
import './theme.css';

export const theme = createPaletteController(storageKey('uiTheme'), storageKey('uiPalettePair'));
function useTheme() {
    const [state, setState] = useState(theme.state);
    useEffect(() => theme.subscribe(() => setState(theme.state())), []);
    return state;
}
export function ThemeToggle() {
    const state = useTheme();
    const panelId = useId();
    const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    useLayoutEffect(() => {
        const element = panel.current!;
        const place = () => {
            if (!element.matches(':popover-open') || !trigger.current) return;
            const anchor = trigger.current.getBoundingClientRect(), bounds = element.getBoundingClientRect();
            const below = innerHeight - anchor.bottom - 20;
            const top = below < bounds.height && anchor.top > below ? anchor.top - bounds.height - 8 : anchor.bottom + 8;
            element.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - bounds.width - 12))}px`;
            element.style.top = `${Math.max(12, Math.min(top, innerHeight - bounds.height - 12))}px`;
        };
        const toggle = () => {
            const visible = element.matches(':popover-open');
            setOpen(visible);
            if (visible) { place(); element.querySelector('select')?.focus(); }
        };
        const observer = new ResizeObserver(place);
        observer.observe(element);
        element.addEventListener('toggle', toggle);
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
            observer.disconnect(); element.removeEventListener('toggle', toggle);
            window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
            if (element.matches(':popover-open')) element.hidePopover();
        };
    }, []);
    return <>
        <button ref={trigger} type="button" class="round" title={`${t('Theme')}: ${t(state.choice === 'system' ? 'System' : palettes[state.choice].name)}`}
            aria-label={t('Theme')} aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId}
            onClick={() => panel.current?.togglePopover()} onKeyDown={event => {
                if (event.key === 'ArrowDown') { event.preventDefault(); panel.current?.showPopover(); }
            }}>
            <Icon name={state.resolved === 'dark' ? 'sun' : 'moon'} size={17} />
        </button>
        <div ref={panel} id={panelId} class="theme-picker" popover="auto" role="dialog" aria-label={t('Theme')}>
            <div class="theme-picker__heading"><span>{t('Theme')}</span>
                <button type="button" class="round" aria-label={t('Close')} onClick={() => {
                    panel.current?.hidePopover(); trigger.current?.focus();
                }}>×</button>
            </div>
            <ThemeSelect />
        </div>
    </>;
}
export function ThemeSelect() {
    const state = useTheme();
    return <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
        <select class="plain-select" aria-label={t('Theme')} value={state.choice} onChange={event => theme.set(event.currentTarget.value as PaletteChoice)}>
            <option value="system">{t('System')}</option>
            {Object.entries(palettes).map(([id, palette]) => <option key={id} value={id}>{t(palette.name)}</option>)}
        </select>
        {state.choice === 'system' && <label>{t('System palette')}<select class="plain-select" aria-label={t('System palette')} value={state.pair}
            onChange={event => theme.setPair(event.currentTarget.value as PalettePair)}>
            {Object.entries(palettePairs).map(([id, pair]) => <option key={id} value={id}>{t(pair.name)}</option>)}
        </select></label>}
    </div>;
}
