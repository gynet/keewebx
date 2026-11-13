import { EntryAppearance, EntryFlag, EntryColorFilter } from './entry-appearance';
import { AppSettingsModel } from 'models/app-settings-model';
import { PasswordAudit } from './password-audit';
import { PreferenceTile } from './preference-tile';
/** A vault is open: groups and tags, the entry list, and the selected entry. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import type { AttachmentModel } from 'models/attachment-model';
import { Events } from 'framework/events';
import { entryFieldText, summarizeEntry } from 'comp/extension/entry-list';
import { VaultApi } from 'comp/app/vault-api';
import { getSessionAccess } from 'comp/app/session-access';
import { beginPendingOperation } from './pending-operations';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { DateFormat } from 'comp/i18n/date-format';
import { Icon, Mark } from 'ui-kit/mark';
import { tagColor } from 'ui-kit/tag-color';
import { storageKey } from 'comp/settings/storage-namespace';
import { PanelResizer } from 'ui-kit/panel-resizer';
import { usePanelLayout } from './panel-layout';
import { SidebarToggle, useSidebarCollapse } from './sidebar-collapse';
import { t } from './i18n';
import { ThemeToggle } from './theme';
import { MobileMenu } from './mobile-menu';
import { confirmDiscardDrafts, hasPendingDrafts } from './pending-drafts';
import { Notes } from './notes';
import { prepareOtpDraft } from 'comp/app/entry-otp';
import { EntryEditor, applyEntryDraft } from './entry-editor';
import { EntryTemplates } from './entry-templates';
import type { EntryDraft } from './entry-editor';
import { GroupActions } from './group-actions';
import { GroupLifecycle, TrashGroups } from './group-lifecycle';
import { TagActions } from './tag-actions';
import type { GroupActionResult } from './group-actions';
import { EntryMove } from './entry-move';
import { EntryHistory } from './entry-history';
import { EntryClone } from './entry-clone';
import { EntryDelete } from './entry-delete';
import { EntrySort, sortEntries } from './entry-sort';
import { SearchControls, searchDefaults, type SearchOptions, type SearchScope } from './search-options';
import { commandKey, editingText, keyboardAvailable } from './keyboard';
import { AttachmentPreview, attachmentBytes } from './attachment-preview';


const SYNC_LABELS: Record<string, string> = {
    saved: 'Up to date',
    pending: 'Saving…',
    syncing: 'Saving…',
    offline: 'Offline, saved on this device',
    error: 'Sync failed'
};

const kdbxName = (name: string) => (/\.kdbx$/i.test(name) ? name : `${name}.kdbx`);

function safeWebsiteUrl(text: string): string | undefined {
    const value = text.trim();
    // Reject control characters and backslashes before the URL parser can normalize them.
    // eslint-disable-next-line no-control-regex
    if (!value || /[\x00-\x1f\x7f\\]/.test(value)) {
        return undefined;
    }
    try {
        const candidate = value.startsWith('//') ? `https:${value}`
            : /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
        const url = new URL(candidate);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url.href : undefined;
    } catch {
        return undefined;
    }
}

interface GroupLike {
    id: string;
    title: string;
    items?: GroupLike[] | null;
    visible?: boolean;
    entries?: { length: number };
}

function readExpandedGroups(): Set<string> {
    try {
        const saved: unknown = JSON.parse(localStorage.getItem(storageKey('expandedGroups')) || '[]');
        return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
    } catch { return new Set(); }
}

function groupPath(group: GroupModel): string {
    const names: string[] = [];
    for (let current: GroupModel | null = group; current; current = current.parentGroup) {
        names.unshift(current.title);
    }
    return names.join(' / ');
}

function isWithinGroup(group: GroupModel | null | undefined, id: string): boolean {
    for (let current = group; current; current = current.parentGroup) {
        if (current.id === id) return true;
    }
    return false;
}

export function Vault(props: { model: AppModel; version: number; onSettings: () => void; onLock: () => void; onOpenAnother?: () => void; onSave: () => void; onGenerator: () => void }) {
    const { model } = props;
    const layout = usePanelLayout();
    const sidebar = useSidebarCollapse('vault');
    const [navigationOpen, setNavigationOpen] = useState(false);
    const navigation = useRef<HTMLElement>(null);
    const browse = useRef<HTMLButtonElement>(null);
    const wasNavigationOpen = useRef(false);
    const closeNavigation = () => { setNavigationOpen(false); };
    useLayoutEffect(() => {
        if (!navigationOpen) {
            if (wasNavigationOpen.current) browse.current?.focus();
            wasNavigationOpen.current = false;
            return;
        }
        wasNavigationOpen.current = true;
        const background = [...(navigation.current?.parentElement?.children ?? [])]
            .filter((element) => element !== navigation.current && !element.classList.contains('navigation-backdrop') && !element.hasAttribute('inert'));
        background.forEach((element) => element.setAttribute('inert', ''));
        navigation.current?.querySelector<HTMLButtonElement>('.side__close')?.focus();
        return () => background.forEach((element) => element.removeAttribute('inert'));
    }, [navigationOpen]);
    useEffect(() => {
        if (navigationOpen) navigation.current?.querySelector<HTMLButtonElement>('.side__close')?.focus();
        const resized = () => { if (window.innerWidth > 760) setNavigationOpen(false); };
        window.addEventListener('resize', resized);
        return () => window.removeEventListener('resize', resized);
    }, [navigationOpen]);
    const [filter, setFilter] = useState<SearchScope>({});
    const [options, setOptions] = useState<SearchOptions>(() => ({ ...searchDefaults, ...model.advancedSearch }));
    const vaultSurface = useRef<HTMLDivElement>(null);
    const search = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState('title');
    const viewEpoch = getSessionAccess(model).epoch;
    const [selected, setSelected] = useState<string>();
    const [editing, setEditing] = useState<{ entry: EntryModel } | { group: GroupModel; tag?: string } | null>(null);
    const [expandedGroups, setExpandedGroups] = useState(readExpandedGroups);
    const [rootChoice, setRootChoice] = useState('');
    const [groupMessage, setGroupMessage] = useState('');
    const groupManager = useRef<HTMLDetailsElement>(null);
    const groupSummary = useRef<HTMLElement>(null);
    const changeExpandedGroups = (update: (ids: Set<string>) => void) => {
        setExpandedGroups((current) => {
            const next = new Set(current);
            update(next);
            try { localStorage.setItem(storageKey('expandedGroups'), JSON.stringify([...next])); }
            catch { /* Navigation remains available without persistent storage. */ }
            return next;
        });
    };
    const toggleGroup = (id: string) => changeExpandedGroups((ids) => {
        if (ids.has(id)) ids.delete(id); else ids.add(id);
    });

    const files = model.files as unknown as FileModel[];
    let searchError = '';
    if (options.regex && query) {
        try { new RegExp(query, options.cs ? '' : 'i'); }
        catch { searchError = t('Invalid regular expression. Correct it or turn off Regular expression.'); }
    }
    const prepared = model.prepareFilter({ text: query, ...filter, subGroups: AppSettingsModel.expandGroups, advanced: { ...options, excludeProtected: true } });
    const entries = useMemo(() => {
        if (searchError) return [];
        const result = model.getEntriesByFilter(prepared, model.files);
        sortEntries(result, sort, prepared);
        return [...(result as unknown as EntryModel[])].filter(entry => (entry.file as FileModel).active && (!filter.file || (entry.file as FileModel).id === filter.file));
    }, [query, filter, options, sort, props.version]);
    const historyFilter = options.history && query && !searchError ? { ...prepared, advanced: { ...prepared.advanced, history: false } } : undefined;


    const liveEntry = entries.find((e) => e.id === selected) ?? null;
    const retainedEntry = useRef<EntryModel | null>(null);
    if (liveEntry) retainedEntry.current = liveEntry;
    // Keep an inline draft mounted if a remote deletion/filter change removes its row.
    // Save checks membership and rejects the conflict; the user can copy or discard it.
    const entry = liveEntry ?? (retainedEntry.current?.id === selected && hasPendingDrafts() ? retainedEntry.current : null);
    const sync = model.syncScheduler.summary().state;
    const groups: GroupLike[] = files.flatMap(
        (file) => Array.from(file.groups).flatMap((root) =>
            ((root as unknown as GroupLike).items ?? []).filter((group) => group.visible !== false))
    );
    const roots = files.filter((file) => file.active).flatMap((file) =>
        Array.from(file.groups).map((group, index) => ({ file, group, index })));
    const selectedGroup = filter.group ? files.filter((file) => file.active)
        .map((file) => ({ file, group: file.getGroup(filter.group!) }))
        .find((target): target is { file: FileModel; group: GroupModel } => !!target.group) : undefined;
    const groupTarget = filter.group ? selectedGroup : roots.find(({ group }) => group.id === rootChoice);
    const tags = model.tags;
    const changeFilter = (next: SearchScope) => {
        if (!confirmDiscardDrafts()) return;
        setEditing(null);
        setFilter(next);
        setRootChoice('');
        setGroupMessage('');
        if (navigationOpen) closeNavigation();
    };
    const openGroupManager = () => {
        if (!confirmDiscardDrafts()) return;
        setEditing(null);
        setSelected(undefined);
        closeNavigation();
        if (groupManager.current) groupManager.current.open = true;
        requestAnimationFrame(() => groupSummary.current?.focus());
    };
    const groupChanged = (result: GroupActionResult) => {
        const file = model.files.get(result.fileId);
        setEditing(null);
        if (result.action === 'create') {
            const created = file?.getGroup(result.groupId);
            if (created) {
                changeExpandedGroups((ids) => {
                    for (let parent = created.parentGroup; parent; parent = parent.parentGroup) ids.add(parent.id);
                });
                setFilter({ group: created.id });
                setQuery('');
                setSelected(undefined);
                setRootChoice('');
                setGroupMessage(t('Created group: {}', groupPath(created)));
            }
        } else if (result.action === 'delete') {
            const filtered = filter.group ? file?.getGroup(filter.group) : undefined;
            if (filter.group === result.groupId || isWithinGroup(filtered, result.groupId)) {
                const parent = file?.getGroup(result.parentId);
                setFilter(parent && !parent.top && parent.visible !== false ? { group: parent.id } : {});
                setRootChoice('');
            }
            if (selected) {
                const selectedEntry = file?.getEntry(selected);
                if (isWithinGroup(selectedEntry?.group as GroupModel | undefined, result.groupId)
                    || (!selectedEntry && retainedEntry.current?.file === file)) setSelected(undefined);
            }
            setGroupMessage(t(result.trashed ? 'Group moved to trash.' : 'Group permanently deleted.'));
        } else {
            setGroupMessage(t('Group renamed: {}', file?.getGroup(result.groupId)?.title ?? ''));
        }
    };
    const lifecycleChanged = (group?: GroupModel) => {
        setEditing(null); setSelected(undefined); setQuery('');
        if (group) {
            setFilter({ group: group.id });
            changeExpandedGroups(ids => {
                for (let parent = group.parentGroup; parent; parent = parent.parentGroup) ids.add(parent.id);
            });
        }
    };
    const creationGroup = filter.group ? files.map(file => file.getGroup(filter.group!)).find(Boolean)
        : filter.file ? files.find(file => file.id === filter.file)?.groups[0] : undefined;
    const canCreate = !filter.trash && model.canCreateEntries() && (!(filter.file || filter.group) || !!creationGroup)
        && (!creationGroup || ((creationGroup.file as FileModel).active && !(creationGroup.file as FileModel & { readOnly?: boolean }).readOnly));
    const newEntry = () => {
        if (!canCreate || !confirmDiscardDrafts()) return;
        const groupId = filter.group;
        const group = groupId ? files.map((file) => file.getGroup(groupId)).find(Boolean) : undefined;
        setEditing({ group: group ?? creationGroup ?? model.getFirstSelectedGroupForCreation().group, tag: filter.tag });
    };
    const saveEntry = (draft: EntryDraft) => {
        if (!editing) {
            return;
        }
        prepareOtpDraft(draft.otp);
        const saved = 'entry' in editing ? editing.entry : model.createNewEntryWithFields(editing.group, {});
        applyEntryDraft(saved, draft);
        if (!('entry' in editing) && typeof filter.color === 'string') saved.setColor(filter.color as Parameters<EntryModel['setColor']>[0]);
        model.updateTags();
        Events.emit('entry-updated', { entry: saved });
        setEditing(null);
        // Keep the saved entry visible if its title, tags or search terms changed.
        setFilter({});
        setQuery('');
        setSelected(saved.id);
    };

    const changeSearch = (nextOptions: SearchOptions, nextScope: SearchScope) => {
        if (!confirmDiscardDrafts()) return false;
        setEditing(null); setOptions(nextOptions); setFilter(nextScope); return true;
    };
    const focusSearch = (select = true) => {
        if (!confirmDiscardDrafts()) return;
        setEditing(null); setSelected(undefined); setNavigationOpen(false);
        requestAnimationFrame(() => {
            if (getSessionAccess(model).state !== 'open' || vaultSurface.current?.closest('[hidden], [inert]')) return;
            search.current?.focus();
            if (select) search.current?.select();
            else if (search.current) search.current.setSelectionRange(search.current.value.length, search.current.value.length);
        });
    };
    const chooseEntry = (id: string, keyboard = false) => {
        if (!confirmDiscardDrafts()) return;
        setEditing(null); setSelected(id);
        if (keyboard) requestAnimationFrame(() => {
            if (getSessionAccess(model).state !== 'open' || vaultSurface.current?.closest('[hidden], [inert]')) return;
            const row = vaultSurface.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${id}"]`);
            if (row?.getClientRects().length) { row.focus(); row.scrollIntoView({ block: 'nearest' }); }
            else vaultSurface.current?.querySelector<HTMLElement>('.detail')?.focus();
        });
    };
    useLayoutEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            if (!keyboardAvailable(model, vaultSurface.current, event) || navigationOpen) return;
            const key = event.key.toLowerCase();
            if (commandKey(event) && !event.altKey && !event.shiftKey && key === 'f') {
                event.preventDefault(); focusSearch(); return;
            }
            if (key === 'escape' && event.target === search.current) {
                event.preventDefault();
                if (confirmDiscardDrafts()) { setEditing(null); setQuery(''); }
                return;
            }
            if (key === 'escape' && editing) {
                event.preventDefault();
                if (confirmDiscardDrafts()) setEditing(null);
                return;
            }
            if (editingText(event.target) && !(event.target === search.current && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key))) return;
            if (editing) return;
            if (!event.ctrlKey && !event.metaKey && !event.altKey && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) {
                if (event.key === 'Enter' && event.target !== search.current) return;
                event.preventDefault();
                const current = entries.findIndex(item => item.id === selected);
                const index = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
                    : event.key === 'ArrowUp' ? (current < 0 ? entries.length - 1 : Math.max(0, current - 1))
                        : Math.min(entries.length - 1, current + 1);
                if (entries[index]) chooseEntry(entries[index].id, true);
            } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ['n', 'a', 'c', 'd'].includes(key)) {
                event.preventDefault();
                if (key === 'n') newEntry();
                else changeFilter(key === 'a' ? {} : key === 'd' ? { trash: true } : { color: true });
            } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 && event.key !== ' '
                && !window.getSelection()?.toString()) {
                event.preventDefault();
                if (!confirmDiscardDrafts()) return;
                setQuery(current => current + event.key); focusSearch(false);
            }
        };
        window.addEventListener('keydown', keydown);
        return () => window.removeEventListener('keydown', keydown);
    });

    return (
        <div ref={vaultSurface}
            onKeyDownCapture={(event) => {
                if ((event.isComposing || event.keyCode === 229) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); }
            }}
            class={`${entry || editing ? 'vault vault--detail' : 'vault'}${navigationOpen ? ' vault--navigation' : ''}${sidebar.collapsed ? ' sidebar-folded' : ''}`}
            style={{ '--sidebar-width': `${layout.sidebar}px`, '--list-width': `${layout.list}px` }}
            onKeyDown={(event) => {
                IdleTracker.regUserAction();
                if (!navigationOpen) return;
                if (event.key === 'Escape') { event.preventDefault(); closeNavigation(); }
                if (event.key === 'Tab') {
                    const controls = [...(navigation.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
                        .filter((button) => !button.disabled && button.getClientRects().length);
                    const first = controls[0]; const last = controls[controls.length - 1];
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                }
            }}
            onClick={() => IdleTracker.regUserAction()}
        >
            {navigationOpen && <button class="navigation-backdrop" tabIndex={-1} aria-label={t('Close navigation')} onClick={closeNavigation} />}
            <nav ref={navigation} class="side" aria-label={t('Vault')}>
                <div class="side__vault">
                    <Mark size={30} />
                    <span class="side__vault-text">
                        <span class="side__vault-name">{files.map((f) => kdbxName(f.name)).join(', ')}</span>
                        <span class={`sync sync--${sync}`} id="sync-state">
                            <span class="sync__dot" />
                            {t(SYNC_LABELS[sync] ?? sync)}
                        </span>
                    </span>
                    <SidebarToggle collapsed={sidebar.collapsed} toggle={sidebar.toggle} controls="vault-sidebar-content" label={t('folders panel')} />
                    <button class="round side__close" aria-label={t('Close navigation')} onClick={closeNavigation}><Icon name="back" /></button>
                </div>
                <div id="vault-sidebar-content" class="side__content">
                <NavRow icon="grid" label={t('All items')} on={!Object.values(filter).some(Boolean)} onClick={() => changeFilter({})} />
                <NavRow icon="trash" label={t('Trash')} on={!!filter.trash} onClick={() => changeFilter({ trash: true })} />
                {groups.length > 0 && <h2 class="side__heading">{t('Groups')}</h2>}
                {groups.map((g) => (
                    <GroupBranch key={g.id} group={g} selected={filter.group} onSelect={(id) => changeFilter({ group: id })}
                        expandedGroups={expandedGroups} onToggle={toggleGroup} />
                ))}
                <button type="button" class="nav-row" onClick={openGroupManager}>
                    <Icon name="folder" size={17} />
                    <span class="nav-row__label">{t('Manage groups')}</span>
                </button>
                {tags.length > 0 && <h2 class="side__heading">{t('Tags')}</h2>}
                <div class={AppSettingsModel.tagStyle === 'dot' ? 'tags tags--dots' : 'tags'}>
                    {tags.map((tag) => (
                        <button
                            class={filter.tag === tag ? 'tag tag--on' : 'tag'}
                            style={tagColor(tag)}
                            aria-pressed={filter.tag === tag}
                            onClick={() => changeFilter(filter.tag === tag ? {} : { tag })}
                        >
                            <span class="tag__text">{tag}</span>
                        </button>
                    ))}
                </div>
                </div>
                <div class="sidebar-rail">
                    <button type="button" class="round" aria-label={t('All items')} title={t('All items')} onClick={() => changeFilter({})}><Icon name="grid" size={18} /></button>
                    <button type="button" class="round" aria-label={t('Browse groups')} title={t('Browse groups')} onClick={sidebar.toggle}><Icon name="folder" size={18} /></button>
                    <button type="button" class="round" aria-label={t('Trash')} title={t('Trash')} onClick={() => changeFilter({ trash: true })}><Icon name="trash" size={18} /></button>
                </div>
                <div class="side__foot">
                    <span style={{ flexGrow: 1 }} />
                    {props.onOpenAnother && <button class="round" aria-label={t('Open another vault')} title={t('Open another vault')}
                        onClick={() => { setNavigationOpen(false); props.onOpenAnother?.(); }}><Icon name="plus" size={17} /></button>}
                    <ThemeToggle />
                    <button hidden={!model.settings.canOpenSettings} class="round" aria-label={t('Settings')} title={t('Settings')} id="open-settings" onClick={() => { setNavigationOpen(false); props.onSettings(); }}>
                        <Icon name="gear" size={17} />
                    </button>
                    <button class="round" aria-label={t('Lock')} title={t('Lock')} id="lock" onClick={props.onLock}>
                        <Icon name="lock" size={17} />
                    </button>
                </div>
            </nav>

            <PanelResizer label={t('Resize folders panel')} value={layout.sidebar} min={180} max={layout.sidebarMax}
                onChange={(width) => layout.set('sidebar', width)} onReset={() => layout.reset('sidebar')} />

            <section class="list" aria-label={t('Entries')}>
                <div class="list__bar">
                    <label class="search">
                        <Icon name="search" size={15} />
                        <input
                            ref={search}
                            id="search"
                            aria-invalid={!!searchError}
                            aria-describedby={searchError ? 'search-error' : undefined}
                            type="search"
                            aria-label={t('Search')}
                            placeholder={t('Search')}
                            value={query}
                            onInput={(e) => {
                                if (!confirmDiscardDrafts()) { e.currentTarget.value = query; return; }
                                setEditing(null); setQuery(e.currentTarget.value);
                            }}
                        />
                    </label>
                </div>
                {searchError && <p id="search-error" class="error" role="alert" style={{ margin: '0 14px 6px' }}>{searchError}</p>}
                <SearchControls model={model} options={options} scope={filter} change={changeSearch}
                    reset={() => { if (changeSearch({ ...searchDefaults, ...model.advancedSearch }, {})) setQuery(''); }} />
                <div class="vault-commands">
                    <button type="button" class="pill" onClick={props.onSave}>{t('Save vaults')}</button>
                    <button type="button" class="pill" onClick={props.onGenerator}>{t('Password generator')}</button>
                </div>
                <EntrySort value={sort} onChange={next => {
                    const access = getSessionAccess(model);
                    if (access.state !== 'open' || !access.isCurrent(viewEpoch)) return false;
                    // Sorting changes presentation only: retain selection and the mounted draft.
                    setSort(next); return true;
                }} />
                <button class="pill entry-list__create" disabled={!!editing || !canCreate} onClick={newEntry}>
                    {t('New entry')}
                </button>
                <EntryTemplates model={model} groupId={filter.group} onCreated={entry => {
                    setEditing(null); setFilter({ group: (entry.group as GroupModel).id }); setQuery(''); setSelected(entry.id);
                }} />
                <details ref={groupManager} style={{ flex: '0 0 auto', margin: '0 14px 6px', minWidth: 0 }}>
                    <summary ref={groupSummary} style={{ cursor: 'pointer', padding: '10px 0', fontWeight: 600 }}>
                        {t('Manage groups')}
                    </summary>
                    <div style={{ maxHeight: 'min(360px, 50dvh)', overflowY: 'auto', padding: '4px 2px 10px', overflowWrap: 'anywhere' }}>
                        {filter.group ? <p style={{ margin: '0 0 12px' }}>
                            {groupTarget ? t('Selected group: {}', groupPath(groupTarget.group))
                                : t('The selected group is no longer available. Select another group or All items.')}
                        </p> : <label class="vault-form__field">{t('Choose a vault root')}
                            <select class="input" value={groupTarget?.group.id ?? ''} onChange={(event) => {
                                if (!confirmDiscardDrafts()) { event.currentTarget.value = rootChoice; return; }
                                setRootChoice(event.currentTarget.value);
                                setGroupMessage('');
                            }}>
                                <option value="">{t('Select a vault and root…')}</option>
                                {roots.map(({ file, group, index }) => <option key={group.id} value={group.id}>
                                    {t('{} (vault {}) — root {}: {}', kdbxName(file.name), String(files.indexOf(file) + 1), String(index + 1), group.title)}
                                </option>)}
                            </select>
                        </label>}
                        {groupTarget && <>
                            <p class="muted" style={{ margin: '0 0 12px' }}>
                                {t('Database: {} (vault {})', kdbxName(groupTarget.file.name), String(files.indexOf(groupTarget.file) + 1))}
                            </p>
                            <GroupActions key={groupTarget.group.id} model={model} file={groupTarget.file} group={groupTarget.group}
                                onComplete={groupChanged} getReturnFocus={() => groupSummary.current} />
                            <GroupLifecycle key={`organize-${groupTarget.group.id}`} model={model} file={groupTarget.file} group={groupTarget.group}
                                onChanged={lifecycleChanged} />
                        </>}
                        {!filter.group && <p class="muted">{t('Choose a root to create a top-level group. Select a group in Browse vault to rename, delete or create a subgroup.')}</p>}
                        {groupMessage && <p role="status">{groupMessage}</p>}
                    </div>
                </details>
                {filter.trash && <TrashGroups model={model} onChanged={lifecycleChanged} />}
                {filter.tag && <TagActions key={filter.tag} model={model} tag={filter.tag} onChanged={tag => {
                    setEditing(null); setSelected(undefined); setFilter(tag ? { tag } : {}); setQuery('');
                }} />}
                <EntryColorFilter value={filter.color === true ? 'any' : filter.color || undefined} onChange={color => changeFilter({ ...filter, color: color === 'any' ? true : color || undefined })} />
                <p class="list__meta">{t('{} items', String(entries.length))}</p>
                <div class="list__items">
                    {entries.map((e) => {
                        const s = summarizeEntry(e);
                        return (
                            <button
                                key={e.id}
                                class={e.id === selected ? 'entry-row entry-row--on' : 'entry-row'}
                                data-entry={s.title}
                                data-entry-id={e.id}
                                aria-current={e.id === selected ? 'true' : undefined}
                                onClick={() => chooseEntry(e.id)}
                            >
                                <EntryFlag color={e.color} />
                                <PreferenceTile title={s.title} icon={s.icon} customIcon={e.customIcon} url={s.url} list />
                                <span class="entry-row__text">
                                    <span class="entry-row__title" title={s.title || t('(no title)')}>{s.title || t('(no title)')}</span>
                                    <span class="entry-row__sub">{historyFilter && !e.matches(historyFilter) ? t('Match in history — open History') : s.user || s.url}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            </section>

            <PanelResizer label={t('Resize entries panel')} value={layout.list} min={240} max={layout.listMax}
                onChange={(width) => layout.set('list', width)} onReset={() => layout.reset('list')} />

            <MobileMenu>
                <button ref={browse} class="round" aria-label={t('Browse vault')} aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}>
                    <Icon name="folder" size={18} />
                </button>
                {props.onOpenAnother && <button class="round" aria-label={t('Open another vault')} onClick={props.onOpenAnother}><Icon name="plus" size={18} /></button>}
                <ThemeToggle />
                <button hidden={!model.settings.canOpenSettings} class="round" aria-label={t('Settings')} onClick={props.onSettings}>
                    <Icon name="gear" size={18} />
                </button>
                <button class="round" aria-label={t('Lock')} onClick={props.onLock}>
                    <Icon name="lock" size={18} />
                </button>
            </MobileMenu>

            {editing ? (
                <EntryEditor model={model} key={'entry' in editing ? editing.entry.id : 'new'}
                    entry={'entry' in editing ? editing.entry : null}
                    group={'group' in editing ? editing.group : undefined}
                    tags={'tag' in editing && editing.tag ? [editing.tag] : []}
                    onSave={saveEntry} onCancel={() => setEditing(null)} />
            ) : entry ? (
                <EntryDetail key={entry.id} model={model} entry={entry} historyFilter={historyFilter} onBack={() => {
                    if (confirmDiscardDrafts()) setSelected(undefined);
                }}
                    onEdit={() => { if (confirmDiscardDrafts()) setEditing({ entry }); }}
                    onCloned={(id, groupId) => {
                        setFilter({ group: groupId }); setQuery(''); setSelected(id);
                    }}
                    onMoved={(entryId, groupId) => {
                        setFilter({ group: groupId });
                        setQuery('');
                        setSelected(entryId);
                        const group = (entry.file as FileModel).getGroup(groupId);
                        changeExpandedGroups((ids) => {
                            for (let parent = group?.parentGroup; parent; parent = parent.parentGroup) ids.add(parent.id);
                        });
                    }}
                    onDeleted={() => setSelected(undefined)}
                    inTrash={!!filter.trash} />
            ) : (
                <main class="detail">
                    <p class="empty">{t('Select an entry')}</p>
                </main>
            )}
        </div>
    );
}

function GroupBranch({ group, selected, onSelect, expandedGroups, onToggle }: {
    group: GroupLike; selected?: string; onSelect: (id: string) => void;
    expandedGroups: ReadonlySet<string>; onToggle: (id: string) => void;
}) {
    const expanded = expandedGroups.has(group.id);
    const children = Array.from(group.items ?? []).filter((child) => child.visible !== false);
    return <div class="group-branch">
        <div class="group-branch__row">
            {children.length > 0 ? <button class="group-branch__toggle" type="button"
                aria-label={t(expanded ? 'Collapse {}' : 'Expand {}', group.title)} aria-expanded={expanded}
                onClick={() => onToggle(group.id)}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"
                    style={{ transform: expanded ? 'rotate(90deg)' : undefined }}>
                    <path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" />
                </svg>
            </button> : <span class="group-branch__spacer" />}
            <NavRow icon="folder" label={group.title} on={selected === group.id} onClick={() => onSelect(group.id)} />
        </div>
        {expanded && children.length > 0 && <div class="group-branch__children">
            {children.map((child) => <GroupBranch key={child.id} group={child} selected={selected} onSelect={onSelect}
                expandedGroups={expandedGroups} onToggle={onToggle} />)}
        </div>}
    </div>;
}

function NavRow(props: { icon: string; label: string; on: boolean; onClick: () => void }) {
    return (
        <button class={props.on ? 'nav-row nav-row--on' : 'nav-row'} onClick={props.onClick}>
            <Icon name={props.icon} size={17} />
            <span class="nav-row__label">{props.label}</span>
        </button>
    );
}

function useOtp(entry: EntryModel): { code: string; left: number; counterBased: boolean } | null {
    const [otp, setOtp] = useState<{ code: string; left: number; counterBased: boolean } | null>(null);
    useEffect(() => {
        entry.initOtpGenerator();
        const generator = entry.otpGenerator;
        if (!generator) {
            setOtp(null);
            return;
        }
        let stopped = false;
        const tick = () =>
            generator.next((err, pass, timeLeft) => {
                if (!stopped && !err && pass) {
                    setOtp({ code: pass, left: Math.ceil((timeLeft ?? 0) / 1000), counterBased: generator.type === 'hotp' });
                }
            });
        tick();
        const timer = generator.type === 'hotp' ? undefined : setInterval(tick, 1000);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [entry.id, entry.entry.fields.get('otp'), entry.entry.fields.get('TOTP Seed'), entry.entry.fields.get('TOTP Settings')]);
    return otp;
}

function EntryDetail({ model, entry, onBack, onEdit, onMoved, onCloned, onDeleted, inTrash, historyFilter }: {
    model: AppModel;
    entry: EntryModel;
    onBack: () => void;
    onEdit: () => void;
    onMoved: (entryId: string, groupId: string) => void;
    onCloned: (entryId: string, groupId: string) => void;
    onDeleted: () => void;
    inTrash?: boolean;
    historyFilter?: Parameters<AppModel['prepareFilter']>[0];
}) {
    const detail = useRef<HTMLElement>(null);
    const s = summarizeEntry(entry);
    const otp = useOtp(entry);
    const [reveal, setReveal] = useState(false);
    const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());
    const [copied, setCopied] = useState('');
    const [notesVersion, setNotesVersion] = useState(0);
    const password = entry.password?.getText?.() ?? '';
    const website = safeWebsiteUrl(entry.url);

    const copy = async (key: string, read: () => Promise<string>) => {
        const access = getSessionAccess(model);
        const epoch = access.epoch;
        try {
            access.assertOpen(epoch);
            const text = await read();
            access.assertOpen(epoch);
            await navigator.clipboard.writeText(text);
            VaultApi.copied({ text, password: key === 'password', sessionEpoch: epoch });
            access.assertOpen(epoch);
            setCopied(key);
            setTimeout(() => setCopied(''), 1500);
        } catch { setCopied(''); }
    };

    useLayoutEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            if (!keyboardAvailable(model, detail.current, event) || editingText(event.target) || window.getSelection()?.toString()) return;
            const key = event.key.toLowerCase();
            let field: string | undefined;
            if (commandKey(event) && !event.shiftKey && !event.altKey) field = ({ c: 'password', b: 'user', u: 'url' } as Record<string, string>)[key];
            else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && key === '2') field = 'otp';
            if (field) {
                event.preventDefault();
                void copy(field, () => entryFieldText(entry, field!));
            } else if (commandKey(event) && !event.altKey && ['Delete', 'Backspace'].includes(event.key)) {
                const row = event.target instanceof Element ? event.target.closest('[data-attachment]') : null;
                const button = row?.querySelector<HTMLButtonElement>('button:last-child');
                if (!row || !detail.current?.contains(row) || !button || button.disabled) return;
                event.preventDefault();
                if (window.confirm(t('Remove attachment {}?', row.getAttribute('data-attachment') ?? ''))) button.click();
            }
        };
        window.addEventListener('keydown', keydown);
        return () => window.removeEventListener('keydown', keydown);
    });

    const custom = Object.entries(entry.fields ?? {}).filter(([k]) => k !== 'otp' && k !== 'TOTP Seed' && k !== 'TOTP Settings');
    const rows: { key: string; label: string; value: string; text: () => Promise<string>; mono?: boolean; secret?: boolean }[] = [];
    if (entry.user) {
        rows.push({ key: 'user', label: t('Username'), value: entry.user, text: () => entryFieldText(entry, 'user') });
    }
    if (password) {
        rows.push({
            key: 'password',
            label: t('Password'),
            value: reveal ? password : '••••••••••••',
            text: () => entryFieldText(entry, 'password'),
            mono: true,
            secret: true
        });
    }
    if (otp) {
        rows.push({
            key: 'otp',
            label: t('One-time code'),
            value: `${otp.code.slice(0, 3)} ${otp.code.slice(3)}`,
            text: () => Promise.resolve(otp.code),
            mono: true
        });
    }
    for (const [name, value] of custom) {
        const protectedValue = value as { getText?: () => string };
        const text = typeof protectedValue?.getText === 'function' ? protectedValue.getText() : String(value ?? '');
        const secret = typeof protectedValue?.getText === 'function';
        rows.push({ key: `field:${name}`, label: name, value: secret && !revealedFields.has(`field:${name}`) ? '••••••••' : text,
            secret, text: () => Promise.resolve(text) });
    }

    return (
        <main ref={detail} class="detail" tabIndex={-1} aria-label={s.title}>
            <div class="detail__head entry-detail__head">
                <button class="round phone-only" aria-label={t('Back')} onClick={onBack} style={{ display: 'none' }}>
                    <Icon name="back" size={17} />
                </button>
                <PreferenceTile title={s.title} icon={s.icon} customIcon={entry.customIcon} url={s.url} large />
                <div style={{ flexGrow: 1, minWidth: 0 }}>
                    <h1 class="detail__title" id="entry-title">
                        {s.title || t('(no title)')}
                    </h1>
                    <EntryFlag color={entry.color} />
                    <span class="detail__where" style={{ overflowWrap: 'anywhere' }}>{entry.groupName}</span>
                </div>
                <div class="entry-detail__actions">
                    <button class="pill pill--tinted" onClick={onEdit}><Icon name="edit" size={16} />{t('Edit')}</button>
                    <EntryAppearance model={model} entry={entry} />
                    <EntryMove model={model} entry={entry} onMoved={onMoved} restore={inTrash} />
                    {!inTrash && <EntryClone model={model} entry={entry} onCloned={onCloned} />}
                    <EntryHistory entry={entry} searchFilter={historyFilter} onRestore={() => setNotesVersion(value => value + 1)} />
                    <EntryDelete model={model} entry={entry} onDeleted={onDeleted} />
                </div>
            </div>

            <PasswordAudit model={model} entry={entry} />
            {(rows.length > 0 || entry.url) && (
                <div class="fields">
                    {rows.map((r) => (
                        <div class="field" data-field={r.key}>
                            <span class="field__text">
                                <span class="field__label">{r.label}</span>
                                <span class={r.mono ? 'field__value field__value--mono' : 'field__value'}>{r.value}</span>
                            </span>
                            {r.key === 'otp' && otp && <span class="muted" style={{ fontSize: '12px' }}>{otp.counterBased
                                ? t('Counter-based OTP; this app does not advance its counter.') : t('{} s', String(otp.left))}</span>}
                            {r.secret && (
                                <button class="icon-btn" aria-label={r.key === 'password' ? (reveal ? t('Hide password') : t('Show password'))
                                    : t(revealedFields.has(r.key) ? 'Hide {}' : 'Show {}', r.label)} onClick={() => {
                                    if (r.key === 'password') setReveal(!reveal);
                                    else setRevealedFields(current => {
                                        const next = new Set(current); if (next.has(r.key)) next.delete(r.key); else next.add(r.key); return next;
                                    });
                                }}>
                                    <Icon name="eye" size={17} />
                                </button>
                            )}
                            <button class="field__action" onClick={() => void copy(r.key, r.text)}>
                                {copied === r.key ? t('Copied') : t('Copy')}
                            </button>
                        </div>
                    ))}
                    {entry.url && (
                        <div class="field" data-field="url">
                            <span class="field__text">
                                <span class="field__label">{t('Website')}</span>
                                <span class="field__value">{entry.url}</span>
                            </span>
                            {website && <a class="field__action" href={website} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                                {t('Open')}
                            </a>}
                            <button class="field__action" onClick={() => void copy('url', () => entryFieldText(entry, 'url'))}>
                                {copied === 'url' ? t('Copied') : t('Copy')}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {entry.tags.length > 0 && (
                <div>
                    <h2 class="section-title">{t('Tags')}</h2>
                    <div class="tags" style={{ padding: 0 }}>
                        {entry.tags.map((tag) => (
                            <span class="tag" style={tagColor(tag)}><span class="tag__text">{tag}</span></span>
                        ))}
                    </div>
                </div>
            )}

            <Notes key={`${entry.id}:${notesVersion}`} entry={entry} />

            <Attachments key={entry.id} model={model} entry={entry} />

            <dl class="detail__foot entry-metadata">
                <dt>{t('Database')}</dt><dd>{entry.fileName}</dd>
                <dt>{t('Group')}</dt><dd>{groupPath(entry.group as GroupModel)}</dd>
                <dt>{t('Created')}</dt><dd>{DateFormat.dtStr(entry.created)}</dd>
                <dt>{t('Updated')}</dt><dd>{DateFormat.dtStr(entry.updated)}</dd>
                <dt>{t('Expires')}</dt><dd>{entry.expires ? DateFormat.dtStr(entry.expires) : t('Never')}{entry.expired ? ` (${t('Expired')})` : ''}</dd>
            </dl>
        </main>
    );
}

function Attachments({ model, entry }: { model: AppModel; entry: EntryModel }) {
    const input = useRef<HTMLInputElement>(null);
    const mounted = useRef(true);
    const working = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [preview, setPreview] = useState<AttachmentModel | null>(null);
    const file = entry.file as FileModel;
    const writable = file.active && !(file as unknown as { readOnly?: boolean }).readOnly;
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const updated = () => {
        // Binary creation is asynchronous: schedule the completed mutation too.
        file.setModified();
        Events.emit('entry-updated', { entry });
    };
    const upload = async (attachments: File[]) => {
        if (!attachments.length || working.current || !writable) {
            return;
        }
        setError('');
        const names = new Set(attachments.map((item) => item.name));
        if (names.size !== attachments.length || entry.attachments.some((item) => names.has(item.title || ''))) {
            setError(t('An attachment with this name already exists. Remove it before uploading a replacement.'));
            return;
        }
        working.current = true;
        const finished = beginPendingOperation(model);
        const access = getSessionAccess(model);
        const epoch = access.epoch;
        const canPublish = () => mounted.current && file.active &&
            !(file as unknown as { readOnly?: boolean }).readOnly &&
            ((access.state === 'open' && access.epoch === epoch) ||
                (access.state === 'securing' && access.epoch === epoch + 1));
        setBusy(true);
        let message = t('Could not read the attachment. Try selecting the file again.');
        try {
            access.assertOpen(epoch);
            const items = await Promise.all(attachments.map(async (attachment) => ({ name: attachment.name, data: await attachment.arrayBuffer() })));
            // Lock waits for this registered operation before saving/closing. Let an
            // already requested upload finish, but not after timeout or recovery.
            if (!canPublish()) {
                throw new Error('Attachment operation expired');
            }
            if (!mounted.current || !file.active) {
                return;
            }
            message = t('Could not save the attachment. Try again.');
            await entry.addAttachments(items, canPublish);
            if (file.active) {
                updated();
            }
        } catch {
            if (mounted.current) {
                setError(message);
            }
        } finally {
            finished();
            working.current = false;
            if (mounted.current) {
                setBusy(false);
            }
        }
    };
    const remove = (name: string) => {
        if (working.current || !writable) {
            return;
        }
        setError('');
        try {
            entry.removeAttachment(name);
            updated();
        } catch {
            setError(t('Could not remove the attachment. Try again.'));
        }
    };
    const download = (attachment: AttachmentModel) => {
        setError('');
        let url: string | undefined;
        const link = document.createElement('a');
        try {
            getSessionAccess(model).assertOpen();
            if (!file.active || file.getEntry(entry.id) !== entry || !entry.attachments.includes(attachment)) throw new Error('Attachment expired');
            const data = attachmentBytes(attachment);
            url = URL.createObjectURL(new Blob([new Uint8Array(data).buffer], {
                type: attachment.mimeType ?? 'application/octet-stream'
            }));
            link.href = url;
            link.download = attachment.title ?? t('Attachment');
            document.body.appendChild(link);
            link.click();
        } catch {
            setError(t('Could not download the attachment. Try again.'));
        } finally {
            link.remove();
            if (url) {
                const objectUrl = url;
                setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
            }
        }
    };

    return (
        <section class="entry-attachments" aria-label={t('Attachments')} aria-busy={busy}
            onDragOver={(event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); }}
            onDrop={(event) => { event.preventDefault(); event.stopPropagation(); void upload(Array.from(event.dataTransfer?.files || [])); }}>
            <div class="entry-attachments__head">
                <h2 class="section-title">{t('Attachments')}</h2>
                <button class="pill" type="button" disabled={busy || !writable} onClick={() => input.current?.click()}>
                    {busy ? t('Adding attachment…') : t('Add attachment')}
                </button>
                <input ref={input} type="file" multiple hidden aria-label={t('Attachment file')} disabled={busy || !writable}
                    onChange={(event) => {
                        const attachments = Array.from(event.currentTarget.files || []);
                        event.currentTarget.value = '';
                        void upload(attachments);
                    }} />
            </div>
            {entry.attachments.length === 0 && <p class="muted">{t('No attachments')}</p>}
            {entry.attachments.map((attachment) => (
                <div class="attachment entry-attachments__row" key={attachment.title} data-attachment={attachment.title}>
                    <Icon name="paperclip" size={16} />
                    <span class="entry-attachments__name">{attachment.title}</span>
                    <button class="link" type="button" disabled={busy} onClick={() => setPreview(attachment)}>{t('Preview')}</button>
                    <button class="link" type="button" disabled={busy} onClick={() => download(attachment)}>{t('Download')}</button>
                    <button class="link" type="button" disabled={busy || !writable}
                        onClick={() => remove(attachment.title ?? '')}>{t('Remove attachment')}</button>
                </div>
            ))}
            {error && <p class="error" role="alert">{error}</p>}
            {preview && <AttachmentPreview key={preview.title} model={model} entry={entry} attachment={preview}
                close={() => setPreview(null)} download={() => download(preview)} />}
        </section>
    );
}
