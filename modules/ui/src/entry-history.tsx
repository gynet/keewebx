import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ProtectedValue } from 'kdbxweb';
import { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import { Events } from 'framework/events';
import { DateFormat } from 'comp/i18n/date-format';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { getSessionAccess } from 'comp/app/session-access';
import { VaultApi } from 'comp/app/vault-api';
import { t } from './i18n';
import { hasPendingDrafts } from './pending-drafts';
import './entry-history.css';

interface Snapshot {
    model: AppModel;
    file: FileModel;
    db: FileModel['db'];
    entry: EntryModel;
    object: EntryModel['entry'];
    history: EntryModel['entry'][];
    records: EntryModel[];
    epoch: number;
    editSeq: number;
}
type Action = 'restore' | 'delete';

function unavailable(snapshot: Snapshot, write = false): string {
    const { model, file, entry } = snapshot;
    const access = getSessionAccess(model);
    if (access.state !== 'open' || !access.isCurrent(snapshot.epoch)) {
        return t('The session changed. Close and reopen History.');
    }
    if (!file.active || model.files.get(file.id) !== file || file.db !== snapshot.db
        || entry.file !== file || file.getEntry(entry.id) !== entry || entry.entry !== snapshot.object
        || file.editSeq !== snapshot.editSeq || entry.entry.history.length !== snapshot.history.length
        || entry.entry.history.some((record, index) => record !== snapshot.history[index])) {
        return t('This entry changed. Close and reopen History.');
    }
    if (write && (file as FileModel & { readOnly?: boolean }).readOnly === true) return t('This database is read-only.');
    if (write && file.syncing) return t('A save is in progress. Wait for it to finish, then try again.');
    return '';
}

function capture(entry: EntryModel): Snapshot {
    const model = AppModel.instance;
    const file = entry.file as FileModel;
    const access = getSessionAccess(model);
    access.assertOpen();
    const snapshot: Snapshot = { model, file, db: file.db, entry, object: entry.entry,
        history: [...entry.entry.history], records: [], epoch: access.epoch, editSeq: file.editSeq };
    const reason = unavailable(snapshot);
    if (reason) throw new Error(reason);
    snapshot.records = entry.getHistory();
    return snapshot;
}

const rawText = (value: unknown): string => value instanceof ProtectedValue ? value.getText() : String(value ?? '');
const isSecret = (name: string, value: unknown) => value instanceof ProtectedValue
    || /^(password|otp|totp seed|totp settings)$/i.test(name);
function fieldChange(fields: Record<string, unknown>, previous: Record<string, unknown> | undefined, name: string): string {
    if (!previous) return '';
    if (!(name in fields)) return t('Removed');
    if (!(name in previous)) return t('Added');
    if (rawText(fields[name]) !== rawText(previous[name])) return t('Changed');
    if ((fields[name] instanceof ProtectedValue) !== (previous[name] instanceof ProtectedValue)) return t('Protection changed');
    return '';
}
function binaryIdentity(value: unknown): unknown {
    if (value && typeof value === 'object' && 'hash' in value) return value.hash;
    if (value && typeof value === 'object' && 'ref' in value) return value.ref;
    return value;
}

export function EntryHistory({ entry, hasDraft, onRestore }: {
    entry: EntryModel;
    hasDraft?: boolean;
    onRestore: () => void;
}) {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [message, setMessage] = useState('');
    const trigger = useRef<HTMLButtonElement>(null);
    return <div>
        <button ref={trigger} type="button" class="pill pill--tinted" onClick={() => {
            try { setSnapshot(capture(entry)); setMessage(''); }
            catch { setMessage(t('History is unavailable. Unlock and reopen this entry.')); }
        }}>{t('History')}</button>
        {message && <p role="status">{message}</p>}
        {snapshot && <HistoryDialog snapshot={snapshot} hasDraft={hasDraft ?? hasPendingDrafts()} trigger={trigger}
            onClose={() => setSnapshot(null)} onChanged={(action) => {
                setSnapshot(null);
                if (action === 'restore') onRestore();
                setMessage(t(action === 'restore' ? 'Version restored. Check the database sync status.' : 'History version deleted. Check the database sync status.'));
            }} />}
    </div>;
}

function HistoryDialog({ snapshot, hasDraft, trigger, onClose, onChanged }: {
    snapshot: Snapshot;
    hasDraft: boolean;
    trigger: { current: HTMLButtonElement | null };
    onClose: () => void;
    onChanged: (action: Action) => void;
}) {
    const { records, entry, model } = snapshot;
    const [index, setIndex] = useState(() => Math.max(0, records.indexOf(entry)));
    const [revealed, setRevealed] = useState<string[]>([]);
    const [copied, setCopied] = useState('');
    const [error, setError] = useState('');
    const [confirmation, setConfirmation] = useState<Action | null>(null);
    const [supported, setSupported] = useState(true);
    const dialog = useRef<HTMLDialogElement>(null);
    const select = useRef<HTMLSelectElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const restoreButton = useRef<HTMLButtonElement>(null);
    const deleteButton = useRef<HTMLButtonElement>(null);
    const applied = useRef(false);
    const previousAction = useRef<Action | null>(null);
    const record = records[index];
    const previous = records[index - 1];
    const current = record === entry;
    const reason = unavailable(snapshot);
    const writeReason = unavailable(snapshot, true);
    const fields = reason ? {} : record.getAllFields();
    const previousFields = reason ? undefined : previous?.getAllFields();
    const names = [...new Set([...Object.keys(fields), ...Object.keys(previousFields ?? {})])];

    useLayoutEffect(() => {
        const element = dialog.current!;
        if (typeof element.showModal !== 'function') { setSupported(false); return; }
        element.showModal();
        select.current?.focus();
        return () => {
            element.close();
            requestAnimationFrame(() => {
                const button = trigger.current;
                if (getSessionAccess(model).state === 'open' && button?.isConnected
                    && !button.closest('[hidden], [inert]')) button.focus();
            });
        };
    }, []);
    useLayoutEffect(() => {
        if (confirmation) { previousAction.current = confirmation; cancel.current?.focus(); }
        else if (previousAction.current) {
            (previousAction.current === 'restore' ? restoreButton : deleteButton).current?.focus();
            previousAction.current = null;
        }
    }, [confirmation]);

    const choose = (next: number) => {
        if (unavailable(snapshot)) return;
        setIndex(next); setRevealed([]); setCopied(''); setError('');
    };
    const copy = async (name: string) => {
        if (unavailable(snapshot)) return;
        try {
            const text = rawText(fields[name]);
            await navigator.clipboard.writeText(text);
            // Cleanup of an authorized write must be scheduled even if it finishes after lock.
            VaultApi.copied({ text, password: name === 'Password', sessionEpoch: snapshot.epoch });
            if (unavailable(snapshot)) return;
            setCopied(name);
        } catch { if (!unavailable(snapshot)) setError(t('Could not copy. Reveal the value and copy it manually.')); }
    };
    const apply = () => {
        if (applied.current || !confirmation) return;
        const reason = unavailable(snapshot, true);
        if (reason) { setError(reason); return; }
        if (record === entry || !entry.entry.history.includes(record.entry)) {
            setError(t('This version is no longer available. Close and reopen History.')); return;
        }
        try {
            if (confirmation === 'restore') entry.revertToHistoryState(record.entry);
            else entry.deleteHistory(record.entry);
            applied.current = true;
            model.updateTags();
            Events.emit('entry-updated', { entry });
            onChanged(confirmation);
        } catch { setError(t('History could not be changed. Close this dialog and check the entry.')); }
    };
    if (!supported) return <div role="alert">
        <p>{t('This browser cannot open History. Use a browser that supports modal dialogs.')}</p>
        <button type="button" class="pill" onClick={onClose}>{t('Close History')}</button>
    </div>;

    return <dialog ref={dialog} class="entry-history" aria-label={t('Entry history')} aria-modal="true"
        onCancel={(event) => { event.preventDefault(); if (confirmation) setConfirmation(null); else onClose(); }}
        onKeyDown={(event) => { IdleTracker.regUserAction(); event.stopPropagation(); }}
        onClick={(event) => { IdleTracker.regUserAction(); event.stopPropagation(); }}>
        <div class="entry-history__actions">
            <h2>{t('Entry history')}</h2>
            <button type="button" class="pill" onClick={onClose}>{t('Close History')}</button>
        </div>
        {reason ? <p role="alert" class="error">{reason}</p> : confirmation ? <>
            <h3>{t(confirmation === 'restore' ? 'Restore this version?' : 'Delete this history version?')}</h3>
            <p>{t('Revision {} — {}', String(index + 1), DateFormat.dtStr(record.updated))}</p>
            <p>{t(confirmation === 'restore'
                ? 'This replaces the current entry. Its previous state will remain in history.'
                : 'This permanently removes the selected history version. The current entry stays unchanged.')}</p>
            {confirmation === 'restore' && hasDraft && <p>{t('Restoring also discards the unsaved changes for this entry.')}</p>}
            <div class="entry-history__actions">
                <button ref={cancel} type="button" class="pill" onClick={() => setConfirmation(null)}>{t('Cancel')}</button>
                <button type="button" class="pill pill--danger" disabled={!!writeReason || applied.current} onClick={apply}>
                    {t(confirmation === 'restore' ? 'Confirm restore' : 'Confirm delete')}
                </button>
            </div>
            {(writeReason || error) && <p role="alert" class="error">{writeReason || error}</p>}
        </> : <>
            <p>{t('History shows applied versions. Unsaved editor changes are not included.')}</p>
            {records.length === 1 && <p>{t('No earlier versions are stored.')}</p>}
            <label class="vault-form__field">{t('Version')}
                <select ref={select} class="input" value={index} onChange={(event) => choose(Number(event.currentTarget.value))}>
                    {records.map((item, position) => <option key={position} value={position}>
                        {t('Revision {} — {}', String(position + 1), DateFormat.dtStr(item.updated))}
                        {item === entry ? t(' (current applied state)') : ''}
                    </option>)}
                </select>
            </label>
            <div class="entry-history__actions">
                <button type="button" class="pill" disabled={index === 0} onClick={() => choose(index - 1)}>{t('Previous version')}</button>
                <button type="button" class="pill" disabled={index === records.length - 1} onClick={() => choose(index + 1)}>{t('Next version')}</button>
            </div>
            <p>{t(previous ? 'Changes are compared with the previous version.' : 'This is the earliest stored version.')}</p>
            <dl class="entry-history__fields">
                {names.map(name => <div key={name} class="entry-history__field" aria-label={t('History field: {}', name)}>
                    <dt>{name} {fieldChange(fields, previousFields, name) && <span class="muted">— {fieldChange(fields, previousFields, name)}</span>}</dt>
                    <dd>{!(name in fields) ? t('Not present in this version')
                        : isSecret(name, fields[name]) && !revealed.includes(name) ? '••••••••••••' : rawText(fields[name]) || t('(empty)')}</dd>
                    {name in fields && <div class="entry-history__actions">
                        {isSecret(name, fields[name]) && <button type="button" class="link" onClick={() => {
                            if (!unavailable(snapshot)) setRevealed(items => items.includes(name) ? items.filter(item => item !== name) : [...items, name]);
                        }}>{t(revealed.includes(name) ? 'Hide {}' : 'Show {}', name)}</button>}
                        <button type="button" class="link" onClick={() => void copy(name)}>{t('Copy {}', name)}</button>
                    </div>}
                </div>)}
            </dl>
            <p>{t('Tags: {}', record.tags.join(', ') || t('(none)'))}
                {previous && JSON.stringify(record.tags) !== JSON.stringify(previous.tags) && ` — ${t('Changed')}`}</p>
            <p>{t('Expires: {}', record.expires ? DateFormat.dtStr(record.expires) : t('Never'))}</p>
            <section aria-label={t('History attachments')}>
                <h3>{t('Attachments')}</h3>
                {!record.entry.binaries.size && <p>{t('No attachments in this version.')}</p>}
                <ul>{[...new Set([...record.entry.binaries.keys(), ...(previous?.entry.binaries.keys() ?? [])])].map(name => {
                    const present = record.entry.binaries.has(name);
                    const old = previous?.entry.binaries.has(name);
                    const change = !present ? t('Removed') : previous && !old ? t('Added')
                        : previous && binaryIdentity(record.entry.binaries.get(name)) !== binaryIdentity(previous.entry.binaries.get(name)) ? t('Changed') : '';
                    return <li key={name}>{name}{change ? ` — ${change}` : ''}</li>;
                })}</ul>
            </section>
            {copied && <p role="status">{t('Copied {}', copied)}</p>}
            {error && <p role="alert" class="error">{error}</p>}
            {!current && <div class="entry-history__actions">
                <button ref={restoreButton} type="button" class="pill" disabled={!!writeReason} title={writeReason || undefined}
                    onClick={() => { if (!unavailable(snapshot, true)) setConfirmation('restore'); }}>{t('Restore version')}</button>
                <button ref={deleteButton} type="button" class="pill pill--danger" disabled={!!writeReason} title={writeReason || undefined}
                    onClick={() => { if (!unavailable(snapshot, true)) setConfirmation('delete'); }}>{t('Delete version')}</button>
            </div>}
            {writeReason && <p role="status">{writeReason}</p>}
        </>}
    </dialog>;
}
