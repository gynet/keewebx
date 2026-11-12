/** A vault is open: groups and tags, the entry list, and the selected entry. */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import type { AttachmentModel } from 'models/attachment-model';
import { Events } from 'framework/events';
import { entryFieldText, summarizeEntry } from 'comp/extension/entry-list';
import { VaultApi } from 'comp/app/vault-api';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { DateFormat } from 'comp/i18n/date-format';
import { Icon, Mark, Tile } from 'ui-kit/mark';
import { t } from './i18n';
import { ThemeToggle } from './theme';
import { MobileMenu } from './mobile-menu';
import { confirmDiscardDrafts } from './pending-drafts';
import { Notes } from './notes';
import { EntryEditor, applyEntryDraft } from './entry-editor';
import type { EntryDraft } from './entry-editor';

interface Filter {
    group?: string;
    tag?: string;
    trash?: boolean;
}

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

export function Vault(props: { model: AppModel; version: number; onSettings: () => void; onLock: () => void }) {
    const { model } = props;
    const [filter, setFilter] = useState<Filter>({});
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<string>();
    const [editing, setEditing] = useState<{ entry: EntryModel } | { group: GroupModel; tag?: string } | null>(null);

    const files = model.files as unknown as FileModel[];
    const entries = useMemo(() => {
        const result = model.getEntriesByFilter(
            { text: query, group: filter.group, tag: filter.tag, trash: filter.trash, subGroups: true },
            model.files
        );
        result.sortEntries('title', {});
        return [...(result as unknown as EntryModel[])];
    }, [query, filter, props.version]);

    const entry = entries.find((e) => e.id === selected) ?? null;
    const sync = model.syncScheduler.summary().state;
    const groups: GroupLike[] = files.flatMap(
        (f) => ((f.groups?.[0] as unknown as GroupLike)?.items ?? []).filter((g) => g.visible !== false)
    );
    const tags = model.tags;
    const changeFilter = (next: Filter) => {
        if (!confirmDiscardDrafts()) return;
        setEditing(null);
        setFilter(next);
    };
    const newEntry = () => {
        const groupId = filter.group;
        const group = groupId ? files.map((file) => file.getGroup(groupId)).find(Boolean) : undefined;
        setEditing({ group: group ?? model.getFirstSelectedGroupForCreation().group, tag: filter.tag });
    };
    const saveEntry = (draft: EntryDraft) => {
        if (!editing) {
            return;
        }
        const saved = 'entry' in editing ? editing.entry : model.createNewEntryWithFields(editing.group, {});
        applyEntryDraft(saved, draft);
        model.updateTags();
        Events.emit('entry-updated', { entry: saved });
        setEditing(null);
        // Keep the saved entry visible if its title, tags or search terms changed.
        setFilter({});
        setQuery('');
        setSelected(saved.id);
    };
    const moveToTrash = () => {
        if (!entry || !(entry.file as FileModel).db.meta.recycleBinEnabled) {
            return;
        }
        entry.moveToTrash();
        setSelected(undefined);
        Events.emit('refresh');
    };
    const restoreEntry = () => {
        if (!entry) {
            return;
        }
        const root = (entry.file as FileModel).groups[0];
        root.moveHere(entry);
        setFilter({});
        setQuery('');
        Events.emit('refresh');
    };

    return (
        <div
            class={entry || editing ? 'vault vault--detail' : 'vault'}
            onKeyDown={() => IdleTracker.regUserAction()}
            onClick={() => IdleTracker.regUserAction()}
        >
            <nav class="side" aria-label={t('Vault')}>
                <div class="side__vault">
                    <Mark size={30} />
                    <span class="side__vault-text">
                        <span class="side__vault-name">{files.map((f) => kdbxName(f.name)).join(', ')}</span>
                        <span class={`sync sync--${sync}`} id="sync-state">
                            <span class="sync__dot" />
                            {t(SYNC_LABELS[sync] ?? sync)}
                        </span>
                    </span>
                </div>
                <NavRow icon="grid" label={t('All items')} on={!filter.group && !filter.tag && !filter.trash} onClick={() => changeFilter({})} />
                <NavRow icon="trash" label={t('Trash')} on={!!filter.trash} onClick={() => changeFilter({ trash: true })} />
                {groups.length > 0 && <h2 class="side__heading">{t('Groups')}</h2>}
                {groups.map((g) => (
                    <NavRow icon="folder" label={g.title} on={filter.group === g.id} onClick={() => changeFilter({ group: g.id })} />
                ))}
                {tags.length > 0 && <h2 class="side__heading">{t('Tags')}</h2>}
                <div class="tags">
                    {tags.map((tag) => (
                        <button
                            class={filter.tag === tag ? 'tag tag--on' : 'tag'}
                            onClick={() => changeFilter(filter.tag === tag ? {} : { tag })}
                        >
                            {tag}
                        </button>
                    ))}
                </div>
                <div class="side__foot">
                    <span style={{ flexGrow: 1 }} />
                    <ThemeToggle />
                    <button class="round" aria-label={t('Settings')} title={t('Settings')} id="open-settings" onClick={props.onSettings}>
                        <Icon name="gear" size={17} />
                    </button>
                    <button class="round" aria-label={t('Lock')} title={t('Lock')} id="lock" onClick={props.onLock}>
                        <Icon name="lock" size={17} />
                    </button>
                </div>
            </nav>

            <section class="list" aria-label={t('Entries')}>
                <div class="list__bar">
                    <label class="search">
                        <Icon name="search" size={15} />
                        <input
                            id="search"
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
                <button class="pill entry-list__create" disabled={!!editing || !model.canCreateEntries()} onClick={newEntry}>
                    {t('New entry')}
                </button>
                <p class="list__meta">{t('{} items', String(entries.length))}</p>
                <div class="list__items">
                    {entries.map((e) => {
                        const s = summarizeEntry(e);
                        return (
                            <button
                                class={e.id === selected ? 'entry-row entry-row--on' : 'entry-row'}
                                data-entry={s.title}
                                onClick={() => {
                                    if (!confirmDiscardDrafts()) return;
                                    setEditing(null); setSelected(e.id);
                                }}
                            >
                                <Tile title={s.title} icon={s.icon} customIcon={s.customIcon} />
                                <span class="entry-row__text">
                                    <span class="entry-row__title">{s.title || t('(no title)')}</span>
                                    <span class="entry-row__sub">{s.user || s.url}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            </section>

            <MobileMenu>
                <ThemeToggle />
                <button class="round" aria-label={t('Settings')} onClick={props.onSettings}>
                    <Icon name="gear" size={18} />
                </button>
                <button class="round" aria-label={t('Lock')} onClick={props.onLock}>
                    <Icon name="lock" size={18} />
                </button>
            </MobileMenu>

            {editing ? (
                <EntryEditor key={'entry' in editing ? editing.entry.id : 'new'}
                    entry={'entry' in editing ? editing.entry : null}
                    tags={'tag' in editing && editing.tag ? [editing.tag] : []}
                    onSave={saveEntry} onCancel={() => setEditing(null)} />
            ) : entry ? (
                <EntryDetail key={entry.id} entry={entry} onBack={() => setSelected(undefined)}
                    onEdit={() => setEditing({ entry })}
                    onDelete={!filter.trash && (entry.file as FileModel).db.meta.recycleBinEnabled ? moveToTrash : undefined}
                    onRestore={filter.trash ? restoreEntry : undefined} />
            ) : (
                <main class="detail">
                    <p class="empty">{t('Select an entry')}</p>
                </main>
            )}
        </div>
    );
}

function NavRow(props: { icon: string; label: string; on: boolean; onClick: () => void }) {
    return (
        <button class={props.on ? 'nav-row nav-row--on' : 'nav-row'} onClick={props.onClick}>
            <Icon name={props.icon} size={17} />
            <span class="nav-row__label">{props.label}</span>
        </button>
    );
}

function useOtp(entry: EntryModel): { code: string; left: number } | null {
    const [otp, setOtp] = useState<{ code: string; left: number } | null>(null);
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
                    setOtp({ code: pass, left: Math.ceil((timeLeft ?? 0) / 1000) });
                }
            });
        tick();
        const timer = setInterval(tick, 1000);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [entry.id]);
    return otp;
}

