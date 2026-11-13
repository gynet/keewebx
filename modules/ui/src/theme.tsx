import { useEffect, useState } from 'preact/hooks';
import { Icon } from 'ui-kit/mark';
import { storageKey } from 'comp/settings/storage-namespace';
import { createPaletteController, palettes, palettePairs, type PaletteChoice, type PalettePair } from './palettes';
import { t } from './i18n';

export const theme = createPaletteController(storageKey('uiTheme'), storageKey('uiPalettePair'));
function useTheme() {
    const [state, setState] = useState(theme.state);
    useEffect(() => theme.subscribe(() => setState(theme.state())), []);
    return state;
}
export function ThemeToggle() {
    const state = useTheme();
    const label = t(state.resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    return <button type="button" class="round" title={label} aria-label={label} onClick={() => theme.toggle()}>
        <Icon name={state.resolved === 'dark' ? 'sun' : 'moon'} size={17} />
    </button>;
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
