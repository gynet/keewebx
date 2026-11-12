import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ProtectedValue } from 'kdbxweb';
import { Events } from 'framework/events';
import { IdleTracker } from 'comp/browser/idle-tracker';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import { Icon, Tile } from 'ui-kit/mark';
import type { NewProtocolUi, ExtensionPrompt } from './extension-ui';
import { t } from './i18n';

type PromptOf<K extends ExtensionPrompt['kind']> = Extract<ExtensionPrompt, { kind: K }>;
const rowStyle = { display: 'flex', alignItems: 'center', gap: '10px', minHeight: '44px' };

export function NewProtocolUiHost({ controller }: { controller: NewProtocolUi }) {
    const [prompt, setPrompt] = useState(controller.prompt);
    const host = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const unsubscribe = controller.subscribe(() => {
            if (!controller.prompt) host.current?.querySelectorAll<HTMLDialogElement>('dialog[open]')
                .forEach((dialog) => dialog.close());
            setPrompt(controller.prompt);
        });
        const unmount = controller.mount();
        const cancel = () => controller.cancel();
        const blur = () => {
            if (['entry', 'field', 'touch'].includes(controller.prompt?.kind ?? '')) cancel();
        };
        const events = ['lock-workspace', 'user-idle', 'all-files-closed', 'one-file-closed'];
        events.forEach((event) => Events.on(event, cancel));
        Events.on('main-window-blur', blur);
        window.addEventListener('blur', blur);
        return () => {
            unsubscribe();
            events.forEach((event) => Events.off(event, cancel));
            Events.off('main-window-blur', blur);
            window.removeEventListener('blur', blur);
            unmount();
        };
    }, [controller]);
    const cancel = () => { if (controller.prompt === prompt) controller.cancel(); };
    let content: ComponentChildren = null;
    if (prompt) switch (prompt.kind) {
        case 'connect': content = <ConnectDialog key={prompt.id} prompt={prompt} cancel={cancel} />; break;
        case 'entry': content = <EntryDialog key={prompt.id} prompt={prompt} cancel={cancel} />; break;
        case 'field': content = <FieldDialog key={prompt.id} prompt={prompt} cancel={cancel} />; break;
        case 'save': content = <SaveDialog key={prompt.id} prompt={prompt} cancel={cancel} />; break;
        case 'group': content = <GroupDialog key={prompt.id} prompt={prompt} cancel={cancel} />; break;
        case 'touch': content = <PromptDialog key={prompt.id} title={t('Touch your security key')} icon="key" cancel={prompt.cancel}>
            <p>{t('Touch {} to continue.', prompt.input.deviceShortName)}</p>
        </PromptDialog>;
    }
    return <div ref={host} style={{ display: 'contents' }}>{content}</div>;
}