function EntryDetail({ entry, onBack, onEdit, onDelete, onRestore }: {
    entry: EntryModel;
    onBack: () => void;
    onEdit: () => void;
    onDelete?: () => void;
    onRestore?: () => void;
}) {
    const s = summarizeEntry(entry);
    const otp = useOtp(entry);
    const [reveal, setReveal] = useState(false);
    const [copied, setCopied] = useState('');
    const password = entry.password?.getText?.() ?? '';
    const website = safeWebsiteUrl(entry.url);

    const copy = async (key: string, text: string) => {
        await navigator.clipboard.writeText(text);
        VaultApi.copied({});
        setCopied(key);
        setTimeout(() => setCopied(''), 1500);
    };

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
        rows.push({ key: `field:${name}`, label: name, value: secret ? '••••••••' : text, text: () => Promise.resolve(text) });
    }

    return (
        <main class="detail" aria-label={s.title}>
            <div class="detail__head entry-detail__head">
                <button class="round phone-only" aria-label={t('Back')} onClick={onBack} style={{ display: 'none' }}>
                    <Icon name="back" size={17} />
                </button>
                <Tile title={s.title} icon={s.icon} customIcon={s.customIcon} large />
                <div style={{ flexGrow: 1, minWidth: 0 }}>
                    <h1 class="detail__title" id="entry-title">
                        {s.title || t('(no title)')}
                    </h1>
                    <span class="detail__where">{entry.groupName}</span>
                </div>
                <div class="entry-detail__actions">
                    <button class="pill" onClick={onEdit}>{t('Edit')}</button>
                    {onDelete && <button class="pill" onClick={onDelete}>{t('Move to Trash')}</button>}
                    {onRestore && <button class="pill" onClick={onRestore}>{t('Restore')}</button>}
                </div>
            </div>

            {(rows.length > 0 || entry.url) && (
                <div class="fields">
                    {rows.map((r) => (
                        <div class="field" data-field={r.key}>
                            <span class="field__text">
                                <span class="field__label">{r.label}</span>
                                <span class={r.mono ? 'field__value field__value--mono' : 'field__value'}>{r.value}</span>
                            </span>
                            {r.key === 'otp' && otp && <span class="muted" style={{ fontSize: '12px' }}>{t('{} s', String(otp.left))}</span>}
                            {r.secret && (
                                <button class="icon-btn" aria-label={reveal ? t('Hide password') : t('Show password')} onClick={() => setReveal(!reveal)}>
                                    <Icon name="eye" size={17} />
                                </button>
                            )}
                            <button class="field__action" onClick={async () => copy(r.key, await r.text())}>
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
                        </div>
                    )}
                </div>
            )}

            {entry.tags.length > 0 && (
                <div>
                    <h2 class="section-title">{t('Tags')}</h2>
                    <div class="tags" style={{ padding: 0 }}>
                        {entry.tags.map((tag) => (
                            <span class="tag">{tag}</span>
                        ))}
                    </div>
                </div>
            )}

            <Notes key={entry.id} entry={entry} />

            <Attachments key={entry.id} entry={entry} />

            <p class="detail__foot">{t('Updated {}', DateFormat.dtStr(entry.updated))}</p>
        </main>
    );
}

