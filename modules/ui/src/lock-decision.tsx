import { useLayoutEffect, useRef } from 'preact/hooks';
import { t } from './i18n';

/** The workspace is already hidden and session access denied before this choice appears. */
export function LockDecision({ save, discard, cancel }: { save(): void; discard(): void; cancel(): void }) {
    const root = useRef<HTMLElement>(null);
    useLayoutEffect(() => { root.current?.focus(); }, []);
    return <main ref={root} tabIndex={-1} class="start__main" aria-labelledby="lock-decision-title"
        style={{ minHeight: '100dvh', overflow: 'auto' }}>
        <section class="card" style={{ margin: 'auto', width: 'min(100%, 440px)' }}>
            <h1 id="lock-decision-title">{t('Save changes before locking?')}</h1>
            <p>{t('Access is suspended. Automatic saving on lock is off, and changes remain in memory.')}</p>
            <p>{t('Save all changes, or verify your credentials to discard them or return to editing. Saved copies and recent records are kept. An unsaved new vault may be lost if you discard.')}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                <button type="button" class="pill pill--primary" onClick={save}>{t('Save and lock')}</button>
                <button type="button" class="pill" onClick={discard}>{t('Discard changes…')}</button>
                <button type="button" class="pill" onClick={cancel}>{t('Cancel lock')}</button>
            </div>
        </section>
    </main>;
}
