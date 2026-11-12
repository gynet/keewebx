import { useEffect, useState } from 'preact/hooks';
import { Icon } from './icons';

export type ThemeChoice = 'system' | 'light' | 'dark';
type ThemeState = { choice: ThemeChoice; resolved: 'light' | 'dark' };

/** A presentation preference only; callers supply their own storage namespace. */
export function createThemeController(key: string) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const read = (): ThemeChoice => {
        try {
            const value = localStorage.getItem(key);
            return value === 'light' || value === 'dark' ? value : 'system';
        } catch {
            return 'system';
        }
    };
    let choice = read();
    const listeners = new Set<() => void>();
    const state = (): ThemeState => ({ choice, resolved: choice === 'system' ? (media.matches ? 'dark' : 'light') : choice });
    const apply = () => {
        document.documentElement.dataset.kxTheme = state().resolved;
        listeners.forEach((listener) => listener());
    };
    apply();
    media.addEventListener('change', () => { if (choice === 'system') apply(); });
    window.addEventListener('storage', (event) => {
        if (event.key === key || event.key === null) {
            choice = read();
            apply();
        }
    });
    const set = (value: ThemeChoice) => {
        choice = value;
        try { localStorage.setItem(key, value); } catch { /* Usable without persistent storage. */ }
        apply();
    };
    return {
        state,
        set,
        toggle: () => set(state().resolved === 'dark' ? 'light' : 'dark'),
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        }
    };
}

export type ThemeController = ReturnType<typeof createThemeController>;

function useTheme(controller: ThemeController) {
    const [state, setState] = useState(controller.state);
    useEffect(() => controller.subscribe(() => setState(controller.state())), [controller]);
    return state;
}

export function ThemeButton({ controller, className, toLight, toDark }: {
    controller: ThemeController; className: string; toLight: string; toDark: string;
}) {
    const state = useTheme(controller);
    const label = state.resolved === 'dark' ? toLight : toDark;
    return <button type="button" class={className} title={label} aria-label={label}
        onClick={controller.toggle}>
        <Icon name={state.resolved === 'dark' ? 'sun' : 'moon'} size={17} />
    </button>;
}

export function ThemePicker({ controller, className, label, system, light, dark }: {
    controller: ThemeController; className: string; label: string; system: string; light: string; dark: string;
}) {
    const state = useTheme(controller);
    return <select class={className} aria-label={label} value={state.choice}
        onChange={(event) => controller.set(event.currentTarget.value as ThemeChoice)}>
        <option value="system">{system}</option>
        <option value="light">{light}</option>
        <option value="dark">{dark}</option>
    </select>;
}