function Attachments({ entry }: { entry: EntryModel }) {
    const input = useRef<HTMLInputElement>(null);
    const mounted = useRef(true);
    const working = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
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
    const upload = async (attachment: File) => {
        if (working.current || !writable) {
            return;
        }
        setError('');
        if (entry.attachments.some((item) => item.title === attachment.name)) {
            setError(t('An attachment with this name already exists. Remove it before uploading a replacement.'));
            return;
        }
        working.current = true;
        setBusy(true);
        let message = t('Could not read the attachment. Try selecting the file again.');
        try {
            const data = await attachment.arrayBuffer();
            if (!mounted.current || !file.active) {
                return;
            }
            message = t('Could not save the attachment. Try again.');
            await entry.addAttachment(attachment.name, data);
            if (file.active) {
                updated();
            }
        } catch {
            if (mounted.current) {
                setError(message);
            }
        } finally {
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
            let data = attachment.getBinary();
            if (!data) {
                // getBinary does not convert an empty ArrayBuffer in older vault models.
                const stored = attachment.data as { value?: unknown } | ArrayBuffer | undefined;
                const value = stored instanceof ArrayBuffer ? stored : stored?.value;
                if (value instanceof ArrayBuffer && value.byteLength === 0) {
                    data = new Uint8Array(value);
                }
            }
            if (!data) {
                throw new Error('Missing attachment data');
            }
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
        <section class="entry-attachments" aria-label={t('Attachments')} aria-busy={busy}>
            <div class="entry-attachments__head">
                <h2 class="section-title">{t('Attachments')}</h2>
                <button class="pill" type="button" disabled={busy || !writable} onClick={() => input.current?.click()}>
                    {busy ? t('Adding attachment…') : t('Add attachment')}
                </button>
                <input ref={input} type="file" hidden aria-label={t('Attachment file')} disabled={busy || !writable}
                    onChange={(event) => {
                        const attachment = event.currentTarget.files?.[0];
                        event.currentTarget.value = '';
                        if (attachment) {
                            void upload(attachment);
                        }
                    }} />
            </div>
            {entry.attachments.length === 0 && <p class="muted">{t('No attachments')}</p>}
            {entry.attachments.map((attachment) => (
                <div class="attachment entry-attachments__row" key={attachment.title} data-attachment={attachment.title}>
                    <Icon name="paperclip" size={16} />
                    <span class="entry-attachments__name">{attachment.title}</span>
                    <button class="link" type="button" disabled={busy} onClick={() => download(attachment)}>{t('Download')}</button>
                    <button class="link" type="button" disabled={busy || !writable}
                        onClick={() => remove(attachment.title ?? '')}>{t('Remove attachment')}</button>
                </div>
            ))}
            {error && <p class="error" role="alert">{error}</p>}
        </section>
    );
}