export function PromptDialog({ title, icon, cancel, children, confirm, confirmLabel, disabled = false, focusSearch = false }: {
    title: string; icon: string; cancel: () => void; children: ComponentChildren;
    confirm?: () => void; confirmLabel?: string; disabled?: boolean; focusSearch?: boolean;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const cancelButton = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const callbacks = useRef({ cancel });
    callbacks.current = { cancel };
    useLayoutEffect(() => {
        const element = dialog.current!;
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        try {
            element.showModal();
            if (focusSearch) element.querySelector<HTMLInputElement>('input[type=search]')?.focus();
            else cancelButton.current?.focus();
        } catch { callbacks.current.cancel(); }
        return () => {
            if (element.open) element.close();
            requestAnimationFrame(() => {
                if (previous?.isConnected && !previous.closest('[inert], [hidden]') && !previous.matches(':disabled')
                    && !document.querySelector('dialog[open]')) previous.focus();
            });
        };
    }, []);
    return <dialog ref={dialog} data-extension-prompt aria-labelledby={titleId} aria-modal="true"
        onCancel={(event) => { event.preventDefault(); cancel(); }} onClose={cancel}
        onKeyDown={(event) => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={(event) => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        style={{ width: 'min(520px, calc(100vw - 24px))', maxHeight: 'calc(100dvh - 24px)',
            margin: 'auto', padding: '20px', overflow: 'auto', overflowWrap: 'anywhere',
            border: '1px solid var(--kx-line)', borderRadius: 'var(--kx-radius-card)',
            background: 'var(--kx-bg)', color: 'var(--kx-text)' }}>
        <form onSubmit={(event) => { event.preventDefault(); if (!disabled) confirm?.(); }}>
            <h2 id={titleId} style={{ ...rowStyle, margin: '0 0 12px', fontSize: '20px' }}>
                <Icon name={icon} /><span>{title}</span>
            </h2>
            {children}
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '8px', marginTop: '20px' }}>
                <button ref={cancelButton} type="button" class="pill" onClick={cancel}>{t('Cancel')}</button>
                {confirm && <button type="submit" class="pill pill--primary" disabled={disabled}>{confirmLabel ?? t('Allow')}</button>}
            </div>
        </form>
    </dialog>;
}

function ConnectDialog({ prompt, cancel }: { prompt: PromptOf<'connect'>; cancel(): void }) {
    const { input, complete } = prompt;
    const [files, setFiles] = useState(input.files.filter((file) => file.checked).map((file) => file.id));
    const [allFiles, setAllFiles] = useState(input.allFiles);
    const [askGet, setAskGet] = useState(input.askGet);
    const [canList, setCanList] = useState(input.canList);
    return <PromptDialog title={t('Allow browser extension access')} icon="globe" cancel={cancel}
        disabled={!allFiles && !files.length}
        confirm={() => complete({ files, allFiles, askGet, ...(input.offerList ? { canList } : {}) })}>
        <p>{t('{} requests access to your databases.', input.extensionName)}</p>
        {!input.identityVerified && <p class="muted">{t('The extension identity has not been verified.')}</p>}
        <fieldset style={{ border: 0, padding: 0, minWidth: 0 }}>
            <legend>{t('Databases')}</legend>
            {input.files.map((file, index) => <label key={file.id} style={rowStyle}>
                <input type="checkbox" checked={files.includes(file.id)} onChange={(event) => {
                    if (event.currentTarget.checked) setFiles([...new Set([...files, file.id])]);
                    else { setFiles(files.filter((id) => id !== file.id)); setAllFiles(false); }
                }} /><span>{t('{} ({})', file.name, String(index + 1))}</span>
            </label>)}
            <label style={rowStyle}><input type="checkbox" checked={allFiles} onChange={(event) => {
                setAllFiles(event.currentTarget.checked); setFiles(input.files.map((file) => file.id));
            }} /><span>{t('All databases, including ones opened later')}</span></label>
        </fieldset>
        <label class="vault-form__field">{t('Ask before reading a login')}
            <select class="input" value={askGet} onChange={(event) => setAskGet(event.currentTarget.value)}>
                <option value="multiple">{t('When more than one entry matches')}</option>
                <option value="always">{t('Always')}</option>
            </select>
        </label>
        {input.offerList && <label style={rowStyle}><input type="checkbox" checked={canList}
            onChange={(event) => setCanList(event.currentTarget.checked)} /><span>{t('Allow listing and searching entries')}</span></label>}
        <p class="muted">{input.offerList ? t('This approval is remembered for this paired extension.')
            : t('This approval can be reused when the extension reconnects.')}</p>
    </PromptDialog>;
}

function EntryDialog({ prompt, cancel }: { prompt: PromptOf<'entry'>; cancel(): void }) {
    const { filter } = prompt.input;
    const [, redraw] = useState(0);
    const [selected, setSelected] = useState(0);
    const results = useRef<HTMLDivElement>(null);
    const entries = Array.from(filter.getEntries()) as EntryModel[];
    const update = () => { setSelected(0); redraw((value) => value + 1); };
    const current = entries[Math.min(selected, entries.length - 1)];
    return <PromptDialog title={t('Select an entry')} icon="key" cancel={cancel} focusSearch
        confirmLabel={t('Select entry')} disabled={!current} confirm={() => prompt.complete(current ?? null)}>
        <p>{prompt.input.topMessage}</p>
        <label class="vault-form__field">{t('Search entries')}<input class="input" type="search" autoComplete="off"
            value={filter.text} onInput={(event) => { filter.text = event.currentTarget.value; update(); }} /></label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            <label style={rowStyle}><input type="checkbox" checked={filter.useUrl} disabled={!filter.url}
                onChange={(event) => { filter.useUrl = event.currentTarget.checked; update(); }} />{t('Match URL')}</label>
            <label style={rowStyle}><input type="checkbox" checked={filter.subdomains} disabled={!filter.url}
                onChange={(event) => { filter.subdomains = event.currentTarget.checked; if (filter.subdomains) filter.useUrl = true; update(); }} />{t('Include subdomains')}</label>
            <label style={rowStyle}><input type="checkbox" checked={filter.useTitle} disabled={!filter.title}
                onChange={(event) => { filter.useTitle = event.currentTarget.checked; update(); }} />{t('Match page title')}</label>
        </div>
        <div ref={results} role="listbox" aria-label={t('Matching entries')} style={{ maxHeight: 'min(320px, 40dvh)', overflow: 'auto' }}
            onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                event.preventDefault();
                const next = Math.max(0, Math.min(entries.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
                setSelected(next); results.current?.querySelectorAll<HTMLElement>('[role=option]')[next]?.focus();
            }}>
            {entries.map((entry, index) => <button key={entry.id} type="button" role="option" aria-selected={current === entry}
                tabIndex={current === entry ? 0 : -1} onFocus={() => setSelected(index)} onClick={() => prompt.complete(entry)}
                style={{ ...rowStyle, textAlign: 'left', width: '100%', padding: '10px', border: 0,
                    borderRadius: 'var(--kx-radius-control)', background: current === entry ? 'var(--kx-sel)' : 'var(--kx-bg)' }}>
                <Tile title={entry.title} icon={entry.icon} customIcon={entry.customIcon} />
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><strong>{entry.title || t('Untitled entry')}</strong>
                    <br /><span class="muted">{entry.user}<br />{(entry.file as FileModel).name} / {entry.groupName}</span></span>
            </button>)}
        </div>
        {!entries.length && <p role="status">{t('No matching entries')}</p>}
    </PromptDialog>;
}

function FieldDialog({ prompt, cancel }: { prompt: PromptOf<'field'>; cancel(): void }) {
    const [field, setField] = useState('');
    const fields = Object.entries(prompt.input.entry.getAllFields()).filter(([, value]) => !!value);
    const selected = field || fields[0]?.[0] || '';
    return <PromptDialog title={t('Select a field')} icon="key" cancel={cancel} confirmLabel={t('Use field')}
        disabled={!selected} confirm={() => prompt.complete(selected || null)}>
        <p>{prompt.input.entry.title}</p>
        <fieldset style={{ border: 0, padding: 0, minWidth: 0 }}>
            <legend class="sr-only">{t('Fields')}</legend>
            {fields.map(([name, value]) => <label key={name} style={rowStyle}>
                <input type="radio" name="extension-field" value={name} checked={selected === name} onChange={() => setField(name)} />
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><strong>{name}</strong><br />
                    <span class="muted">{value instanceof ProtectedValue || (typeof value === 'object' && value && 'isProtected' in value && value.isProtected)
                        ? t('Protected value') + ' ••••••••' : typeof value === 'object' ? t('Value') : String(value)}</span></span>
            </label>)}
        </fieldset>
        {!fields.length && <p role="status">{t('No fields available')}</p>}
    </PromptDialog>;
}

function SaveDialog({ prompt, cancel }: { prompt: PromptOf<'save'>; cancel(): void }) {
    const { input } = prompt;
    const [destination, setDestination] = useState(input.allGroups.findIndex((group) => group.selected));
    const [askSave, setAskSave] = useState(input.askSave);
    const group = input.allGroups[destination];
    const fileIds = [...new Set(input.allGroups.map((item) => item.fileId))];
    return <PromptDialog title={t(input.update ? 'Update login' : 'Save login')} icon="save" cancel={cancel}
        disabled={!group} confirm={() => group && prompt.complete({ fileId: group.fileId, groupId: group.id, askSave })}>
        <p>{t('{} wants to save a login.', input.extensionName)}</p>
        <p>{input.url}</p><p>{t('Username: {}', input.user || t('(empty)'))}</p>
        <label class="vault-form__field">{t('Destination group')}
            <select class="input" value={String(destination)} disabled={input.update} required
                onChange={(event) => setDestination(Number(event.currentTarget.value))}>
                {destination < 0 && <option value="-1">{t('Select a group')}</option>}
                {input.allGroups.map((item, index) => <option key={`${item.fileId}:${item.id}`} value={String(index)}>
                    {t('{} ({}) / {}', item.fileName,
                        String(fileIds.indexOf(item.fileId) + 1), item.path.join(' / '))}
                </option>)}
            </select>
        </label>
        <label style={rowStyle}><input type="checkbox" checked={askSave === 'auto'} onChange={(event) => setAskSave(event.currentTarget.checked ? 'auto' : 'always')} />
            <span>{t('Save future logins automatically')}</span></label>
    </PromptDialog>;
}

function GroupDialog({ prompt, cancel }: { prompt: PromptOf<'group'>; cancel(): void }) {
    const { input } = prompt;
    const [fileId, setFileId] = useState(input.files.find((file) => file.selected)?.id ?? '');
    return <PromptDialog title={t('Create extension group')} icon="folder-plus" cancel={cancel}
        disabled={!input.files.some((file) => file.id === fileId)} confirm={() => prompt.complete(fileId)}>
        <p>{t('{} wants to create this group path:', input.extensionName)}</p><p>{input.groupPath}</p>
        <label class="vault-form__field">{t('Database')}
            <select class="input" required value={fileId} onChange={(event) => setFileId(event.currentTarget.value)}>
                {!fileId && <option value="">{t('Select a database')}</option>}
                {input.files.map((file, index) => <option key={file.id} value={file.id}>{t('{} ({})', file.name, String(index + 1))}</option>)}
            </select>
        </label>
    </PromptDialog>;
}
