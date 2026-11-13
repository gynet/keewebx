import { useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { getSessionAccess } from 'comp/app/session-access';
import { t } from './i18n';

/** Classic's ranked, five-result suggestions, with keyboard and touch selection. */
export function UsernameInput({ model, value, hidden, onInput }: {
    model: AppModel; value: string; hidden: boolean; onInput: (value: string) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const [open, setOpen] = useState(false), [index, setIndex] = useState(-1);
    const access = getSessionAccess(model);
    const epoch = access.epoch;
    const suggestions = open && !hidden && access.state === 'open' ? model.completeUserNames(value) : [];
    const choose = (name: string) => {
        if (!access.isCurrent(epoch) || access.state !== 'open' || !input.current?.isConnected
            || input.current.closest('[hidden], [inert]') || !model.completeUserNames(value).includes(name)) return;
        onInput(name); setOpen(false); setIndex(-1); input.current.focus();
    };
    return <span style={{ display: 'block', position: 'relative' }}>
        <input ref={input} class="input" aria-label={t('Username')} type={hidden ? 'password' : 'text'}
            role="combobox" aria-autocomplete="list" aria-expanded={suggestions.length > 0}
            aria-controls="username-suggestions" aria-activedescendant={index >= 0 && suggestions[index] ? `username-suggestion-${index}` : undefined}
            autoComplete="off" spellcheck={false} value={value}
            onFocus={() => setOpen(true)} onBlur={() => { setOpen(false); setIndex(-1); }}
            onInput={event => { onInput(event.currentTarget.value); setOpen(true); setIndex(-1); }}
            onKeyDown={event => {
                if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setIndex(-1); }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    if (!hidden) {
                        event.preventDefault(); setOpen(true);
                        const count = model.completeUserNames(value).length;
                        setIndex(count ? (index < 0 ? (event.key === 'ArrowDown' ? 0 : count - 1) : (index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count) : -1);
                    }
                }
                if (event.key === 'Enter' && open && suggestions[index]) { event.preventDefault(); choose(suggestions[index]); }
            }} />
        {suggestions.length > 0 && <span id="username-suggestions" role="listbox" aria-label={t('Username suggestions')}
            style={{ display: 'block', border: '1px solid var(--kx-line)', borderRadius: '8px', padding: '4px', background: 'var(--kx-bg)' }}>
            {suggestions.map((name, i) => <button id={`username-suggestion-${i}`} type="button" role="option"
                aria-selected={index === i} tabIndex={-1} class="nav-row" style={{ width: '100%', overflowWrap: 'anywhere' }}
                onPointerDown={event => event.preventDefault()} onClick={() => choose(name)}>{name}</button>)}
        </span>}
    </span>;
}
