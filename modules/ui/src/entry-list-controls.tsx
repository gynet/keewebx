import type { ComponentChildren } from 'preact';
import './entry-list-controls.css';

/** Presentation only: callers retain search, draft and session access guards. */
export function EntryListControls({ scope, search, create, error, sort, color, options, templates }: {
    scope?: ComponentChildren;
    search: ComponentChildren;
    create: ComponentChildren;
    error?: ComponentChildren;
    sort: ComponentChildren;
    color: ComponentChildren;
    options: ComponentChildren;
    templates: ComponentChildren;
}) {
    return <div class="entry-list-controls">
        {scope && <div class="entry-list-controls__scope">{scope}</div>}
        <div class="entry-list-controls__primary">{search}{create}</div>
        {error}
        <div class="entry-list-controls__secondary">{sort}{color}{options}{templates}</div>
    </div>;
}
