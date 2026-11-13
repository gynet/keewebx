import { useEffect, useState } from 'preact/hooks';
import { storageKey } from 'comp/settings/storage-namespace';
import { Icon } from 'ui-kit/mark';
import { t } from './i18n';
import './sidebar-collapse.css';

function read(key: string, fallback: number): number {
    try {
        const value = JSON.parse(localStorage.getItem(storageKey(key)) || 'null');
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    } catch { return fallback; }
}
function write(key: string, value: number) {
    try { localStorage.setItem(storageKey(key), JSON.stringify(value)); } catch { /* Optional preference. */ }
}

export function useSidebarCollapse(screen: 'start' | 'vault') {
    const key = `${screen}SidebarCollapsed`;
    const [collapsed, setCollapsed] = useState(() => read(key, 0) === 1);
    const [preferredWidth, setPreferredWidth] = useState(() => read('startSidebarWidth', 360));
    const [viewport, setViewport] = useState(window.innerWidth);
    useEffect(() => {
        const resized = () => setViewport(window.innerWidth);
        window.addEventListener('resize', resized);
        return () => window.removeEventListener('resize', resized);
    }, []);
    const max = Math.max(240, Math.min(480, viewport - 366));
    return {
        collapsed,
        toggle: () => setCollapsed(value => { write(key, value ? 0 : 1); return !value; }),
        width: Math.max(240, Math.min(max, preferredWidth)), max,
        setWidth: (value: number) => { setPreferredWidth(value); write('startSidebarWidth', value); }
    };
}

export function SidebarPanelIcon({ open }: { open: boolean }) {
    return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M9 4v16" />
        <path d={open ? 'm16 9-3 3 3 3' : 'm13 9 3 3-3 3'} />
    </svg>;
}

export function SidebarToggle({ collapsed, toggle, controls, label }: {
    collapsed: boolean; toggle(): void; controls: string; label: string;
}) {
    const action = collapsed ? t('Expand {}', label) : t('Collapse {}', label);
    return <button type="button" class="round sidebar-toggle" aria-label={action} title={action}
        aria-expanded={!collapsed} aria-controls={controls} onClick={toggle}>
        <span style={{ display: 'flex', transform: collapsed ? 'rotate(180deg)' : undefined }}><Icon name="back" size={18} /></span>
    </button>;
}
